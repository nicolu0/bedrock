// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';
import { loadIssuesData } from '$lib/server/loaders';

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('workspace_id', workspace.id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	let role = member?.role ? String(member.role).toLowerCase() : null;
	const ownerPersonId = member?.id ?? null;
	if (!role) {
		const { data: adminWorkspace } = await supabaseAdmin
			.from('workspaces')
			.select('admin_user_id')
			.eq('id', workspace.id)
			.maybeSingle();
		if (adminWorkspace?.admin_user_id === locals.user.id) {
			role = 'admin';
		}
	}
	if (!role) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const data = await loadIssuesData(workspace.id, locals.user.id, role, ownerPersonId, {
		includeSubIssues: false
	});
	return json(data);
};
