// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { loadIssuesData } from '$lib/server/loaders';

const slugify = (value) => {
	if (!value) return '';
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '');
};

export const load = async ({ parent, params, depends }) => {
	depends('app:issues');

	const parentData = await parent();
	const { workspace, userId, role, ownerPersonId } = parentData;

	// Resolve properties from parent (may be a streaming promise)
	const propertiesList = parentData.properties instanceof Promise
		? await parentData.properties
		: (parentData.properties ?? []);

	const propertySlug = params.property;
	const property = (Array.isArray(propertiesList) ? propertiesList : []).find(
		(p) => slugify(p.name) === propertySlug
	);

	if (!property?.id) {
		return { property: null, sections: [] };
	}

	// Load issues for this workspace, then filter to this property's units
	const issuesData = await loadIssuesData(workspace.id, userId, role, ownerPersonId);
	const propertyIssues = (issuesData.issues ?? []).filter(
		(issue) => slugify(issue.property) === propertySlug
	);

	// Rebuild sections from filtered issues
	const statusConfig = {
		in_progress: {
			id: 'in-progress',
			label: 'In Progress',
			statusClass: 'border-amber-500 text-amber-600'
		},
		todo: { id: 'todo', label: 'Todo', statusClass: 'border-neutral-500 text-neutral-700' },
		done: { id: 'done', label: 'Done', statusClass: 'border-emerald-500 text-emerald-700' }
	};
	const statusOrder = ['in_progress', 'todo', 'done'];

	const issuesById = new Map(propertyIssues.map((i) => [i.id, i]));
	const childrenByParent = new Map();
	for (const issue of propertyIssues) {
		const parentId = issue.parentId ?? issue.parent_id ?? null;
		if (!parentId) continue;
		if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
		childrenByParent.get(parentId).push(issue);
	}
	const topLevel = propertyIssues.filter((i) => {
		const parentId = i.parentId ?? i.parent_id ?? null;
		return !parentId || !issuesById.has(parentId);
	});

	const buckets = new Map(statusOrder.map((s) => [s, { config: statusConfig[s], items: [] }]));
	for (const issue of topLevel) {
		const status = issue.status ?? 'todo';
		const bucket = buckets.get(status);
		if (!bucket) continue;
		const subIssues = (childrenByParent.get(issue.id) ?? [])
			.filter((c) => (c.status ?? 'todo') === status)
			.map((s) => ({
				id: s.id,
				issueId: s.issueId ?? s.id,
				title: s.title ?? s.name,
				parentTitle: issue.title ?? issue.name,
				property: s.property,
				unit: s.unit,
				issueNumber: s.issueNumber,
				readableId: s.readableId,
				assignees: 0
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId ?? issue.id,
			title: issue.title ?? issue.name,
			assignees: 0,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
			subIssues
		});
	}
	for (const issue of propertyIssues) {
		const parentId = issue.parentId ?? issue.parent_id ?? null;
		if (!parentId) continue;
		const parent = issuesById.get(parentId);
		if (!parent) continue;
		if ((parent.status ?? 'todo') === (issue.status ?? 'todo')) continue;
		const bucket = buckets.get(issue.status ?? 'todo');
		if (!bucket) continue;
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId ?? issue.id,
			title: issue.title ?? issue.name,
			assignees: 0,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
			parentTitle: parent.title ?? parent.name,
			isSubIssue: true,
			subIssues: []
		});
	}

	const sections = statusOrder
		.map((status) => {
			const bucket = buckets.get(status);
			const config = bucket?.config ?? statusConfig[status];
			const items = bucket?.items ?? [];
			return { id: config.id, label: config.label, count: items.length, statusClass: config.statusClass, items };
		})
		.filter((s) => s.count > 0);

	return { property, sections };
};
