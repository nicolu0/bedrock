// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'activity-logs-cache-v1';
const CACHE_TTL = 5 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const activityLogsCache = writable(initialState);

export const applyActivityLogDelta = (log) => {
	if (!log?.issue_id) return;
	activityLogsCache.update((state) => {
		const data = state.data ?? { logsByIssue: {} };
		const nextLogsByIssue = { ...data.logsByIssue };
		const list = [...(nextLogsByIssue[log.issue_id] ?? [])];
		const idx = list.findIndex((l) => l.id === log.id);
		if (idx >= 0) { list[idx] = { ...list[idx], ...log }; } else { list.push(log); }
		list.sort((a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0));
		nextLogsByIssue[log.issue_id] = list;
		return { ...state, data: { ...data, logsByIssue: nextLogsByIssue } };
	});
};

export const removeActivityLogFromCache = (log) => {
	if (!log?.issue_id) return;
	activityLogsCache.update((state) => {
		const data = state.data ?? { logsByIssue: {} };
		const nextLogsByIssue = { ...data.logsByIssue };
		const list = (nextLogsByIssue[log.issue_id] ?? []).filter((l) => l.id !== log.id);
		if (list.length) { nextLogsByIssue[log.issue_id] = list; }
		else { delete nextLogsByIssue[log.issue_id]; }
		return { ...state, data: { ...data, logsByIssue: nextLogsByIssue } };
	});
};

let inFlight = null;

const readSessionCache = () => {
	if (!browser) return null;
	try {
		const raw = sessionStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || !parsed.fetchedAt) return null;
		return parsed;
	} catch {
		return null;
	}
};

const writeSessionCache = (payload) => {
	if (!browser) return;
	try {
		sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
	} catch {
		// ignore write failures
	}
};

const clearSessionCache = () => {
	if (!browser) return;
	try {
		sessionStorage.removeItem(CACHE_KEY);
	} catch {
		// ignore remove failures
	}
};

const isHardReload = () => {
	if (!browser || !globalThis.performance) return false;
	try {
		const [entry] = performance.getEntriesByType('navigation') ?? [];
		return entry?.type === 'reload';
	} catch {
		return false;
	}
};

export const ensureActivityLogsCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;
	const force = Boolean(options.force);

	if (isHardReload()) {
		clearSessionCache();
	}

	const now = Date.now();
	let currentState;
	activityLogsCache.update((state) => {
		currentState = state;
		return state;
	});

	if (
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL &&
		!force
	) {
		return currentState.data;
	}

	const sessionCached = readSessionCache();
	const sessionLogs = sessionCached?.data?.logsByIssue
		? Object.keys(sessionCached.data.logsByIssue).length
		: 0;
	const sessionValid = sessionLogs > 0;
	if (
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid &&
		!force
	) {
		activityLogsCache.set({
			workspace: workspaceSlug,
			data: sessionCached.data,
			loading: false,
			error: null,
			fetchedAt: sessionCached.fetchedAt
		});
		return sessionCached.data;
	}
	if (force) {
		clearSessionCache();
	}
	if (sessionCached && !sessionValid) {
		clearSessionCache();
	}

	if (inFlight) return inFlight;

	activityLogsCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/activity-logs-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Activity logs cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			const nextLogs = data?.logsByIssue ? Object.keys(data.logsByIssue).length : 0;
			const shouldOverwrite = nextLogs > 0;
			if (shouldOverwrite) {
				activityLogsCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				return data;
			}
			activityLogsCache.update((state) => ({
				...state,
				loading: false,
				error: null
			}));
			return currentState?.data;
		} catch (error) {
			activityLogsCache.set({
				workspace: workspaceSlug,
				data: null,
				loading: false,
				error,
				fetchedAt: 0
			});
			return null;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
};
