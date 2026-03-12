// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
import { ensureWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}
	const [, { data: adminWorkspace }] = await Promise.all([
		ensureWorkspace(locals.supabase, locals.user),
		supabaseAdmin
			.from('workspaces')
			.select('id, name, slug, admin_user_id')
			.eq('slug', params.workspace)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle()
	]);
	if (adminWorkspace?.slug) {
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			adminWorkspace.id,
			'admin',
			locals.user.id
		);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, adminWorkspace.id);
		const issuesData = loadIssuesData(adminWorkspace.id, locals.user.id);
		const notificationsData = loadNotificationsData(adminWorkspace.id, locals.user.id);
		const activityData = loadActivityData(adminWorkspace.id);
		const activityLogsData = loadActivityLogsData(adminWorkspace.id);
		return { workspace: adminWorkspace, properties, units, issuesData, notificationsData, activityData, activityLogsData, userId: locals.user.id };
	}
	const { data: memberWorkspace } = await supabaseAdmin
		.from('people')
		.select('role, workspaces:workspaces(id, name, slug)')
		.eq('user_id', locals.user.id)
		.eq('workspaces.slug', params.workspace)
		.maybeSingle();
	if (memberWorkspace?.workspaces?.slug) {
		let ownerPersonId = null;
		if (memberWorkspace.role === 'owner') {
			const { data: ownerPerson } = await supabaseAdmin
				.from('people')
				.select('id')
				.eq('workspace_id', memberWorkspace.workspaces.id)
				.eq('user_id', locals.user.id)
				.eq('role', 'owner')
				.maybeSingle();
			ownerPersonId = ownerPerson?.id ?? null;
		}
		const properties =
			memberWorkspace.role === 'owner' && !ownerPersonId
				? Promise.resolve([])
				: loadPropertiesList(
						locals.supabase,
						supabaseAdmin,
						memberWorkspace.workspaces.id,
						memberWorkspace.role,
						ownerPersonId ?? locals.user.id
					);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, memberWorkspace.workspaces.id);
		const issuesData = loadIssuesData(memberWorkspace.workspaces.id, locals.user.id);
		const notificationsData = loadNotificationsData(memberWorkspace.workspaces.id, locals.user.id);
		const activityData = loadActivityData(memberWorkspace.workspaces.id);
		const activityLogsData = loadActivityLogsData(memberWorkspace.workspaces.id);
		return { workspace: memberWorkspace.workspaces, properties, units, issuesData, notificationsData, activityData, activityLogsData, userId: locals.user.id };
	}
	// Check if the workspace slug exists at all
	const { data: existingWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('slug')
		.eq('slug', params.workspace)
		.maybeSingle();
	if (!existingWorkspace) {
		throw error(404, "This workspace doesn't exist.");
	}
	throw error(403, "You don't have access to this workspace.");
};
const addPropertyCounts = async (adminClient, properties) => {
	if (!Array.isArray(properties) || properties.length === 0) return properties ?? [];
	const propertyIds = properties.map((property) => property.id).filter(Boolean);
	if (propertyIds.length === 0) return properties;

	const { data: units } = await adminClient
		.from('units')
		.select('id, property_id')
		.in('property_id', propertyIds);

	const unitCounts = new Map();
	const unitToProperty = new Map();
	for (const unit of units ?? []) {
		if (!unit?.property_id || !unit?.id) continue;
		unitToProperty.set(unit.id, unit.property_id);
		unitCounts.set(unit.property_id, (unitCounts.get(unit.property_id) ?? 0) + 1);
	}

	const unitIds = Array.from(unitToProperty.keys());
	const issueCounts = new Map();
	if (unitIds.length) {
		const { data: issues } = await adminClient
			.from('issues')
			.select('id, unit_id')
			.in('unit_id', unitIds);
		for (const issue of issues ?? []) {
			const propertyId = unitToProperty.get(issue?.unit_id);
			if (!propertyId) continue;
			issueCounts.set(propertyId, (issueCounts.get(propertyId) ?? 0) + 1);
		}
	}

	return properties.map((property) => ({
		...property,
		unit_count: unitCounts.get(property.id) ?? 0,
		issue_count: issueCounts.get(property.id) ?? 0
	}));
};

const loadPropertiesList = async (supabase, adminClient, workspaceId, userRole, userId) => {
	const buildQuery = (client) => {
		let q = client
			.from('properties')
			.select('id, name, address, city, state, postal_code, country, owner_id')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true });
		if (userRole === 'owner') {
			q = q.eq('owner_id', userId);
		}
		return q;
	};
	const { data: properties, error: propertiesError } = await buildQuery(supabase);
	if (!propertiesError) return addPropertyCounts(adminClient, properties ?? []);
	const { data: adminProperties } = await buildQuery(adminClient);
	return addPropertyCounts(adminClient, adminProperties ?? []);
};

const _issuesStatusConfig = {
	in_progress: { id: 'in-progress', label: 'In Progress', statusClass: 'border-amber-500 text-amber-600' },
	todo: { id: 'todo', label: 'Todo', statusClass: 'border-neutral-500 text-neutral-700' },
	done: { id: 'done', label: 'Done', statusClass: 'border-emerald-500 text-emerald-700' }
};
const _issuesStatusOrder = ['in_progress', 'todo', 'done'];
const _allowedStatuses = new Set(_issuesStatusOrder);
const _normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete') return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return _allowedStatuses.has(normalized) ? normalized : 'todo';
};

const loadIssuesData = async (workspaceId, userId) => {
	let { data: issues } = await supabaseAdmin
		.from('issues')
		.select('id, name, description, status, parent_id, unit_id, issue_number, readable_id, assignee_id')
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	if (!issues?.length) {
		const { data: fallbackUnits } = await supabaseAdmin
			.from('units')
			.select('id, properties!inner(workspace_id)')
			.eq('properties.workspace_id', workspaceId);
		const fallbackUnitIds = Array.from(new Set((fallbackUnits ?? []).map((u) => u.id).filter(Boolean)));
		if (fallbackUnitIds.length) {
			const { data: fallbackIssues } = await supabaseAdmin
				.from('issues')
				.select('id, name, description, status, parent_id, unit_id, issue_number, readable_id, assignee_id')
				.in('unit_id', fallbackUnitIds)
				.order('updated_at', { ascending: false });
			issues = fallbackIssues ?? [];
		}
	}

	const unitIds = Array.from(new Set((issues ?? []).map((i) => i.unit_id).filter(Boolean)));
	const { data: units } = unitIds.length
		? await supabaseAdmin.from('units').select('id, name, property_id').in('id', unitIds)
		: { data: [] };
	const unitMap = new Map((units ?? []).map((u) => [u.id, u]));

	const propertyIds = Array.from(new Set((units ?? []).map((u) => u.property_id).filter(Boolean)));
	const { data: properties } = propertyIds.length
		? await supabaseAdmin.from('properties').select('id, name').in('id', propertyIds)
		: { data: [] };
	const propertyMap = new Map((properties ?? []).map((p) => [p.id, p]));

	const normalizedIssues = (issues ?? []).map((issue) => {
		const unit = unitMap.get(issue.unit_id);
		const property = unit ? propertyMap.get(unit.property_id) : null;
		const status = _normalizeStatus(issue.status);
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

	const issuesById = new Map(normalizedIssues.map((i) => [i.id, i]));
	const childrenByParent = new Map();
	for (const issue of normalizedIssues) {
		if (!issue.parentId) continue;
		if (!childrenByParent.has(issue.parentId)) childrenByParent.set(issue.parentId, []);
		childrenByParent.get(issue.parentId).push(issue);
	}

	const topLevelIssues = normalizedIssues.filter((i) => !i.parentId || !issuesById.has(i.parentId));

	const sectionBuckets = new Map(
		_issuesStatusOrder.map((status) => {
			const config = _issuesStatusConfig[status] ?? { id: status, label: status, statusClass: 'border-neutral-500 text-neutral-600' };
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

	const sections = _issuesStatusOrder.map((status) => {
		const bucket = sectionBuckets.get(status);
		const config = bucket?.config ?? _issuesStatusConfig[status];
		const items = bucket?.items ?? [];
		return { id: config.id, label: config.label, count: items.length, statusClass: config.statusClass, items };
	});

	const filteredSections = sections.filter((s) => s.count > 0);

	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', userId)
		.maybeSingle();

	return { sections: filteredSections, issues: normalizedIssues, assignee, workspaceId };
};

const loadActivityData = async (workspaceId) => {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const [messagesResult, draftsResult] = await Promise.all([
		supabaseAdmin.from('messages')
			.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
			.eq('workspace_id', workspaceId)
			.gte('timestamp', cutoff)
			.order('timestamp', { ascending: true }),
		supabaseAdmin.from('email_drafts')
			.select('id, issue_id, message_id, sender_email, recipient_email, subject, body, updated_at')
			.eq('workspace_id', workspaceId)
			.gte('updated_at', cutoff)
			.order('updated_at', { ascending: false })
	]);
	const messagesByIssue = (messagesResult?.data ?? []).reduce((acc, m) => {
		if (!m.issue_id) return acc;
		(acc[m.issue_id] ??= []).push(m);
		return acc;
	}, {});
	const emailDraftsByMessageId = (draftsResult?.data ?? []).reduce((acc, d) => {
		const key = d.message_id ?? d.id;
		if (key && !acc[key]) acc[key] = d;
		return acc;
	}, {});
	const draftIssueIds = [...new Set((draftsResult?.data ?? []).map(d => d.issue_id).filter(Boolean))];
	return { messagesByIssue, emailDraftsByMessageId, draftIssueIds };
};

const loadActivityLogsData = async (workspaceId) => {
	const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const { data: logs } = await supabaseAdmin.from('activity_logs')
		.select('id, issue_id, workspace_id, type, from_email, to_emails, subject, body, data, created_by, created_at')
		.eq('workspace_id', workspaceId)
		.gte('created_at', cutoff)
		.order('created_at', { ascending: true });
	const logsByIssue = (logs ?? []).reduce((acc, log) => {
		if (!log.issue_id) return acc;
		(acc[log.issue_id] ??= []).push(log);
		return acc;
	}, {});
	return { logsByIssue };
};

const loadNotificationsData = async (workspaceId, userId) => {
	const [{ data: notifications }, { data: members }] = await Promise.all([
		supabaseAdmin
			.from('notifications')
			.select(
				`id, title, body, is_read, is_resolved, created_at, type, meta, requires_action,
        issues(id, name, status, issue_number, readable_id, units(name, properties(name)))`
			)
			.eq('workspace_id', workspaceId)
			.eq('user_id', userId)
			.order('created_at', { ascending: false }),
		supabaseAdmin
			.from('people')
			.select('user_id, users(name)')
			.eq('workspace_id', workspaceId)
			.in('role', ['admin', 'member', 'owner'])
	]);
	return { notifications: notifications ?? [], members: members ?? [] };
};

const loadUnitsList = async (supabase, adminClient, workspaceId) => {
	const { data: units, error: unitsError } = await supabase
		.from('units')
		.select(
			'id, name, property_id, tenants(id, name, email, unit_id), properties!inner(workspace_id)'
		)
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!unitsError) {
		return (units ?? []).map((unit) => ({
			id: unit.id,
			name: unit.name,
			tenant: (unit.tenants ?? [])[0] ?? null,
			property_id: unit.property_id
		}));
	}
	const { data: adminUnits } = await adminClient
		.from('units')
		.select(
			'id, name, property_id, tenants(id, name, email, unit_id), properties!inner(workspace_id)'
		)
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	return (adminUnits ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		tenant: (unit.tenants ?? [])[0] ?? null,
		property_id: unit.property_id
	}));
};
