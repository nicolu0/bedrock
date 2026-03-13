// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { env } from '$env/dynamic/private';

const encodeBase64Url = (value) =>
	Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

const refreshAccessToken = async (connection) => {
	const refreshBody = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID ?? '',
		client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
		refresh_token: connection.refresh_token,
		grant_type: 'refresh_token'
	});

	const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: refreshBody
	});

	if (!refreshResponse.ok) {
		return null;
	}

	const payload = await refreshResponse.json();
	const accessToken = payload?.access_token ?? null;
	const expiresIn = Number(payload?.expires_in ?? 0);
	if (!accessToken || !expiresIn) return null;

	const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
	await supabaseAdmin
		.from('gmail_connections')
		.update({
			access_token: accessToken,
			expires_at: expiresAt,
			updated_at: new Date().toISOString()
		})
		.eq('id', connection.id);

	return accessToken;
};

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const messageId = body?.message_id;
	const issueId = body?.issue_id;
	const recipientOverride =
		typeof body?.recipient_email === 'string' ? body.recipient_email.trim() : null;
	const recipientOverrides = normalizeRecipientList(body?.recipient_emails);
	if (!messageId && !issueId) return json({ error: 'Invalid payload' }, { status: 400 });

	const draftQuery = supabaseAdmin
		.from('email_drafts')
		.select(
			'id, issue_id, recipient_email, recipient_emails, subject, body, message_id, sender_email'
		);
	const { data: draft } = messageId
		? await draftQuery.eq('message_id', messageId).maybeSingle()
		: await draftQuery.eq('issue_id', issueId).is('message_id', null).maybeSingle();

	if (!draft?.id || !draft.issue_id) {
		return json({ error: 'Not found' }, { status: 404 });
	}
	if (!draft.sender_email) {
		return json({ error: 'Sender email required' }, { status: 400 });
	}
	const effectiveRecipients = recipientOverrides.length
		? recipientOverrides
		: normalizeRecipientList(draft.recipient_emails).length
			? normalizeRecipientList(draft.recipient_emails)
			: normalizeRecipientList(draft.recipient_email);
	if (!effectiveRecipients.length) {
		return json({ error: 'Recipient email required' }, { status: 400 });
	}

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('workspace_id')
		.eq('id', draft.issue_id)
		.maybeSingle();

	const workspaceId = issue?.workspace_id ?? null;
	if (!workspaceId) return json({ error: 'Not found' }, { status: 404 });

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', workspaceId)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'member', 'owner'])
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', workspaceId)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();
		if (!workspace?.id) return json({ error: 'Forbidden' }, { status: 403 });
	}

	let message = null;
	let thread = null;
	if (messageId) {
		const { data: foundMessage } = await supabaseAdmin
			.from('messages')
			.select('thread_id, external_id')
			.eq('id', messageId)
			.maybeSingle();
		message = foundMessage ?? null;
		if (!message?.thread_id) return json({ error: 'Thread not found' }, { status: 404 });
		const { data: foundThread } = await supabaseAdmin
			.from('threads')
			.select('connection_id, external_id')
			.eq('id', message.thread_id)
			.maybeSingle();
		thread = foundThread ?? null;
		if (!thread?.connection_id) return json({ error: 'Connection not found' }, { status: 404 });
	}

	const { data: connection } = messageId
		? await supabaseAdmin
				.from('gmail_connections')
				.select('*')
				.eq('id', thread.connection_id)
				.maybeSingle()
		: await supabaseAdmin
				.from('gmail_connections')
				.select('*')
				.eq('email', draft.sender_email)
				.order('updated_at', { ascending: false })
				.maybeSingle();

	if (!connection?.access_token || !connection.email) {
		return json({ error: 'Connection not found' }, { status: 404 });
	}

	let accessToken = connection.access_token;
	const expiresAt = new Date(connection.expires_at).getTime();
	const refreshNeeded = Number.isNaN(expiresAt) || expiresAt - Date.now() < 120000;
	if (refreshNeeded) {
		const refreshed = await refreshAccessToken(connection);
		if (!refreshed) return json({ error: 'Token refresh failed' }, { status: 401 });
		accessToken = refreshed;
	}

	const subjectLine = messageId
		? draft.subject?.toLowerCase().startsWith('re:')
			? draft.subject
			: `Re: ${draft.subject}`
		: draft.subject;

	let replyHeaders = [];
	if (message?.external_id) {
		const messageMetaRes = await fetch(
			`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.external_id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`,
			{
				headers: { Authorization: `Bearer ${accessToken}` }
			}
		);
		if (messageMetaRes.ok) {
			const metaPayload = await messageMetaRes.json();
			const headers = metaPayload?.payload?.headers ?? [];
			const getHeader = (name) =>
				headers.find((h) => h?.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
			const messageIdHeader = getHeader('Message-ID');
			const referencesHeader = getHeader('References');
			const inReplyToHeader = getHeader('In-Reply-To');
			if (messageIdHeader) {
				replyHeaders.push(`In-Reply-To: ${messageIdHeader}`);
				const combinedRefs = [referencesHeader, inReplyToHeader, messageIdHeader]
					.filter(Boolean)
					.join(' ');
				replyHeaders.push(`References: ${combinedRefs}`);
			}
		}
	}

	if (recipientOverrides.length) {
		const nextRecipientEmail = recipientOverrides[0] ?? null;
		await supabaseAdmin
			.from('email_drafts')
			.update({
				recipient_email: nextRecipientEmail,
				recipient_emails: recipientOverrides
			})
			.eq('id', draft.id);
	} else if (recipientOverride && recipientOverride !== draft.recipient_email) {
		await supabaseAdmin
			.from('email_drafts')
			.update({ recipient_email: recipientOverride, recipient_emails: [recipientOverride] })
			.eq('id', draft.id);
	}

	const rawEmail = [
		`From: ${connection.email}`,
		`To: ${effectiveRecipients.join(', ')}`,
		`Subject: ${subjectLine}`,
		...replyHeaders,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'',
		draft.body
	].join('\n');

	const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			raw: encodeBase64Url(rawEmail),
			threadId: messageId ? (thread.external_id ?? undefined) : undefined
		})
	});

	if (!sendResponse.ok) {
		const detail = await sendResponse.text();
		return json({ error: detail }, { status: 400 });
	}

	const sendPayload = await sendResponse.json().catch(() => null);
	const sentExternalId = sendPayload?.id ?? null;

	let outboundThreadId = message?.thread_id ?? null;
	if (!messageId) {
		const primaryRecipient = effectiveRecipients[0]?.trim() ?? '';
		const { data: vendorRow } = await supabaseAdmin
			.from('people')
			.select('id')
			.eq('workspace_id', workspaceId)
			.eq('role', 'vendor')
			.ilike('email', primaryRecipient)
			.maybeSingle();
		const { data: createdThread } = await supabaseAdmin
			.from('threads')
			.insert({
				tenant_id: null,
				participant_type: 'vendor',
				participant_id: vendorRow?.id ?? null,
				issue_id: draft.issue_id,
				name: draft.subject,
				external_id: sendPayload?.threadId ?? null,
				connection_id: connection.id,
				workspace_id: workspaceId
			})
			.select('id')
			.maybeSingle();
		outboundThreadId = createdThread?.id ?? null;
	}

	const { data: outboundMessage } = await supabaseAdmin
		.from('messages')
		.insert({
			thread_id: outboundThreadId,
			issue_id: draft.issue_id,
			message: draft.body,
			sender: 'outbound',
			subject: draft.subject,
			timestamp: new Date().toISOString(),
			channel: 'gmail',
			direction: 'outbound',
			delivery_status: 'sent',
			connection_id: connection.id,
			external_id: sentExternalId
		})
		.select('id, issue_id, message, sender, subject, timestamp, direction, channel')
		.maybeSingle();

	await supabaseAdmin.from('email_drafts').delete().eq('id', draft.id);

	if (draft?.issue_id && locals.user?.id) {
		await supabaseAdmin
			.from('notifications')
			.update({ is_resolved: true })
			.eq('issue_id', draft.issue_id)
			.eq('user_id', locals.user.id)
			.eq('is_resolved', false);
	}

	return json({ ok: true, message: outboundMessage ?? null });
};
