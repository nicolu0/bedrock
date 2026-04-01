// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { primeDetailCacheFromIssuesList } from './issueDetailCache.js';

const CACHE_KEY = 'issues-cache-v4';
const CACHE_TTL = 5 * 60 * 1000;

const statusConfig = {
	in_progress: {
		id: 'in-progress',
		label: 'In Progress',
		statusClass: 'border-orange-500 text-orange-600'
	},
	todo: {
		id: 'todo',
		label: 'Todo',
		statusClass: 'border-neutral-500 text-neutral-700'
	},
	done: {
		id: 'done',
		label: 'Done',
		statusClass: 'border-emerald-500 text-emerald-700'
	}
};

const statusOrder = ['todo', 'in_progress', 'done'];

const normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
		return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return statusOrder.includes(normalized) ? normalized : 'todo';
};

const getIssueLatestTimestamp = (issue) => {
	if (!issue) return 0;
	const value = issue.latestActivityAt ?? issue.updated_at ?? issue.updatedAt ?? null;
	if (!value) return 0;
	const ts = new Date(value).getTime();
	return Number.isFinite(ts) ? ts : 0;
};

const computeIssueHasUnseenUpdates = (issue, issueReadsById) => {
	if (!issueReadsById) return false;
	const latest = getIssueLatestTimestamp(issue);
	if (!latest) return false;
	const lastSeenRaw = issueReadsById[issue?.id] ?? null;
	const lastSeen = lastSeenRaw ? new Date(lastSeenRaw).getTime() : 0;
	return latest > (Number.isFinite(lastSeen) ? lastSeen : 0);
};

const applyIssueReadsToIssues = (issues = [], issueReadsById) => {
	if (!issueReadsById) return issues;
	return (issues ?? []).map((issue) => ({
		...issue,
		hasUnseenUpdates: computeIssueHasUnseenUpdates(issue, issueReadsById)
	}));
};

export const buildSectionsFromIssues = (issues = [], issueReadsById = null) => {
	const normalizedIssues = (issues ?? []).map((issue) => ({
		...issue,
		status: normalizeStatus(issue.status),
		hasUnseenUpdates: computeIssueHasUnseenUpdates(issue, issueReadsById)
	}));
	const issuesById = new Map(normalizedIssues.map((issue) => [issue.id ?? issue.issueId, issue]));
	const childrenByParent = new Map();
	for (const issue of normalizedIssues) {
		const parentId = issue.parentId ?? issue.parent_id ?? null;
		if (!parentId) continue;
		if (!childrenByParent.has(parentId)) {
			childrenByParent.set(parentId, []);
		}
		childrenByParent.get(parentId).push(issue);
	}

	const topLevelIssues = normalizedIssues.filter((issue) => {
		const parentId = issue.parentId ?? issue.parent_id ?? null;
		return !parentId || !issuesById.has(parentId);
	});

	const sectionBuckets = new Map(
		statusOrder.map((status) => [status, { config: statusConfig[status], items: [] }])
	);

	for (const issue of topLevelIssues) {
		const status = issue.status ?? 'todo';
		const bucket = sectionBuckets.get(status);
		if (!bucket) continue;
		const issueId = issue.id ?? issue.issueId;
		const subIssues = (childrenByParent.get(issueId) ?? [])
			.filter((child) => (child.status ?? 'todo') === status)
			.map((subIssue) => ({
				id: subIssue.id,
				issueId: subIssue.issueId ?? subIssue.id,
				title: subIssue.title ?? subIssue.name,
				parentTitle: issue.title ?? issue.name,
				parentId: issue.id ?? issue.issueId,
				parent_id: issue.id ?? issue.issueId,
				urgent: subIssue.urgent ?? false,
				root_urgent: issue.urgent ?? false,
				property: subIssue.property,
				unit: subIssue.unit,
				issueNumber: subIssue.issueNumber ?? subIssue.issue_number ?? null,
				readableId: subIssue.readableId ?? subIssue.readable_id ?? null,
				assignees: subIssue.assignees ?? 0,
				assigneeId: subIssue.assigneeId ?? subIssue.assignee_id ?? null,
				assignee_id: subIssue.assignee_id ?? subIssue.assigneeId ?? null,
				hasUnseenUpdates: computeIssueHasUnseenUpdates(subIssue, issueReadsById)
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId ?? issue.id,
			title: issue.title ?? issue.name,
			assignees: issue.assignees ?? 0,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			urgent: issue.urgent ?? false,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
			readableId: issue.readableId ?? issue.readable_id ?? null,
			hasUnseenUpdates: computeIssueHasUnseenUpdates(issue, issueReadsById),
			subIssues
		});
	}

	for (const issue of normalizedIssues) {
		const parentId = issue.parentId ?? issue.parent_id ?? null;
		if (!parentId) continue;
		const parent = issuesById.get(parentId);
		if (!parent) continue;
		if ((parent.status ?? 'todo') === (issue.status ?? 'todo')) continue;
		const bucket = sectionBuckets.get(issue.status ?? 'todo');
		if (!bucket) continue;
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId ?? issue.id,
			title: issue.title ?? issue.name,
			assignees: issue.assignees ?? 0,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			urgent: issue.urgent ?? false,
			parentId: parent.id ?? parent.issueId,
			parent_id: parent.id ?? parent.issueId,
			root_urgent: parent.urgent ?? false,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
			readableId: issue.readableId ?? issue.readable_id ?? null,
			parentTitle: parent.title ?? parent.name,
			isSubIssue: true,
			hasUnseenUpdates: computeIssueHasUnseenUpdates(issue, issueReadsById),
			subIssues: []
		});
	}

	return statusOrder
		.map((status) => {
			const bucket = sectionBuckets.get(status);
			const config = bucket?.config ?? statusConfig[status];
			const items = bucket?.items ?? [];
			return {
				id: config.id,
				label: config.label,
				count: items.length,
				statusClass: config.statusClass,
				items
			};
		})
		.filter((section) => section.count > 0);
};

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

const normalizeIssueReads = (value) => {
	if (!value) return {};
	if (!Array.isArray(value)) return value ?? {};
	return value.reduce((acc, row) => {
		if (!row?.issue_id) return acc;
		acc[row.issue_id] = row.last_seen_at ?? null;
		return acc;
	}, {});
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
		return inFlight;
	}
	if (force && inFlight) {
		console.log('[RT] issuesCache: force fetch bypassing inFlight');
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
			console.log('[RT] issuesCache: fetching (force:', force, ')');
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
			if (!shouldOverwrite) {
			}
			if (shouldOverwrite) {
				console.log(
					'[RT] issuesCache: fetch complete, sections:',
					nextSections,
					'issues:',
					nextIssues
				);
				primeIssuesCache(workspaceSlug, data, payload.fetchedAt);
				return data;
			}
			issuesCache.update((state) => ({
				...state,
				loading: false,
				error: null
			}));
			return currentState?.data;
		} catch (error) {
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

export const primeIssuesCache = (workspaceSlug, data, fetchedAt = Date.now()) => {
	if (!browser || !workspaceSlug || !data) return;
	issuesCache.update((current) => {
		if (fetchedAt < current.fetchedAt) return current; // reject stale write
		const incomingReadsUserId = data.issueReadsUserId ?? null;
		const incomingReadsById = incomingReadsUserId
			? (data.issueReadsById ?? normalizeIssueReads(data.issueReads))
			: null;
		const fallbackReadsUserId = current.data?.issueReadsUserId ?? null;
		const fallbackReadsById = current.data?.issueReadsById ?? null;
		const issueReadsUserId = incomingReadsUserId || fallbackReadsUserId;
		const issueReadsById = incomingReadsById || fallbackReadsById;
		const normalizedIssues = applyIssueReadsToIssues(data.issues ?? [], issueReadsById);
		const sections = buildSectionsFromIssues(normalizedIssues, issueReadsById);
		const payload = {
			workspace: workspaceSlug,
			data: {
				...data,
				issues: normalizedIssues,
				sections,
				issueReadsById,
				issueReadsUserId
			},
			fetchedAt
		};
		writeSessionCache(payload);
		primeDetailCacheFromIssuesList(normalizedIssues);
		return {
			workspace: workspaceSlug,
			data: payload.data,
			loading: false,
			error: null,
			fetchedAt
		};
	});
};

export const updateIssueReadsInCache = (workspaceSlug, userId, issueReads) => {
	if (!browser || !workspaceSlug || !userId) return;
	const normalized = normalizeIssueReads(issueReads);
	issuesCache.update((state) => {
		if (!state.data || state.workspace !== workspaceSlug) return state;
		const existingUserId = state.data.issueReadsUserId ?? null;
		if (existingUserId && existingUserId !== userId) return state;
		const issueReadsById = { ...(state.data.issueReadsById ?? {}), ...normalized };
		const normalizedIssues = applyIssueReadsToIssues(state.data.issues ?? [], issueReadsById);
		const sections = buildSectionsFromIssues(normalizedIssues, issueReadsById);
		const nextData = {
			...state.data,
			issues: normalizedIssues,
			sections,
			issueReadsById,
			issueReadsUserId: userId
		};
		writeSessionCache({ workspace: workspaceSlug, data: nextData, fetchedAt: state.fetchedAt });
		return { ...state, data: nextData };
	});
};

export const applyIssueInsert = (
	rawIssue,
	{ unitName = 'Unknown', propertyName = 'Unknown', parentTitle = '' } = {}
) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
		// Idempotency guard
		if ((state.data.issues ?? []).some((i) => i.id === rawIssue.id)) return state;

		const status = normalizeStatus(rawIssue.status);
		const normalizedIssue = {
			id: rawIssue.id,
			issueId: rawIssue.id,
			title: rawIssue.name,
			name: rawIssue.name,
			description: '',
			assignees: 0,
			assigneeId: rawIssue.assignee_id ?? null,
			assignee_id: rawIssue.assignee_id ?? null,
			property: propertyName,
			propertyId: rawIssue.property_id ?? null,
			property_id: rawIssue.property_id ?? null,
			unit: unitName,
			issueNumber: rawIssue.issue_number ?? null,
			readableId: rawIssue.readable_id ?? null,
			status,
			parentId: rawIssue.parent_id ?? null,
			parent_id: rawIssue.parent_id ?? null
		};
		const issues = [...(state.data.issues ?? []), normalizedIssue];
		const sections = buildSectionsFromIssues(issues, state.data.issueReadsById ?? null);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const applyIssueDelete = (issueId) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
		const issues = (state.data.issues ?? []).filter((i) => i.id !== issueId);
		const sections = buildSectionsFromIssues(issues, state.data.issueReadsById ?? null);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const updateIssueStatusInListCache = (issueId, newStatus) => {
	issuesCache.update((state) => {
		if (!state.data?.issues) return state;
		const issues = (state.data.issues ?? []).map((issue) =>
			issue.id === issueId ? { ...issue, status: newStatus } : issue
		);
		const sections = buildSectionsFromIssues(issues, state.data.issueReadsById ?? null);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const updateIssueFieldsInListCache = (issueId, fields) => {
	issuesCache.update((state) => {
		if (!state.data?.issues) return state;
		const issues = (state.data.issues ?? []).map((i) =>
			i.id === issueId ? { ...i, ...fields, title: fields.name ?? i.title } : i
		);
		const sections = buildSectionsFromIssues(issues, state.data.issueReadsById ?? null);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};
