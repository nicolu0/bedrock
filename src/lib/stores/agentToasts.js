// @ts-nocheck
import { writable } from 'svelte/store';

const MAX_TOASTS = 4;
const AUTO_DISMISS_MS = 8000;

const timers = new Map();

const createAgentToasts = () => {
	const { subscribe, update } = writable([]);

	const scheduleDismiss = (runId) => {
		if (!runId) return;
		if (timers.has(runId)) {
			clearTimeout(timers.get(runId));
		}
		const timer = setTimeout(() => {
			timers.delete(runId);
			update((items) => items.filter((item) => item.runId !== runId));
		}, AUTO_DISMISS_MS);
		timers.set(runId, timer);
	};

	const upsert = (event) => {
		if (!event?.run_id) return;
		const title =
			typeof event.message === 'string' && event.message.trim()
				? event.message.trim()
				: 'Agent update';
		const payload = {
			runId: event.run_id,
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
		scheduleDismiss(payload.runId);
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
