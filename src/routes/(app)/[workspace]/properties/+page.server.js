// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, depends }) => {
	depends('app:people');

	const { workspace, role } = await parent();
	const canViewPeople = role === 'admin' || role === 'member';

	if (!canViewPeople) {
		return { owners: [] };
	}

	const { data: owners } = await supabaseAdmin
		.from('people')
		.select('id, name, user_id')
		.eq('workspace_id', workspace.id)
		.eq('role', 'owner');

	return { owners: owners ?? [] };
};
