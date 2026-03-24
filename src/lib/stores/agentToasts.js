// @ts-nocheck
import { writable } from 'svelte/store';

const MAX_TOASTS = 4;
const DONE_DISMISS_MS = 2000;

const timers = new Map();

const createAgentToasts = () => {
	const { subscribe, update } = writable([]);

	const scheduleDismiss = (runId, delayMs = DONE_DISMISS_MS) => {
		if (!runId) return;
		if (timers.has(runId)) {
			clearTimeout(timers.get(runId));
		}
		const timer = setTimeout(() => {
			timers.delete(runId);
			update((items) => items.filter((item) => item.runId !== runId));
		}, delayMs);
		timers.set(runId, timer);
	};

	const upsert = (event) => {
		const key = event?.run_id ?? event?.id ?? null;
		if (!key) return;
		const title =
			typeof event.message === 'string' && event.message.trim()
				? event.message.trim()
				: 'Agent update';
		const payload = {
			runId: key,
			title,
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

	return { subscribe, upsert, clear };
};

export const agentToasts = createAgentToasts();
