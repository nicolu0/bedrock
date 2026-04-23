// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json().catch(() => null);
	const messageId = body?.message_id;
	const issueId = body?.issue_id ?? null;
	if (!messageId) return json({ error: 'message_id required' }, { status: 400 });

	const { data: message, error: fetchErr } = await supabaseAdmin
		.from('messages')
		.select('id, workspace_id, channel, metadata')
		.eq('id', messageId)
		.maybeSingle();
	if (fetchErr || !message) return json({ error: 'message not found' }, { status: 404 });
	if (message.channel !== 'imessage') {
		return json({ error: 'only imessage messages can be relinked' }, { status: 400 });
	}

	const { data: membership } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('workspace_id', message.workspace_id)
		.eq('user_id', locals.user.id)
		.maybeSingle();
	if (!membership) return json({ error: 'Forbidden' }, { status: 403 });

	if (issueId) {
		const { data: issue } = await supabaseAdmin
			.from('issues')
			.select('id, workspace_id')
			.eq('id', issueId)
			.maybeSingle();
		if (!issue || issue.workspace_id !== message.workspace_id) {
			return json({ error: 'issue not in workspace' }, { status: 400 });
		}
	}

	const metadata = { ...(message.metadata ?? {}) };
	metadata.link = {
		method: 'manual',
		linked_by: locals.user.id,
		linked_at: new Date().toISOString()
	};

	const { error: updateErr } = await supabaseAdmin
		.from('messages')
		.update({ issue_id: issueId, metadata })
		.eq('id', messageId);
	if (updateErr) return json({ error: updateErr.message }, { status: 500 });

	return json({ ok: true });
};
