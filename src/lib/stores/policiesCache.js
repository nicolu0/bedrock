// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'policies-cache-v1';
const CACHE_TTL = 5 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const policiesCache = writable(initialState);

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

export const ensurePoliciesCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;
	const force = options.force ?? false;

	if (isHardReload()) {
		clearSessionCache();
	}

	const now = Date.now();
	let currentState;
	policiesCache.update((state) => {
		currentState = state;
		return state;
	});

	if (
		!force &&
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL
	) {
		return currentState.data;
	}

	const sessionCached = readSessionCache();
	const sessionPolicies = sessionCached?.data?.policies?.length ?? 0;
	const sessionValid = sessionPolicies >= 0;
	if (
		!force &&
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid
	) {
		policiesCache.set({
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

	if (!force && inFlight) {
		return inFlight;
	}

	policiesCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/policies-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Policies cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			primePoliciesCache(workspaceSlug, data, payload.fetchedAt);
			return data;
		} catch (error) {
			policiesCache.update((state) => ({
				...state,
				loading: false,
				error
			}));
			return null;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
};

export const primePoliciesCache = (workspaceSlug, data, fetchedAt = Date.now()) => {
	if (!browser || !workspaceSlug || !data) return;
	policiesCache.update((current) => {
		if (fetchedAt < current.fetchedAt) return current;
		const payload = { workspace: workspaceSlug, data, fetchedAt };
		writeSessionCache(payload);
		return { workspace: workspaceSlug, data, loading: false, error: null, fetchedAt };
	});
};

export const applyPolicyInsert = (policy) => {
	if (!policy?.id) return;
	policiesCache.update((state) => {
		if (!state.data) return state;
		const existing = state.data.policies ?? [];
		if (existing.some((p) => p.id === policy.id)) return state;
		return {
			...state,
			data: { ...state.data, policies: [policy, ...existing] }
		};
	});
};
