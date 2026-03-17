// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'notifications-cache-v1';
const CACHE_TTL = 5 * 60 * 1000;

const initialState = { workspace: null, data: null, loading: false, error: null, fetchedAt: 0 };

export const notificationsCache = writable(initialState);

let inFlight = null;

const isHardReload = () => {
	if (!browser || !globalThis.performance) return false;
	try {
		const [entry] = performance.getEntriesByType('navigation') ?? [];
		return entry?.type === 'reload';
	} catch { return false; }
};

const readSessionCache = () => {
	if (!browser) return null;
	try {
		const raw = sessionStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed?.fetchedAt ? parsed : null;
	} catch { return null; }
};

const writeSessionCache = (payload) => {
	if (!browser) return;
	try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch {}
};

export const ensureNotificationsCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug || !browser) return null;
	const force = options.force ?? false;
	const fetcher = options.fetch ?? fetch;

	if (isHardReload()) {
		try { sessionStorage.removeItem(CACHE_KEY); } catch {}
	}

	const now = Date.now();
	let currentState;
	notificationsCache.update((s) => { currentState = s; return s; });

	// Memory cache still valid — skip everything
	if (
		!force &&
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL
	) return currentState.data;

	// sessionStorage hit — hydrate store (no network)
	const cached = readSessionCache();
	if (
		!force &&
		cached?.data &&
		cached.workspace === workspaceSlug &&
		now - cached.fetchedAt < CACHE_TTL
	) {
		notificationsCache.set({
			workspace: workspaceSlug,
			data: cached.data,
			loading: false,
			error: null,
			fetchedAt: cached.fetchedAt
		});
		return cached.data;
	}

	// Deduplicate concurrent fetches
	if (inFlight) return inFlight;

	notificationsCache.update((s) => ({ ...s, loading: true }));

	inFlight = (async () => {
		try {
			const res = await fetcher(`/api/notifications-cache?workspace=${workspaceSlug}`);
			if (!res.ok) throw new Error('Notifications cache fetch failed');
			const data = await res.json();
			if (data?.notifications) {
				const fetchedAt = Date.now();
				notificationsCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt
				});
				writeSessionCache({ workspace: workspaceSlug, data, fetchedAt });
				return data;
			}
			notificationsCache.update((s) => ({ ...s, loading: false }));
			return currentState?.data ?? null;
		} catch (err) {
			notificationsCache.update((s) => ({ ...s, loading: false, error: err }));
			return null;
		} finally {
			inFlight = null;
		}
	})();

	return inFlight;
};

export const primeNotificationsCache = (workspaceSlug, data, fetchedAt = Date.now()) => {
	if (!browser || !workspaceSlug || !data) return;
	notificationsCache.update((current) => {
		if (fetchedAt < current.fetchedAt) return current; // reject stale write
		const payload = { workspace: workspaceSlug, data, fetchedAt };
		writeSessionCache(payload);
		return { workspace: workspaceSlug, data, loading: false, error: null, fetchedAt };
	});
};

export const updateNotificationInCache = (notification) => {
	notificationsCache.update((state) => {
		if (!state.data?.notifications) return state;
		const notifications = state.data.notifications.map((n) =>
			n.id === notification.id ? { ...n, ...notification } : n
		);
		const newState = { ...state, data: { ...state.data, notifications } };
		writeSessionCache({ workspace: newState.workspace, data: newState.data, fetchedAt: newState.fetchedAt });
		return newState;
	});
};
