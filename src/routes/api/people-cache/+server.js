// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const canAccessPeople = async (workspaceId, userId) => {
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id')
		.eq('id', workspaceId)
		.eq('admin_user_id', userId)
		.maybeSingle();
	if (adminWorkspace?.id) return true;
	const { data: member } = await supabaseAdmin
		.from('people')
		.select('role')
		.eq('workspace_id', workspaceId)
		.eq('user_id', userId)
		.maybeSingle();
	return member?.role === 'admin' || member?.role === 'member';
};

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const allowed = await canAccessPeople(workspace.id, locals.user.id);
	if (!allowed) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: members } = await supabaseAdmin
		.from('people')
		.select('user_id, name, role, users(name, id)')
		.eq('workspace_id', workspace.id)
		.in('role', ['admin', 'member', 'owner', 'vendor'])
		.order('role', { ascending: true });

	return json(members ?? []);
};
