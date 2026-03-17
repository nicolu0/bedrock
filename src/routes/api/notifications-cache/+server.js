// @ts-nocheck
import { json } from '@sveltejs/kit';
import { resolveWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { loadNotificationsData } from '$lib/server/loaders';

export const GET = async ({ locals, url }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Forbidden' }, { status: 403 });

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('workspace_id', workspace.id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (!member) return json({ error: 'Forbidden' }, { status: 403 });

	const data = await loadNotificationsData(workspace.id, locals.user.id);
	return json(data);
};
