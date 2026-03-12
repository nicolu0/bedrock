// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const ACTIVITY_LOG_WINDOW_MS = 60 * 60 * 1000;

const upsertIssueActivityLog = async ({ workspaceId, issueId, userId, type, fromValue, toValue }) => {
	if (!workspaceId || !issueId || !userId) return;
	const { data: lastLog } = await supabaseAdmin
		.from('activity_logs')
		.select('id, type, created_by, created_at')
		.eq('issue_id', issueId)
		.order('created_at', { ascending: false })
		.limit(1)
		.maybeSingle();

	const lastCreatedAt = lastLog?.created_at ? new Date(lastLog.created_at).getTime() : 0;
	const isWithinWindow = Date.now() - lastCreatedAt <= ACTIVITY_LOG_WINDOW_MS;
	const shouldUpdate =
		lastLog && lastLog.type === type && lastLog.created_by === userId && isWithinWindow;

	const payloadData = {
		from: fromValue ?? null,
		to: toValue ?? null
	};

	if (shouldUpdate) {
		const nowIso = new Date().toISOString();
		await supabaseAdmin
			.from('activity_logs')
			.update({ data: payloadData, created_at: nowIso, updated_at: nowIso })
			.eq('id', lastLog.id);
		return;
	}

	await supabaseAdmin.from('activity_logs').insert({
		workspace_id: workspaceId,
		issue_id: issueId,
		type,
		data: payloadData,
		created_by: userId
	});
};

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const { notif_id, issue_id, assignee_id } = await request.json();
	const userId = locals.user.id;

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('name, workspace_id, assignee_id, workspaces(name)')
		.eq('id', issue_id)
		.maybeSingle();

	// 1. Update issue.assignee_id
	await supabaseAdmin.from('issues').update({ assignee_id }).eq('id', issue_id);

	// 2. Mark admin notification as read + no longer requires action
	await supabaseAdmin
		.from('notifications')
		.update({ is_read: true, requires_action: false, is_resolved: true })
		.eq('id', notif_id);

	// 3. Build notification title
	const wsPrefix = issue?.workspaces?.name?.slice(0, 3).toUpperCase() ?? 'WS';
	const title = `[${wsPrefix}] ${issue?.name}`;

	// 4. Look up admin's display name
	const { data: adminUser } = await supabaseAdmin
		.from('users')
		.select('name')
		.eq('id', userId)
		.maybeSingle();
	const adminName = adminUser?.name ?? 'Your manager';

	// 5. Notify the assignee
	await supabaseAdmin.from('notifications').insert({
		workspace_id: issue.workspace_id,
		issue_id,
		user_id: assignee_id,
		title,
		body: `${adminName} assigned you to this issue.`,
		type: 'info',
		is_read: false
	});

	await upsertIssueActivityLog({
		workspaceId: issue?.workspace_id ?? null,
		issueId: issue_id,
		userId,
		type: 'assignee_change',
		fromValue: issue?.assignee_id ?? null,
		toValue: assignee_id
	});

	return json({ success: true });
};
