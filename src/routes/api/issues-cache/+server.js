// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const statusConfig = {
	in_progress: {
		id: 'in-progress',
		label: 'In Progress',
		statusClass: 'border-amber-300 text-amber-600'
	},
	todo: {
		id: 'todo',
		label: 'Todo',
		statusClass: 'border-neutral-300 text-neutral-600'
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

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('workspace_id', workspace.id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	let role = member?.role ? String(member.role).toLowerCase() : null;
	const ownerPersonId = member?.id ?? null;
	if (!role) {
		const { data: adminWorkspace } = await supabaseAdmin
			.from('workspaces')
			.select('admin_user_id')
			.eq('id', workspace.id)
			.maybeSingle();
		if (adminWorkspace?.admin_user_id === locals.user.id) {
			role = 'admin';
		}
	}
	if (!role) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const isAssigneeScoped = role === 'member' || role === 'vendor';
	const isOwnerScoped = role === 'owner';
	let ownerUnitIds = [];
	if (isOwnerScoped && ownerPersonId) {
		const { data: ownerUnits } = await supabaseAdmin
			.from('units')
			.select('id, properties!inner(id, workspace_id, owner_id)')
			.eq('properties.workspace_id', workspace.id)
			.eq('properties.owner_id', ownerPersonId);
		ownerUnitIds = Array.from(new Set((ownerUnits ?? []).map((unit) => unit.id).filter(Boolean)));
	}

	const buildIssuesQuery = () => {
		let query = supabaseAdmin
			.from('issues')
			.select(
				'id, name, description, status, parent_id, unit_id, issue_number, readable_id, assignee_id'
			)
			.eq('workspace_id', workspace.id)
			.order('updated_at', { ascending: false });
		if (isAssigneeScoped) {
			query = query.eq('assignee_id', locals.user.id);
		}
		if (isOwnerScoped) {
			query = ownerUnitIds.length ? query.in('unit_id', ownerUnitIds) : query.eq('id', '__none__');
		}
		return query;
	};

	let { data: issues } = await buildIssuesQuery();

	if (!issues?.length) {
		const { data: fallbackUnits } = await supabaseAdmin
			.from('units')
			.select('id, properties!inner(workspace_id)')
			.eq('properties.workspace_id', workspace.id);
		const fallbackUnitIds = Array.from(
			new Set((fallbackUnits ?? []).map((unit) => unit.id).filter(Boolean))
		);
		if (fallbackUnitIds.length) {
			let fallbackQuery = supabaseAdmin
				.from('issues')
				.select(
					'id, name, description, status, parent_id, unit_id, issue_number, readable_id, assignee_id'
				)
				.in('unit_id', fallbackUnitIds)
				.order('updated_at', { ascending: false });
			if (isAssigneeScoped) {
				fallbackQuery = fallbackQuery.eq('assignee_id', locals.user.id);
			}
			if (isOwnerScoped) {
				fallbackQuery = ownerUnitIds.length
					? fallbackQuery.in('unit_id', ownerUnitIds)
					: fallbackQuery.eq('id', '__none__');
			}
			const { data: fallbackIssues } = await fallbackQuery;
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

	const normalizedIssues = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const property = unit ? propertyMap.get(unit.property_id) : null;
		const status = normalizeStatus(issue.status);
		return {
			id: issue.id,
			issueId: issue.id,
			title: issue.name,
			name: issue.name,
			description: issue.description ?? '',
			assignees: 0,
			assigneeId: issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? null,
			property: property?.name ?? 'Unknown',
			unit: unit?.name ?? 'Unknown',
			issueNumber: issue.issue_number ?? null,
			readableId: issue.readable_id ?? null,
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
				issueNumber: subIssue.issueNumber,
				readableId: subIssue.readableId,
				assignees: subIssue.assignees,
				assigneeId: subIssue.assigneeId ?? subIssue.assignee_id ?? null,
				assignee_id: subIssue.assignee_id ?? subIssue.assigneeId ?? null
			}));
		bucket.items.push({
			id: issue.id,
			issueId: issue.issueId,
			title: issue.title,
			assignees: issue.assignees,
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
			subIssues
		});
	}

	for (const issue of normalizedIssues) {
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
			assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
			property: issue.property,
			unit: issue.unit,
			issueNumber: issue.issueNumber,
			readableId: issue.readableId,
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
