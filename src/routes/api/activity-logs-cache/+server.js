// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const ACTIVITY_WINDOW_DAYS = 30;

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

	let issuesQuery = supabaseAdmin.from('issues').select('id').eq('workspace_id', workspace.id);
	if (isAssigneeScoped) {
		issuesQuery = issuesQuery.eq('assignee_id', locals.user.id);
	}
	if (isOwnerScoped) {
		issuesQuery = ownerUnitIds.length
			? issuesQuery.in('unit_id', ownerUnitIds)
			: issuesQuery.eq('id', '__none__');
	}
	const { data: issues } = await issuesQuery;
	const issueIds = (issues ?? []).map((issue) => issue.id).filter(Boolean);
	if (!issueIds.length) {
		return json({ logsByIssue: {} });
	}

	const cutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const { data: logs } = await supabaseAdmin
		.from('activity_logs')
		.select(
			'id, issue_id, workspace_id, type, from_email, to_emails, subject, body, data, created_by, created_at'
		)
		.eq('workspace_id', workspace.id)
		.in('issue_id', issueIds)
		.gte('created_at', cutoff)
		.order('created_at', { ascending: true });

	const logsByIssue = (logs ?? []).reduce((acc, log) => {
		if (!log.issue_id) return acc;
		if (!acc[log.issue_id]) acc[log.issue_id] = [];
		acc[log.issue_id].push(log);
		return acc;
	}, {});

	return json({ logsByIssue });
};
