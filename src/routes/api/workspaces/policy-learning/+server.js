// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const PATCH = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const workspaceId = body?.workspace_id ?? body?.workspaceId ?? null;
	const enabled = body?.enabled;

	if (!workspaceId || typeof enabled !== 'boolean') {
		return json({ error: 'Missing workspace_id or enabled.' }, { status: 400 });
	}

	// Verify caller is a workspace admin.
	const { data: member } = await supabaseAdmin
		.from('people')
		.select('workspace_id, role')
		.eq('user_id', user.id)
		.eq('workspace_id', workspaceId)
		.maybeSingle();

	if (!member || (member.role ?? '').toLowerCase() !== 'admin') {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: workspace, error } = await supabaseAdmin
		.from('workspaces')
		.update({ policy_learning_enabled: enabled })
		.eq('id', workspaceId)
		.select('id, policy_learning_enabled')
		.maybeSingle();

	if (error) return json({ error: error.message }, { status: 500 });
	return json({ workspace });
};
