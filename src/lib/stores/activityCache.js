// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'activity-cache-v1';
const CACHE_TTL = 5 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const activityCache = writable(initialState);

export const applyMessageDelta = (message) => {
	if (!message?.issue_id) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextMessagesByIssue = { ...data.messagesByIssue };
		const list = [...(nextMessagesByIssue[message.issue_id] ?? [])];
		const idx = list.findIndex((m) => m.id === message.id);
		if (idx >= 0) { list[idx] = { ...list[idx], ...message }; } else { list.push(message); }
		list.sort((a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0));
		nextMessagesByIssue[message.issue_id] = list;
		return { ...state, data: { ...data, messagesByIssue: nextMessagesByIssue } };
	});
};

export const applyDraftDelta = (draft) => {
	const key = draft?.message_id ?? draft?.id;
	if (!key) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextDrafts = { ...data.emailDraftsByMessageId, [key]: draft };
		const nextIssueIds = [...new Set(Object.values(nextDrafts).map((d) => d.issue_id).filter(Boolean))];
		return { ...state, data: { ...data, emailDraftsByMessageId: nextDrafts, draftIssueIds: nextIssueIds } };
	});
};

export const removeMessageFromCache = (message) => {
	if (!message?.issue_id) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextMessagesByIssue = { ...data.messagesByIssue };
		const list = (nextMessagesByIssue[message.issue_id] ?? []).filter((m) => m.id !== message.id);
		if (list.length) { nextMessagesByIssue[message.issue_id] = list; }
		else { delete nextMessagesByIssue[message.issue_id]; }
		return { ...state, data: { ...data, messagesByIssue: nextMessagesByIssue } };
	});
};

export const removeDraftFromCache = (draft) => {
	const key = draft?.message_id ?? draft?.id;
	if (!key) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextDrafts = { ...data.emailDraftsByMessageId };
		delete nextDrafts[key];
		const nextIssueIds = [...new Set(Object.values(nextDrafts).map((d) => d.issue_id).filter(Boolean))];
		return { ...state, data: { ...data, emailDraftsByMessageId: nextDrafts, draftIssueIds: nextIssueIds } };
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

export const ensureActivityCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;
	const force = Boolean(options.force);

	if (isHardReload()) {
		clearSessionCache();
	}

	const now = Date.now();
	let currentState;
	activityCache.update((state) => {
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
	const sessionMessages = sessionCached?.data?.messagesByIssue
		? Object.keys(sessionCached.data.messagesByIssue).length
		: 0;
	const sessionDrafts = sessionCached?.data?.emailDraftsByMessageId
		? Object.keys(sessionCached.data.emailDraftsByMessageId).length
		: 0;
	const sessionValid = sessionMessages > 0 || sessionDrafts > 0;
	if (
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid &&
		!force
	) {
		activityCache.set({
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

	activityCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/activity-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Activity cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			const nextMessages = data?.messagesByIssue ? Object.keys(data.messagesByIssue).length : 0;
			const nextDrafts = data?.emailDraftsByMessageId
				? Object.keys(data.emailDraftsByMessageId).length
				: 0;
			const shouldOverwrite = nextMessages > 0 || nextDrafts > 0;
			if (shouldOverwrite) {
				activityCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				return data;
			}
			activityCache.update((state) => ({
				...state,
				loading: false,
				error: null
			}));
			return currentState?.data;
		} catch (error) {
			activityCache.set({
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
