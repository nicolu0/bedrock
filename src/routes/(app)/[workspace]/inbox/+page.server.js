// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const ACTIVITY_LOG_WINDOW_MS = 60 * 60 * 1000;

const upsertIssueActivityLog = async ({
	workspaceId,
	issueId,
	userId,
	type,
	fromValue,
	toValue
}) => {
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

export const load = async ({ parent, locals }) => {
	if (!locals.user) throw redirect(303, '/');

	const currentUserId = locals.user.id;
	const _parent = parent();

	const notifications = (async () => {
		const { workspace } = await _parent;
		if (!workspace?.id) return [];
		const { data } = await supabaseAdmin
			.from('notifications')
			.select(
				`
        id, title, body, is_read, is_resolved, created_at, type, meta, requires_action,
        issues(id, name, status, parent_id,
          units(name, properties(name)))
      `
			)
			.eq('workspace_id', workspace.id)
			.eq('user_id', locals.user.id)
			.order('created_at', { ascending: false });
		return data ?? [];
	})();

	const members = (async () => {
		const { workspace } = await _parent;
		if (!workspace?.id) return [];
		const { data } = await supabaseAdmin
			.from('people')
			.select('user_id, name, role, users(name, id)')
			.eq('workspace_id', workspace.id)
			.in('role', ['admin', 'member', 'owner']);
		return data ?? [];
	})();

	return { notifications, members, currentUserId };
};

export const actions = {
	markRead: async ({ request }) => {
		const data = await request.formData();
		const id = data.get('id');
		await supabaseAdmin.from('notifications').update({ is_read: true }).eq('id', id);
		return { success: true };
	},

	approveAssignment: async ({ request, locals }) => {
		const form = await request.formData();
		const notifId = form.get('notif_id');
		const issueId = form.get('issue_id');
		const assigneeId = form.get('assignee_id');
		const userId = locals.user?.id ?? null;

		const { data: issue } = await supabaseAdmin
			.from('issues')
			.select('name, workspace_id, assignee_id, workspaces(name)')
			.eq('id', issueId)
			.maybeSingle();

		// 1. Update issue.assignee_id
		await supabaseAdmin.from('issues').update({ assignee_id: assigneeId }).eq('id', issueId);

		// 2. Mark admin notification as read + no longer requires action
		await supabaseAdmin
			.from('notifications')
			.update({ is_read: true, requires_action: false, is_resolved: true })
			.eq('id', notifId);

		// 3. Build notification title
		const wsPrefix = issue?.workspaces?.name?.slice(0, 3).toUpperCase() ?? 'WS';
		const title = `[${wsPrefix}] ${issue?.name}`;

		// 4. Look up admin's display name
		const { data: adminUser } = await supabaseAdmin
			.from('users')
			.select('name')
			.eq('id', locals.user.id)
			.maybeSingle();
		const adminName = adminUser?.name ?? 'Your manager';

		// 5. Notify the assignee
		await supabaseAdmin.from('notifications').insert({
			workspace_id: issue.workspace_id,
			issue_id: issueId,
			user_id: assigneeId,
			title,
			body: `${adminName} assigned you to this issue.`,
			type: 'info',
			is_read: false
		});

		await upsertIssueActivityLog({
			workspaceId: issue?.workspace_id ?? null,
			issueId,
			userId,
			type: 'assignee_change',
			fromValue: issue?.assignee_id ?? null,
			toValue: assigneeId
		});

		return { success: true };
	}
};
