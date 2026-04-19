// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { diffWords } from '$lib/utils/textDiff';

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

const normalizeEmail = (value) => {
	const trimmed = (value ?? '').toString().trim().toLowerCase();
	return trimmed || null;
};

const resolveRootIssueId = async (issueId) => {
	if (!issueId) return null;
	let currentId = issueId;
	const visited = new Set();
	for (let i = 0; i < 20; i += 1) {
		if (!currentId || visited.has(currentId)) return issueId;
		visited.add(currentId);
		const { data } = await supabaseAdmin
			.from('issues')
			.select('id, parent_id')
			.eq('id', currentId)
			.maybeSingle();
		if (!data?.id) return issueId;
		if (!data.parent_id) return data.id;
		currentId = data.parent_id;
	}
	return issueId;
};

const maybeAssignVendorToRootIssue = async ({ workspaceId, issueId, recipientEmails }) => {
	// No clearing behavior for now; only set when a real vendor is selected.
	if (!workspaceId || !issueId) return;
	if (!Array.isArray(recipientEmails) || recipientEmails.length !== 1) return;
	const selected = normalizeEmail(recipientEmails[0]);
	if (!selected) return;

	const { data: vendor } = await supabaseAdmin
		.from('vendors')
		.select('id')
		.eq('workspace_id', workspaceId)
		.ilike('email', selected)
		.maybeSingle();
	if (!vendor?.id) return;

	const rootIssueId = await resolveRootIssueId(issueId);
	if (!rootIssueId) return;

	await supabaseAdmin
		.from('issues')
		.update({ vendor_id: vendor.id, updated_at: new Date().toISOString() })
		.eq('id', rootIssueId);
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const messageId = body?.message_id;
	const issueId = body?.issue_id;
	const draftBody = body?.body;
	const channel = body?.channel ?? 'email';
	const hasRecipientEmails = Object.prototype.hasOwnProperty.call(body ?? {}, 'recipient_emails');
	const normalizedRecipients = hasRecipientEmails
		? normalizeRecipientList(body?.recipient_emails)
		: null;

	if (channel !== 'email' && channel !== 'appfolio') {
		return json({ error: 'Invalid channel' }, { status: 400 });
	}

	if (!messageId && !issueId) {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const hasBody = typeof draftBody === 'string';
	if (!hasBody && !hasRecipientEmails) {
		return json({ error: 'Invalid payload' }, { status: 400 });
	}

	const draftQuery = supabaseAdmin.from('drafts').select('id, issue_id, body, original_body');
	const { data: draft } = messageId
		? await draftQuery.eq('message_id', messageId).eq('channel', channel).maybeSingle()
		: await draftQuery
				.eq('issue_id', issueId)
				.is('message_id', null)
				.eq('channel', channel)
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
	if (hasBody) {
		const previousBody = typeof draft?.body === 'string' ? draft.body : '';
		const storedOriginal =
			typeof draft?.original_body === 'string' ? draft.original_body : previousBody;
		updatePayload.body = draftBody;
		updatePayload.original_body = storedOriginal;
		updatePayload.draft_diff = diffWords(storedOriginal, draftBody ?? '');
	}
	if (hasRecipientEmails) {
		updatePayload.recipient_emails = normalizedRecipients?.length ? normalizedRecipients : null;
		updatePayload.recipient_email = normalizedRecipients?.[0] ?? null;
	}

	const { data: updatedDraft, error } = await supabaseAdmin
		.from('drafts')
		.update(updatePayload)
		.eq('id', draft.id)
		.select('id, body, original_body, draft_diff, recipient_email, recipient_emails')
		.maybeSingle();

	if (error) {
		return json({ error: error.message }, { status: 400 });
	}

	await supabaseAdmin
		.from('issues')
		.update({ updated_at: new Date().toISOString() })
		.eq('id', draft.issue_id);

	// Persist selected vendor (from the draft recipient selector) onto the *root* issue.
	// This lets the issue header and My Issues rows show the assigned vendor.
	if (hasRecipientEmails) {
		await maybeAssignVendorToRootIssue({
			workspaceId,
			issueId: draft.issue_id,
			recipientEmails: normalizedRecipients
		});
	}

	return json({ ok: true, draft: updatedDraft ?? null });
};
