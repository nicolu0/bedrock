// @ts-nocheck
import { json } from '@sveltejs/kit';
import { resolveWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const payload = await request.json().catch(() => ({}));
	const workspaceSlug = payload?.workspace ?? null;
	const runId = payload?.runId ?? null;
	if (!workspaceSlug || !runId) {
		return json({ error: 'Missing workspace or runId' }, { status: 400 });
	}
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace not found' }, { status: 404 });

	const { error } = await supabaseAdmin
		.from('agent_events')
		.update({ dismissed_at: new Date().toISOString(), dismissed_by: locals.user.id })
		.eq('workspace_id', workspace.id)
		.eq('run_id', runId);

	if (error) return json({ error: error.message }, { status: 500 });
	return json({ ok: true });
};
