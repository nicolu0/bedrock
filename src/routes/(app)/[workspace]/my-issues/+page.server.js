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

const loadSections = async (workspaceId) => {
	const { data: issues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id, unit_id')
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

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
		const status = allowedStatuses.has(issue.status) ? issue.status : 'todo';
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

	const sections = statusOrder.map((status) => {
		const config = statusConfig[status] ?? {
			id: status,
			label: status,
			statusClass: 'border-neutral-500 text-neutral-600'
		};
		const items = topLevelIssues
			.filter((issue) => (issue.status ?? 'todo') === status)
			.map((issue) => {
				const subIssues = (childrenByParent.get(issue.id) ?? []).map((subIssue) => ({
					id: subIssue.id,
					issueId: subIssue.issueId,
					title: subIssue.title,
					parentTitle: issue.title,
					property: subIssue.property,
					unit: subIssue.unit,
					assignees: subIssue.assignees
				}));
				return {
					id: issue.id,
					issueId: issue.issueId,
					title: issue.title,
					assignees: issue.assignees,
					property: issue.property,
					unit: issue.unit,
					subIssues
				};
			});
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

	const parentData = await parent();
	const workspaceId = parentData?.workspace?.id ?? null;
	if (!workspaceId) {
		return { sections: [] };
	}

	const sections = await loadSections(workspaceId);
	return { sections };
};
