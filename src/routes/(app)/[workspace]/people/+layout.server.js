// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const people = (async () => {
		const { workspace } = await parent();
		const { data } = await supabaseAdmin
			.from('people')
			.select('id, user_id, name, email, role, trade, notes, pending, created_at')
			.eq('workspace_id', workspace.id)
			.order('name', { ascending: true });
		return data ?? [];
	})();

	return { people, currentUserId: locals.user.id };
};
