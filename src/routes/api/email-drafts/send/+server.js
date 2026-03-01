// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { env } from '$env/dynamic/private';

const encodeBase64Url = (value) =>
	Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
	if (!messageId) return json({ error: 'Invalid payload' }, { status: 400 });

	const { data: draft } = await supabaseAdmin
		.from('email_drafts')
		.select('id, issue_id, recipient, subject, body, message_id')
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
	if (!workspaceId) return json({ error: 'Not found' }, { status: 404 });

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
		if (!workspace?.id) return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: message } = await supabaseAdmin
		.from('messages')
		.select('thread_id, external_id')
		.eq('id', messageId)
		.maybeSingle();

	if (!message?.thread_id) return json({ error: 'Thread not found' }, { status: 404 });

	const { data: thread } = await supabaseAdmin
		.from('threads')
		.select('connection_id, external_id')
		.eq('id', message.thread_id)
		.maybeSingle();

	if (!thread?.connection_id) return json({ error: 'Connection not found' }, { status: 404 });

	const { data: connection } = await supabaseAdmin
		.from('gmail_connections')
		.select('*')
		.eq('id', thread.connection_id)
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

	const subjectLine = draft.subject?.toLowerCase().startsWith('re:')
		? draft.subject
		: `Re: ${draft.subject}`;

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

	const rawEmail = [
		`From: ${connection.email}`,
		`To: ${draft.recipient}`,
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
			threadId: thread.external_id ?? undefined
		})
	});

	if (!sendResponse.ok) {
		const detail = await sendResponse.text();
		return json({ error: detail }, { status: 400 });
	}

	const sendPayload = await sendResponse.json().catch(() => null);
	const sentExternalId = sendPayload?.id ?? null;

	const { data: outboundMessage } = await supabaseAdmin
		.from('messages')
		.insert({
			thread_id: message.thread_id,
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

	return json({ ok: true, message: outboundMessage ?? null });
};
