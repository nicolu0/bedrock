// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const messageId = body?.message_id;
	const draftBody = body?.body;

	if (!messageId || typeof draftBody !== 'string') {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const { data: draft } = await supabaseAdmin
		.from('email_drafts')
		.select('id, issue_id')
		.eq('message_id', messageId)
		.maybeSingle();

	if (!draft?.id || !draft.issue_id) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('workspace_id')
		.eq('id', draft.issue_id)
		.maybeSingle();

	const workspaceId = issue?.workspace_id ?? null;
	if (!workspaceId) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	const { data: member } = await supabaseAdmin
		.from('members')
		.select('id')
		.eq('workspace_id', workspaceId)
		.eq('user_id', locals.user.id)
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', workspaceId)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();

		if (!workspace?.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
	}

	const { error } = await supabaseAdmin
		.from('email_drafts')
		.update({ body: draftBody, updated_at: new Date().toISOString() })
		.eq('id', draft.id);

	if (error) {
		return json({ error: error.message }, { status: 400 });
	}

	return json({ ok: true });
};
