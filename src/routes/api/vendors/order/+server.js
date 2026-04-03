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
	return member?.role === 'admin' || member?.role === 'bedrock' || member?.role === 'member';
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { workspace: workspaceSlug, updates } = body ?? {};
	if (!Array.isArray(updates) || !workspaceSlug) {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	const allowed = await canAccessPeople(workspace.id, locals.user.id);
	if (!allowed) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const sanitized = updates
		.map((update) => ({
			id: update?.id,
			preference_index: Number(update?.preference_index)
		}))
		.filter((update) => update.id && Number.isFinite(update.preference_index));

	if (!sanitized.length) {
		return json({ error: 'No updates provided' }, { status: 400 });
	}

	const results = await Promise.all(
		sanitized.map((update) =>
			supabaseAdmin
				.from('vendors')
				.update({ preference_index: update.preference_index })
				.eq('id', update.id)
				.eq('workspace_id', workspace.id)
				.select('id')
				.single()
		)
	);

	const error = results.find((res) => res.error)?.error;
	if (error) {
		if (error.message?.includes('preference_index')) {
			return json({ error: 'Vendor ordering not available yet.' }, { status: 409 });
		}
		return json({ error: error.message }, { status: 500 });
	}

	return json({ success: true });
};
