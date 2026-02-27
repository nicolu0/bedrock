// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const { workspace } = await parent();

	const notifications = (async () => {
		const { data } = await supabaseAdmin
			.from('notifications')
			.select(
				`
        id, title, body, is_read, created_at, type, meta, requires_action,
        issues(id, name, status,
          units(name, properties(name)))
      `
			)
			.eq('workspace_id', workspace.id)
			.eq('user_id', locals.user.id)
			.order('created_at', { ascending: false });
		return data ?? [];
	})();

	const members = (async () => {
		const { data } = await supabaseAdmin
			.from('members')
			.select('user_id, users(name)')
			.eq('workspace_id', workspace.id);
		return data ?? [];
	})();

	const isAdmin = workspace.admin_user_id === locals.user.id;

	return { notifications, members, isAdmin, currentUserId: locals.user.id };
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

		// 1. Update issue.assignee_id
		await supabaseAdmin.from('issues').update({ assignee_id: assigneeId }).eq('id', issueId);

		// 2. Mark admin notification as read + no longer requires action
		await supabaseAdmin
			.from('notifications')
			.update({ is_read: true, requires_action: false })
			.eq('id', notifId);

		// 3. Build notification title
		const { data: issue } = await supabaseAdmin
			.from('issues')
			.select('name, workspace_id, workspaces(name)')
			.eq('id', issueId)
			.maybeSingle();
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
			is_read: false,
		});

		return { success: true };
	}
};
