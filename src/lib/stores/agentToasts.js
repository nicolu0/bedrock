// @ts-nocheck
import { writable } from 'svelte/store';

const MAX_TOASTS = 4;
const DONE_DISMISS_MS = 2000;

const timers = new Map();
const dismissedRunIds = new Set();

const createAgentToasts = () => {
	const { subscribe, update } = writable([]);

	const dismiss = (runId) => {
		if (!runId) return;
		if (timers.has(runId)) {
			clearTimeout(timers.get(runId));
			timers.delete(runId);
		}
		update((items) => items.filter((item) => item.runId !== runId));
	};

	const dismissForever = async (runId, workspaceSlug) => {
		if (!runId) return;
		dismissedRunIds.add(runId);
		dismiss(runId);
		if (!workspaceSlug || typeof fetch === 'undefined') return;
		try {
			await fetch('/api/agent-events/dismiss', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspace: workspaceSlug, runId })
			});
		} catch {
			// ignore dismiss failures
		}
	};

	const scheduleDismiss = (runId, delayMs = DONE_DISMISS_MS) => {
		if (!runId) return;
		if (timers.has(runId)) {
			clearTimeout(timers.get(runId));
		}
		const timer = setTimeout(() => {
			timers.delete(runId);
			dismiss(runId);
		}, delayMs);
		timers.set(runId, timer);
	};

	const upsert = (event) => {
		const key = event?.run_id ?? event?.id ?? null;
		if (!key) return;
		if (event?.dismissed_at) {
			dismissedRunIds.add(key);
			dismiss(key);
			return;
		}
		if (dismissedRunIds.has(key)) return;
		const meta = event?.meta ?? {};
		const title =
			typeof event.message === 'string' && event.message.trim()
				? event.message.trim()
				: 'Agent update';
		const payload = {
			runId: key,
			title,
			issueId: event.issue_id ?? null,
			propertyName: meta.property_name ?? meta.propertyName ?? null,
			unitName: meta.unit_name ?? meta.unitName ?? null,
			stage: event.stage ?? null,
			step: Number.isFinite(event.step) ? event.step : null,
			updatedAt: Date.now()
		};
		update((items) => {
			const existingIndex = items.findIndex((item) => item.runId === payload.runId);
			if (existingIndex >= 0) {
				const next = items.slice();
				next[existingIndex] = { ...next[existingIndex], ...payload };
				return next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TOASTS);
			}
			return [payload, ...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TOASTS);
		});
		if (payload.stage === 'done' || payload.stage === 'error') {
			scheduleDismiss(payload.runId);
		}
	};

	const clear = () => {
		for (const timer of timers.values()) {
			clearTimeout(timer);
		}
		timers.clear();
		update(() => []);
	};

	return { subscribe, upsert, dismiss, dismissForever, clear };
};

export const agentToasts = createAgentToasts();
