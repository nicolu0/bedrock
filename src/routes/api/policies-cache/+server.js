// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';
import { loadPoliciesData } from '$lib/server/loaders';

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
		.select('id')
		.eq('workspace_id', workspace.id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (!member?.id) {
		const { data: adminWorkspace } = await supabaseAdmin
			.from('workspaces')
			.select('admin_user_id')
			.eq('id', workspace.id)
			.maybeSingle();
		if (adminWorkspace?.admin_user_id !== locals.user.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
	}

	const data = await loadPoliciesData(workspace.id);
	return json(data);
};
