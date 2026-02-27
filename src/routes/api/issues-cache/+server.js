// @ts-nocheck
import { json } from '@sveltejs/kit';
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

const resolveWorkspace = async (workspaceSlug, userId) => {
	if (!workspaceSlug) return null;
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, slug')
		.eq('slug', workspaceSlug)
		.eq('admin_user_id', userId)
		.maybeSingle();
	if (adminWorkspace?.id) return adminWorkspace;
	const { data: memberWorkspace } = await supabaseAdmin
		.from('members')
		.select('workspaces:workspaces(id, slug)')
		.eq('user_id', userId)
		.eq('workspaces.slug', workspaceSlug)
		.maybeSingle();
	return memberWorkspace?.workspaces ?? null;
};

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: issues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id, unit_id, description')
		.eq('workspace_id', workspace.id)
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

	const normalizedIssues = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const property = unit ? propertyMap.get(unit.property_id) : null;
		const status = allowedStatuses.has(issue.status) ? issue.status : 'todo';
		return {
			id: issue.id,
			issueId: issue.id,
			title: issue.name,
			name: issue.name,
			description: issue.description ?? '',
			assignees: 0,
			property: property?.name ?? 'Unknown',
			unit: unit?.name ?? 'Unknown',
			status,
			parentId: issue.parent_id ?? null,
			parent_id: issue.parent_id ?? null
		};
	});

	const issuesById = new Map(normalizedIssues.map((issue) => [issue.id, issue]));
	const childrenByParent = new Map();
	for (const issue of normalizedIssues) {
		if (!issue.parentId) continue;
		if (!childrenByParent.has(issue.parentId)) {
			childrenByParent.set(issue.parentId, []);
		}
		childrenByParent.get(issue.parentId).push(issue);
	}

	const topLevelIssues = normalizedIssues.filter(
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

	const filteredSections = sections.filter((section) => section.count > 0);

	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', locals.user.id)
		.maybeSingle();

	return json({
		sections: filteredSections,
		issues: normalizedIssues,
		assignee,
		workspaceId: workspace.id
	});
};
