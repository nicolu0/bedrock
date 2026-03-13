// @ts-nocheck
import { writable } from 'svelte/store';

const statusConfig = {
	in_progress: {
		id: 'in-progress',
		label: 'In Progress',
		statusClass: 'border-amber-500 text-amber-600'
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

const statusOrder = ['in_progress', 'todo', 'done'];

const normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
		return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return statusOrder.includes(normalized) ? normalized : 'todo';
};

const buildSectionsFromIssues = (issues = []) => {
	const normalizedIssues = (issues ?? []).map((issue) => ({
		...issue,
		status: normalizeStatus(issue.status)
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
				property: subIssue.property,
				unit: subIssue.unit,
				issueNumber: subIssue.issueNumber ?? subIssue.issue_number ?? null,
				readableId: subIssue.readableId ?? subIssue.readable_id ?? null,
				assignees: subIssue.assignees ?? 0,
				assigneeId: subIssue.assigneeId ?? subIssue.assignee_id ?? null,
				assignee_id: subIssue.assignee_id ?? subIssue.assigneeId ?? null
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId ?? issue.id,
			title: issue.title ?? issue.name,
			assignees: issue.assignees ?? 0,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
			readableId: issue.readableId ?? issue.readable_id ?? null,
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
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber ?? issue.issue_number ?? null,
			readableId: issue.readableId ?? issue.readable_id ?? null,
			parentTitle: parent.title ?? parent.name,
			isSubIssue: true,
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

export const issuesCache = writable(initialState);

export const primeIssuesCache = (workspaceSlug, data) => {
	if (!workspaceSlug || !data) return;
	issuesCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: Date.now()
	});
};

export const applyIssueInsert = (
	rawIssue,
	{ unitName = 'Unknown', propertyName = 'Unknown', parentTitle = '' } = {}
) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
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
			unit: unitName,
			issueNumber: rawIssue.issue_number ?? null,
			readableId: rawIssue.readable_id ?? null,
			status,
			parentId: rawIssue.parent_id ?? null,
			parent_id: rawIssue.parent_id ?? null
		};
		const issues = [...(state.data.issues ?? []), normalizedIssue];
		const sections = buildSectionsFromIssues(issues);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const applyIssueDelete = (issueId) => {
	issuesCache.update((state) => {
		if (!state.data) return state;
		const issues = (state.data.issues ?? []).filter((i) => i.id !== issueId);
		const sections = buildSectionsFromIssues(issues);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const updateIssueStatusInListCache = (issueId, newStatus) => {
	issuesCache.update((state) => {
		if (!state.data?.issues) return state;
		const issues = (state.data.issues ?? []).map((issue) =>
			issue.id === issueId ? { ...issue, status: newStatus } : issue
		);
		const sections = buildSectionsFromIssues(issues);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};

export const updateIssueFieldsInListCache = (issueId, fields) => {
	issuesCache.update((state) => {
		if (!state.data?.issues) return state;
		const issues = (state.data.issues ?? []).map((i) =>
			i.id === issueId ? { ...i, ...fields, title: fields.name ?? i.title } : i
		);
		const sections = buildSectionsFromIssues(issues);
		return { ...state, data: { ...state.data, issues, sections } };
	});
};
