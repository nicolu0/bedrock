// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const normalizeRecipientList = (value) => {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map((email) => String(email ?? '').trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((email) => email.trim())
			.filter(Boolean);
	}
	return [];
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const messageId = body?.message_id;
	const issueId = body?.issue_id;
	const draftBody = body?.body;
	const hasRecipientEmails = Object.prototype.hasOwnProperty.call(body ?? {}, 'recipient_emails');
	const normalizedRecipients = hasRecipientEmails
		? normalizeRecipientList(body?.recipient_emails)
		: null;

	if (!messageId && !issueId) {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const hasBody = typeof draftBody === 'string';
	if (!hasBody && !hasRecipientEmails) {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const draftQuery = supabaseAdmin.from('email_drafts').select('id, issue_id');
	const { data: draft } = messageId
		? await draftQuery.eq('message_id', messageId).maybeSingle()
		: await draftQuery.eq('issue_id', issueId).is('message_id', null).maybeSingle();

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
		.from('people')
		.select('id')
		.eq('workspace_id', workspaceId)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
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

	const updatePayload = { updated_at: new Date().toISOString() };
	if (hasBody) updatePayload.body = draftBody;
	if (hasRecipientEmails) {
		updatePayload.recipient_emails = normalizedRecipients?.length ? normalizedRecipients : null;
		updatePayload.recipient_email = normalizedRecipients?.[0] ?? null;
	}

	const { error } = await supabaseAdmin
		.from('email_drafts')
		.update(updatePayload)
		.eq('id', draft.id);

	if (error) {
		return json({ error: error.message }, { status: 400 });
	}

	return json({ ok: true });
};
