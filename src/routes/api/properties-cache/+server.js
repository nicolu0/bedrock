// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	let ownerPersonId = null;
	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('workspace_id', workspace.id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (member?.role === 'owner') {
		ownerPersonId = member.id;
	}

	let query = supabaseAdmin
		.from('properties')
		.select('id, name, address, city, state, postal_code, country, owner_id')
		.eq('workspace_id', workspace.id)
		.order('name', { ascending: true });
	if (ownerPersonId) {
		query = query.eq('owner_id', ownerPersonId);
	}
	const { data } = await query;

	return json(data ?? []);
};
