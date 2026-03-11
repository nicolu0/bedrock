// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

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
const allowedStatuses = new Set(statusOrder);

const normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
		return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return allowedStatuses.has(normalized) ? normalized : 'todo';
};

const loadSections = async (workspaceId) => {
	let { data: issues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id, unit_id')
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	if (!issues?.length) {
		const { data: fallbackUnits } = await supabaseAdmin
			.from('units')
			.select('id, properties!inner(workspace_id)')
			.eq('properties.workspace_id', workspaceId);
		const fallbackUnitIds = Array.from(
			new Set((fallbackUnits ?? []).map((unit) => unit.id).filter(Boolean))
		);
		if (fallbackUnitIds.length) {
			const { data: fallbackIssues } = await supabaseAdmin
				.from('issues')
				.select('id, name, status, parent_id, unit_id')
				.in('unit_id', fallbackUnitIds)
				.order('updated_at', { ascending: false });
			issues = fallbackIssues ?? [];
		}
	}

	const unitIds = Array.from(new Set((issues ?? []).map((issue) => issue.unit_id).filter(Boolean)));
	const { data: units } = unitIds.length
		? await supabaseAdmin.from('units').select('id, name, property_id').in('id', unitIds)
		: { data: [] };
	const unitMap = new Map((units ?? []).map((unit) => [unit.id, unit]));

	const propertyIds = Array.from(
		new Set((units ?? []).map((unit) => unit.property_id).filter(Boolean))
	);
	const { data: properties } = propertyIds.length
		? await supabaseAdmin.from('properties').select('id, name').in('id', propertyIds)
		: { data: [] };
	const propertyMap = new Map((properties ?? []).map((property) => [property.id, property]));

	const normalized = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const property = unit ? propertyMap.get(unit.property_id) : null;
		const status = normalizeStatus(issue.status);
		return {
			id: issue.id,
			issueId: issue.id,
			title: issue.name,
			assignees: 0,
			property: property?.name ?? 'Unknown',
			unit: unit?.name ?? 'Unknown',
			status,
			parentId: issue.parent_id ?? null
		};
	});

	const issuesById = new Map(normalized.map((issue) => [issue.id, issue]));
	const childrenByParent = new Map();
	for (const issue of normalized) {
		if (!issue.parentId) continue;
		if (!childrenByParent.has(issue.parentId)) {
			childrenByParent.set(issue.parentId, []);
		}
		childrenByParent.get(issue.parentId).push(issue);
	}

	const topLevelIssues = normalized.filter(
		(issue) => !issue.parentId || !issuesById.has(issue.parentId)
	);

	const sectionBuckets = new Map(
		statusOrder.map((status) => {
			const config = statusConfig[status] ?? {
				id: status,
				label: status,
				statusClass: 'border-neutral-500 text-neutral-600'
			};
			return [status, { config, items: [] }];
		})
	);

	for (const issue of topLevelIssues) {
		const status = issue.status ?? 'todo';
		const bucket = sectionBuckets.get(status);
		if (!bucket) continue;
		const subIssues = (childrenByParent.get(issue.id) ?? [])
			.filter((child) => (child.status ?? 'todo') === status)
			.map((subIssue) => ({
				id: subIssue.id,
				issueId: subIssue.issueId,
				title: subIssue.title,
				parentTitle: issue.title,
				property: subIssue.property,
				unit: subIssue.unit,
				assignees: subIssue.assignees
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId,
			title: issue.title,
			assignees: issue.assignees,
			property: issue.property,
			unit: issue.unit,
			subIssues
		});
	}

	for (const issue of normalized) {
		if (!issue.parentId) continue;
		const parent = issuesById.get(issue.parentId);
		if (!parent) continue;
		if ((parent.status ?? 'todo') === (issue.status ?? 'todo')) continue;
		const bucket = sectionBuckets.get(issue.status ?? 'todo');
		if (!bucket) continue;
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId,
			title: issue.title,
			assignees: issue.assignees,
			property: issue.property,
			unit: issue.unit,
			parentTitle: parent.title,
			isSubIssue: true,
			subIssues: []
		});
	}

	const sections = statusOrder.map((status) => {
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
	});

	return sections.filter((section) => section.count > 0);
};

export const load = async ({ locals, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}

	const sections = (async () => {
		const { workspace } = await parent();
		if (!workspace?.id) return [];
		return await loadSections(workspace.id);
	})();

	return { sections }; // streamed — navigation doesn't wait
};
