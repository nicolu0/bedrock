// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json().catch(() => null);
	const issueId = body?.issue_id ?? null;
	if (!issueId) return json({ error: 'Invalid payload' }, { status: 400 });

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, parent_id, workspace_id')
		.eq('id', issueId)
		.maybeSingle();
	if (!issue?.id || !issue.workspace_id) return json({ error: 'Not found' }, { status: 404 });

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'bedrock', 'member', 'owner', 'vendor'])
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', issue.workspace_id)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();
		if (!workspace?.id) return json({ error: 'Forbidden' }, { status: 403 });
	}

	const now = new Date().toISOString();
	await supabaseAdmin.from('issues').update({ updated_at: now }).eq('id', issue.id);
	if (issue.parent_id) {
		await supabaseAdmin.from('issues').update({ updated_at: now }).eq('id', issue.parent_id);
	}

	return json({ ok: true, updated_at: now });
};
