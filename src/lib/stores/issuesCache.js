// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'issues-cache-v1';
const CACHE_TTL = 5 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const issuesCache = writable(initialState);

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

export const ensureIssuesCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;
	console.log('[issues-cache] ensure start', { workspaceSlug });

	const now = Date.now();
	let currentState;
	issuesCache.update((state) => {
		currentState = state;
		return state;
	});

	if (
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL
	) {
		console.log('[issues-cache] cache hit', { workspaceSlug });
		return currentState.data;
	}

	const sessionCached = readSessionCache();
	const sessionSections = sessionCached?.data?.sections?.length ?? 0;
	const sessionIssues = sessionCached?.data?.issues?.length ?? 0;
	const sessionValid = sessionSections > 0 || sessionIssues > 0;
	if (
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid
	) {
		console.log('[issues-cache] session hit', { workspaceSlug });
		issuesCache.set({
			workspace: workspaceSlug,
			data: sessionCached.data,
			loading: false,
			error: null,
			fetchedAt: sessionCached.fetchedAt
		});
		console.log('[issues-cache] session stored', {
			workspaceSlug,
			fetchedAt: sessionCached.fetchedAt,
			sections: sessionSections,
			issues: sessionIssues
		});
		return sessionCached.data;
	}
	if (sessionCached && !sessionValid) {
		console.log('[issues-cache] session invalid, clearing', { workspaceSlug });
		clearSessionCache();
	}

	if (inFlight) return inFlight;

	issuesCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			console.log('[issues-cache] fetch', { workspaceSlug });
			const response = await fetcher(`/api/issues-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Issues cache fetch failed');
			}
			const data = await response.json();
			console.log('[issues-cache] fetch data', data);
			console.log('[issues-cache] fetch ok', { workspaceSlug, keys: Object.keys(data ?? {}) });
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			const nextSections = data?.sections?.length ?? 0;
			const nextIssues = data?.issues?.length ?? 0;
			const shouldOverwrite = nextSections > 0 || nextIssues > 0;
			if (shouldOverwrite) {
				issuesCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				console.log('[issues-cache] stored', {
					workspaceSlug,
					fetchedAt: payload.fetchedAt,
					sections: nextSections,
					issues: nextIssues
				});
				return data;
			}
			issuesCache.update((state) => ({
				...state,
				loading: false,
				error: null
			}));
			console.log('[issues-cache] fetch empty, keeping existing', {
				workspaceSlug,
				sections: nextSections,
				issues: nextIssues
			});
			return currentState?.data;
		} catch (error) {
			console.log('[issues-cache] fetch error', { workspaceSlug, error });
			issuesCache.set({
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

export const primeIssuesCache = (workspaceSlug, data) => {
	if (!browser) return;
	if (!workspaceSlug || !data) return;
	const payload = {
		workspace: workspaceSlug,
		data,
		fetchedAt: Date.now()
	};
	issuesCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: payload.fetchedAt
	});
	console.log('[issues-cache] primed', {
		workspaceSlug,
		fetchedAt: payload.fetchedAt,
		sections: data?.sections?.length ?? 0
	});
	writeSessionCache(payload);
};
