// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const notifications = (async () => {
		const { workspace } = await parent();

		const { data } = await supabaseAdmin
			.from('notifications')
			.select(
				`
        id, title, body, is_read, created_at,
        issues(id, name, issue_number, status,
          units(name, properties(name)))
      `
			)
			.eq('workspace_id', workspace.id)
			.eq('user_id', locals.user.id)
			.order('created_at', { ascending: false });
		return data ?? [];
	})();

	return { notifications, currentUserId: locals.user.id };
};

export const actions = {
	markRead: async ({ request }) => {
		const data = await request.formData();
		const id = data.get('id');
		await supabaseAdmin.from('notifications').update({ is_read: true }).eq('id', id);
		return { success: true };
	}
};
