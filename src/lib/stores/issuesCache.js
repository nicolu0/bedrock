// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { primeDetailCacheFromIssuesList } from './issueDetailCache.js';

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

const isHardReload = () => {
	if (!browser || !globalThis.performance) return false;
	try {
		const [entry] = performance.getEntriesByType('navigation') ?? [];
		return entry?.type === 'reload';
	} catch {
		return false;
	}
};

export const ensureIssuesCache = async (workspaceSlug, options = {}) => {
	if (!workspaceSlug) return null;
	if (!browser) return null;
	const fetcher = options.fetch ?? fetch;
	const force = options.force ?? false;

	console.log('[issuesCache] ensureIssuesCache called', { workspaceSlug, force });

	if (isHardReload()) {
		clearSessionCache();
	}

	const now = Date.now();
	let currentState;
	issuesCache.update((state) => {
		currentState = state;
		return state;
	});

	if (
		!force &&
		currentState?.data &&
		currentState.workspace === workspaceSlug &&
		now - currentState.fetchedAt < CACHE_TTL
	) {
		console.log('[issuesCache] returning from in-memory cache (TTL valid)', { issueCount: currentState.data?.issues?.length });
		return currentState.data;
	}

	const sessionCached = readSessionCache();
	const sessionSections = sessionCached?.data?.sections?.length ?? 0;
	const sessionIssues = sessionCached?.data?.issues?.length ?? 0;
	const sessionValid = sessionSections > 0 || sessionIssues > 0;
	if (
		!force &&
		sessionCached?.data &&
		sessionCached.workspace === workspaceSlug &&
		now - sessionCached.fetchedAt < CACHE_TTL &&
		sessionValid
	) {
		console.log('[issuesCache] returning from sessionStorage cache', { issueCount: sessionCached.data?.issues?.length });
		issuesCache.set({
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
		console.log('[issuesCache] reusing in-flight request');
		return inFlight;
	}
	if (force && inFlight) {
		console.log('[issuesCache] force=true, ignoring in-flight and starting fresh fetch');
	}

	issuesCache.set({
		workspace: workspaceSlug,
		data: currentState?.data ?? null,
		loading: true,
		error: null,
		fetchedAt: currentState?.fetchedAt ?? 0
	});

	inFlight = (async () => {
		try {
			const response = await fetcher(`/api/issues-cache?workspace=${workspaceSlug}`);
			if (!response.ok) {
				throw new Error('Issues cache fetch failed');
			}
			const data = await response.json();
			const payload = {
				workspace: workspaceSlug,
				data,
				fetchedAt: Date.now()
			};
			const nextSections = data?.sections?.length ?? 0;
			const nextIssues = data?.issues?.length ?? 0;
			const shouldOverwrite = nextSections > 0 || nextIssues > 0;
			console.log('[issuesCache] fetch complete', { force, nextSections, nextIssues, shouldOverwrite, workspace: workspaceSlug });
			if (!shouldOverwrite) {
				console.warn('[issuesCache] shouldOverwrite=false — API returned empty data', { force, workspaceSlug });
			}
			if (shouldOverwrite) {
				issuesCache.set({
					workspace: workspaceSlug,
					data,
					loading: false,
					error: null,
					fetchedAt: payload.fetchedAt
				});
				writeSessionCache(payload);
				primeDetailCacheFromIssuesList(data.issues);
				return data;
			}
			issuesCache.update((state) => ({
				...state,
				loading: false,
				error: null
			}));
			return currentState?.data;
		} catch (error) {
			console.error('[issuesCache] fetch error', { force, error });
			issuesCache.update((state) => ({
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
	writeSessionCache(payload);
};

export const applyIssueInsert = (rawIssue, { unitName = 'Unknown', propertyName = 'Unknown', parentTitle = '' } = {}) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
		// Idempotency guard
		if ((state.data.issues ?? []).some((i) => i.id === rawIssue.id)) return state;

		const status = rawIssue.status ?? 'todo';
		const normalizedIssue = {
			id: rawIssue.id, issueId: rawIssue.id,
			title: rawIssue.name, name: rawIssue.name,
			description: '', assignees: 0,
			property: propertyName, unit: unitName,
			status, parentId: rawIssue.parent_id ?? null, parent_id: rawIssue.parent_id ?? null
		};
		const issues = [...(state.data.issues ?? []), normalizedIssue];

		let sections = state.data.sections;
		if (rawIssue.parent_id) {
			// Subissue: splice into parent's subIssues in the appropriate section item
			const subItem = {
				id: rawIssue.id, issueId: rawIssue.id, title: rawIssue.name,
				parentTitle, property: propertyName, unit: unitName, assignees: 0
			};
			sections = sections.map((section) => ({
				...section,
				items: section.items.map((item) =>
					item.issueId === rawIssue.parent_id
						? { ...item, subIssues: [...(item.subIssues ?? []), subItem] }
						: item
				)
			}));
		} else {
			// Root issue: add to the matching status section (create section if not yet present)
			const sectionId = status === 'in_progress' ? 'in-progress' : status;
			const newItem = {
				id: rawIssue.id, issueId: rawIssue.id, title: rawIssue.name,
				assignees: 0, property: propertyName, unit: unitName, subIssues: []
			};
			const sectionExists = sections.some((s) => s.id === sectionId);
			if (sectionExists) {
				sections = sections.map((s) =>
					s.id === sectionId ? { ...s, items: [...s.items, newItem], count: s.count + 1 } : s
				);
			} else {
				const sectionMeta = {
					in_progress: { id: 'in-progress', label: 'In Progress', statusClass: 'border-amber-500 text-amber-600' },
					todo:        { id: 'todo',        label: 'Todo',         statusClass: 'border-neutral-500 text-neutral-700' },
					done:        { id: 'done',        label: 'Done',         statusClass: 'border-emerald-500 text-emerald-700' }
				};
				const newSection = { ...sectionMeta[status], count: 1, items: [newItem] };
				const ordered = ['in_progress', 'todo', 'done'].map((s) => {
					const id = s === 'in_progress' ? 'in-progress' : s;
					return sections.find((sec) => sec.id === id) ?? (s === status ? newSection : null);
				}).filter(Boolean);
				sections = ordered;
			}
		}
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const applyIssueDelete = (issueId) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
		const issues = (state.data.issues ?? []).filter((i) => i.id !== issueId);
		const sections = state.data.sections
			.map((section) => {
				const items = section.items
					.filter((item) => item.issueId !== issueId)
					.map((item) => ({ ...item, subIssues: (item.subIssues ?? []).filter((s) => s.issueId !== issueId) }));
				return { ...section, items, count: items.length };
			})
			.filter((s) => s.count > 0);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const updateIssueStatusInListCache = (issueId, newStatus) => {
	issuesCache.update((state) => {
		if (!state.data?.sections) return state;
		const sections = state.data.sections.map((section) => ({
			...section,
			items: section.items.map((item) => {
				if (item.issueId === issueId) return { ...item, status: newStatus };
				return {
					...item,
					subIssues: (item.subIssues ?? []).map((s) =>
						s.issueId === issueId ? { ...s, status: newStatus } : s
					)
				};
			})
		}));
		return { ...state, data: { ...state.data, sections } };
	});
};

export const updateIssueFieldsInListCache = (issueId, fields) => {
	issuesCache.update((state) => {
		if (!state.data?.sections) return state;
		const issues = (state.data.issues ?? []).map((i) =>
			i.id === issueId ? { ...i, ...fields, title: fields.name ?? i.title } : i
		);
		const sections = state.data.sections.map((section) => ({
			...section,
			items: section.items.map((item) => {
				if (item.issueId === issueId) return { ...item, ...fields, title: fields.name ?? item.title };
				return {
					...item,
					subIssues: (item.subIssues ?? []).map((s) =>
						s.issueId === issueId ? { ...s, ...fields, title: fields.name ?? s.title } : s
					)
				};
			})
		}));
		return { ...state, data: { ...state.data, issues, sections } };
	});
};
