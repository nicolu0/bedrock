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
		return json({ messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] });
	}

	const cutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const [messagesResult, draftsResult] = await Promise.all([
		supabaseAdmin
			.from('messages')
			.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
			.in('issue_id', issueIds)
			.gte('timestamp', cutoff)
			.order('timestamp', { ascending: true }),
		supabaseAdmin
			.from('email_drafts')
			.select('id, issue_id, message_id, sender_email, recipient_email, subject, body, updated_at')
			.in('issue_id', issueIds)
			.gte('updated_at', cutoff)
			.order('updated_at', { ascending: false })
	]);

	const messagesByIssue = (messagesResult?.data ?? []).reduce((acc, message) => {
		if (!message.issue_id) return acc;
		if (!acc[message.issue_id]) acc[message.issue_id] = [];
		acc[message.issue_id].push(message);
		return acc;
	}, {});

	const emailDraftsByMessageId = (draftsResult?.data ?? []).reduce((acc, draft) => {
		const key = draft.message_id ?? draft.id;
		if (!key || acc[key]) return acc;
		acc[key] = draft;
		return acc;
	}, {});

	const draftIssueIds = [
		...new Set((draftsResult?.data ?? []).map((draft) => draft.issue_id).filter(Boolean))
	];

	return json({ messagesByIssue, emailDraftsByMessageId, draftIssueIds });
};
