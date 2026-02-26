// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const members = (async () => {
		const { workspace } = await parent();
		const { data } = await supabaseAdmin
			.from('members')
			.select('user_id, role, users(name, id)')
			.eq('workspace_id', workspace.id)
			.order('role', { ascending: true }); // 'admin' sorts before 'member' alphabetically
		return data ?? [];
	})();

	return { members, currentUserId: locals.user.id };
};
