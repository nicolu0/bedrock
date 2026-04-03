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
		.select('id, workspace_id')
		.eq('id', issueId)
		.maybeSingle();
	if (!issue?.id || !issue.workspace_id) return json({ error: 'Not found' }, { status: 404 });

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
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
	const { error } = await supabaseAdmin.from('issue_reads').upsert(
		{
			issue_id: issue.id,
			user_id: locals.user.id,
			workspace_id: issue.workspace_id,
			last_seen_at: now,
			updated_at: now
		},
		{ onConflict: 'issue_id,user_id' }
	);

	if (error) return json({ error: error.message }, { status: 400 });
	return json({ ok: true, last_seen_at: now });
};
