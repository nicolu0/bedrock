// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, depends }) => {
	depends('app:people');

	const { workspace, role, userId } = await parent();
	const canViewPeople = role === 'admin' || role === 'bedrock' || role === 'member';

	if (!canViewPeople) {
		return { ownersFromTable: [] };
	}

	const { data: owners } = await supabaseAdmin
		.from('owners')
		.select('id, name, email, phone, people_id, created_at, people(user_id)')
		.eq('workspace_id', workspace.id)
		.order('name', { ascending: true });

	return {
		ownersFromTable: (owners ?? []).map((o) => ({
			id: o.id,
			name: o.name,
			email: o.email,
			role: 'owner',
			user_id: o.people?.user_id ?? null,
			people_id: o.people_id
		})),
		currentUserId: userId
	};
};
