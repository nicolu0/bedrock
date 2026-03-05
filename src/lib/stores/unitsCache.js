// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CACHE_KEY = 'units-cache-v1';
const CACHE_TTL = 10 * 60 * 1000;

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const unitsCache = writable(initialState);

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

const sortByName = (items) =>
	(items ?? []).slice().sort((a, b) => (a?.name ?? '').localeCompare(b?.name ?? ''));

export const primeUnitsCache = (workspaceSlug, list) => {
	if (!browser) return;
	if (!workspaceSlug) return;
	if (isHardReload()) {
		clearSessionCache();
	}
	const data = Array.isArray(list) ? sortByName(list) : [];
	const payload = { workspace: workspaceSlug, data, fetchedAt: Date.now() };
	writeSessionCache(payload);
	unitsCache.set({ ...initialState, ...payload });
};

export const mergeUnitsIntoCache = (workspaceSlug, serverList) => {
	if (!browser) return;
	if (!workspaceSlug || !Array.isArray(serverList)) return;
	unitsCache.update((state) => {
		const nextWorkspace = workspaceSlug ?? state.workspace;
		const existing = Array.isArray(state.data) ? state.data : [];
		const map = new Map();
		const noIdExisting = [];
		const noIdServer = [];
		existing.forEach((unit) => {
			if (!unit) return;
			if (unit.id) {
				map.set(unit.id, unit);
			} else {
				noIdExisting.push(unit);
			}
		});
		serverList.forEach((unit) => {
			if (!unit) return;
			if (unit.id) {
				if (!map.has(unit.id)) {
					map.set(unit.id, unit);
				}
			} else {
				noIdServer.push(unit);
			}
		});
		const data = sortByName([...map.values(), ...noIdExisting, ...noIdServer]);
		const payload = { workspace: nextWorkspace, data, fetchedAt: Date.now() };
		writeSessionCache(payload);
		return { ...state, workspace: nextWorkspace, data, fetchedAt: payload.fetchedAt };
	});
};

export const addUnitToCache = (unit) => {
	if (!browser || !unit) return;
	unitsCache.update((state) => {
		const existing = Array.isArray(state.data) ? state.data : [];
		const data = sortByName([...existing, unit]);
		const payload = { workspace: state.workspace, data, fetchedAt: state.fetchedAt };
		writeSessionCache(payload);
		return { ...state, data };
	});
};

export const updateUnitInCache = (unit) => {
	if (!browser || !unit) return;
	unitsCache.update((state) => {
		const existing = Array.isArray(state.data) ? state.data : [];
		let replaced = false;
		const data = existing.map((item) => {
			if (item?.id && unit?.id && item.id === unit.id) {
				replaced = true;
				return { ...item, ...unit };
			}
			return item;
		});
		if (!replaced) data.push(unit);
		const sorted = sortByName(data);
		const payload = { workspace: state.workspace, data: sorted, fetchedAt: state.fetchedAt };
		writeSessionCache(payload);
		return { ...state, data: sorted };
	});
};

export const removeUnitFromCache = (unitId) => {
	if (!browser || !unitId) return;
	unitsCache.update((state) => {
		const existing = Array.isArray(state.data) ? state.data : [];
		const data = existing.filter((item) => item?.id !== unitId);
		const payload = { workspace: state.workspace, data, fetchedAt: state.fetchedAt };
		writeSessionCache(payload);
		return { ...state, data };
	});
};

if (browser) {
	const cached = readSessionCache();
	if (cached?.data && cached?.workspace && Date.now() - cached.fetchedAt < CACHE_TTL) {
		unitsCache.set({ ...initialState, ...cached });
	}
}
