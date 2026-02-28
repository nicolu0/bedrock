// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'members-cache-v1';
const CACHE_TTL = 10 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const membersCache = writable(initialState);

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

export const ensureMembersCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;

	const now = Date.now();
	let currentState;
	membersCache.update((state) => {
		currentState = state;
		return state;
	});

	if (
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL
	) {
		return currentState.data;
	}

	const sessionCached = readSessionCache();
	const sessionValid = Array.isArray(sessionCached?.data);
	if (
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid
	) {
		membersCache.set({
			workspace: workspaceSlug,
			data: sessionCached.data,
			loading: false,
			error: null,
			fetchedAt: sessionCached.fetchedAt
		});
		return sessionCached.data;
	}
	if (sessionCached && !sessionValid) {
		clearSessionCache();
	}

	if (inFlight) return inFlight;

	membersCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/members-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Members cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			if (Array.isArray(data)) {
				membersCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				return data;
			}
			membersCache.update((state) => ({ ...state, loading: false, error: null }));
			return currentState?.data;
		} catch (error) {
			membersCache.set({
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

export const primeMembersCache = (workspaceSlug, data) => {
	if (!browser) return;
	if (!workspaceSlug || !Array.isArray(data)) return;
	const payload = {
		workspace: workspaceSlug,
		data,
		fetchedAt: Date.now()
	};
	membersCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: payload.fetchedAt
	});
	writeSessionCache(payload);
};
