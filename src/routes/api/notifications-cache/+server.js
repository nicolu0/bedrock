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

	const [{ data: notifications }, { data: members }] = await Promise.all([
		supabaseAdmin
			.from('notifications')
			.select(
				`id, title, body, is_read, created_at, type, meta, requires_action,
        issues(id, name, status, units(name, properties(name)))`
			)
			.eq('workspace_id', workspace.id)
			.eq('user_id', locals.user.id)
			.order('created_at', { ascending: false }),
		supabaseAdmin
			.from('members')
			.select('user_id, users(name)')
			.eq('workspace_id', workspace.id)
	]);

	return json({ notifications: notifications ?? [], members: members ?? [] });
};
