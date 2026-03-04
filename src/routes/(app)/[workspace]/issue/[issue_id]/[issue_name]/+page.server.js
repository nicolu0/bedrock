// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}
	const { workspace } = await parent();
	const { data: vendors } = await supabaseAdmin
		.from('vendors')
		.select('id, name, email, trade')
		.eq('workspace_id', workspace.id)
		.order('name', { ascending: true });
	return { vendors: vendors ?? [] };
};
