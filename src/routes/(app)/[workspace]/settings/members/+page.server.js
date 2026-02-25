// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent }) => {
	const { workspace } = await parent();

	const { data: members } = await supabaseAdmin
		.from('members')
		.select('user_id, role, users(name, id)')
		.eq('workspace_id', workspace.id)
		.order('role', { ascending: true }); // 'admin' sorts before 'member' alphabetically

	return { members: members ?? [] };
};
