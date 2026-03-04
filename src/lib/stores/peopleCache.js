// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'people-cache-v1';
const CACHE_TTL = 10 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const peopleCache = writable(initialState);

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

export const ensurePeopleCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;

	const now = Date.now();
	let currentState;
	peopleCache.update((state) => {
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
		peopleCache.set({
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

	peopleCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/people?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('People cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			if (Array.isArray(data)) {
				peopleCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				return data;
			}
			peopleCache.update((state) => ({ ...state, loading: false, error: null }));
			return currentState?.data;
		} catch (error) {
			peopleCache.set({
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

export const primePeopleCache = (workspaceSlug, data) => {
	if (!browser) return;
	if (!workspaceSlug || !Array.isArray(data)) return;
	const payload = {
		workspace: workspaceSlug,
		data,
		fetchedAt: Date.now()
	};
	peopleCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: payload.fetchedAt
	});
	writeSessionCache(payload);
};

export const addPersonToCache = (person, workspaceSlug) => {
	if (!browser) return;
	peopleCache.update((state) => {
		const nextWorkspace = workspaceSlug ?? state.workspace;
		const existing = Array.isArray(state.data) ? state.data : [];
		const data = [...existing, person].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
		const fetchedAt = state.fetchedAt || Date.now();
		const payload = { workspace: nextWorkspace, data, fetchedAt };
		writeSessionCache(payload);
		return { ...state, workspace: nextWorkspace, data, fetchedAt };
	});
};

export const updatePersonInCache = (person) => {
	if (!browser) return;
	peopleCache.update((state) => {
		if (!Array.isArray(state.data)) return state;
		const data = state.data
			.map((p) => (p.id === person.id ? person : p))
			.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
		const payload = { workspace: state.workspace, data, fetchedAt: state.fetchedAt };
		writeSessionCache(payload);
		return { ...state, data };
	});
};

export const removePersonFromCache = (personId) => {
	if (!browser) return;
	peopleCache.update((state) => {
		if (!Array.isArray(state.data)) return state;
		const data = state.data.filter((p) => p.id !== personId);
		const payload = { workspace: state.workspace, data, fetchedAt: state.fetchedAt };
		writeSessionCache(payload);
		return { ...state, data };
	});
};
