// @ts-nocheck
// V2 pubsub-hook. Receives Gmail Pub/Sub notifications, fetches new messages,
// and routes AppFolio work-order emails to the intake-agent edge function.
// Tenant emails are intentionally dropped — the v2 tenant pipeline is TBD.
import { json } from '@sveltejs/kit';
import {
	AGENT_WEBHOOK_SECRET,
	GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET,
	SUPABASE_SERVICE_ROLE_KEY
} from '$env/static/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const APPFOLIO_SENDER = 'donotreply@appfolio.com';
const TEST_SENDERS = new Set(['johnbedrocktest@gmail.com']);
// Workspace used for test-mode emails (no AppFolio property to resolve from).
const TEST_WORKSPACE_ID = '2e4373a0-40b8-42c2-a873-b08c99dbf76a';
const agentSecretHeader = 'x-agent-secret';
const pubsubSecretParam = 'secret';

// ── Helpers ──────────────────────────────────────────────────────────────────

const decodeBase64Url = (input) => {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	return Buffer.from(normalized + pad, 'base64').toString('utf-8');
};

const decodeQuotedPrintable = (input) => {
	const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
	return withoutSoftBreaks.replace(/=([0-9A-F]{2})/gi, (_m, hex) =>
		String.fromCharCode(parseInt(hex, 16))
	);
};

const normalizeQuotedPrintable = (input) =>
	/\=\r?\n|=[0-9A-F]{2}/i.test(input) ? decodeQuotedPrintable(input) : input;

const stripHtml = (input) =>
	input
		.replace(/<br\s*\/?\s*>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();

const getHeader = (headers, name) =>
	headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

const extractEmail = (fromValue) => {
	const match = fromValue.match(/<([^>]+)>/);
	return (match?.[1] ?? fromValue).trim().toLowerCase();
};

const findBodyPart = (payload, mimeType) => {
	if (!payload) return null;
	if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data;
	if (payload.parts) {
		for (const part of payload.parts) {
			const found = findBodyPart(part, mimeType);
			if (found) return found;
		}
	}
	return null;
};

const isPubsubSecretValid = (request) => {
	if (!AGENT_WEBHOOK_SECRET) return false;
	const headerSecret = request.headers.get(agentSecretHeader) ?? '';
	const url = new URL(request.url);
	const querySecret = url.searchParams.get(pubsubSecretParam) ?? '';
	return headerSecret === AGENT_WEBHOOK_SECRET || querySecret === AGENT_WEBHOOK_SECRET;
};

// ── Gmail OAuth + API ────────────────────────────────────────────────────────

const refreshAccessTokenIfNeeded = async (connection) => {
	const expiresAt = new Date(connection.expires_at).getTime();
	if (!Number.isNaN(expiresAt) && expiresAt - Date.now() >= 120_000) {
		return connection.access_token;
	}
	if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
		throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
	}
	const refreshBody = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		client_secret: GOOGLE_CLIENT_SECRET,
		refresh_token: connection.refresh_token,
		grant_type: 'refresh_token'
	});
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: refreshBody
	});
	if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
	const refreshed = await res.json();
	const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
	await supabaseAdmin
		.from('gmail_connections')
		.update({ access_token: refreshed.access_token, expires_at: newExpiresAt, updated_at: new Date().toISOString() })
		.eq('id', connection.id);
	return refreshed.access_token;
};

const fetchHistory = async (accessToken, startHistoryId) => {
	const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
	url.searchParams.set('startHistoryId', startHistoryId);
	url.searchParams.set('historyTypes', 'messageAdded');
	const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) {
		const err = new Error(await res.text());
		err.status = res.status;
		throw err;
	}
	return res.json();
};

const fetchProfile = async (accessToken) => {
	const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) throw new Error(await res.text());
	return res.json();
};

const fetchMessage = async (accessToken, messageId) => {
	const res = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
		{ headers: { Authorization: `Bearer ${accessToken}` } }
	);
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(await res.text());
	return res.json();
};

// ── AppFolio routing ─────────────────────────────────────────────────────────

// Subject formats:
//   "WO #7575-1 - Rain Gutters - 206"             (single family)
//   "WO #7522-1 - Water Heater - 292 - 292-18"    (with unit)
// Property number = first purely numeric segment after the WO prefix.
const parseAppfolioSubject = (subject) => {
	const parts = (subject ?? '').split(' - ');
	const woMatch = (parts[0] ?? '').match(/WO\s*#([\w-]+)/i);
	const serviceRequestNumber = woMatch?.[1] ?? null;
	let appfolioPropertyId = null;
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i].trim();
		if (/^\d+$/.test(part)) {
			appfolioPropertyId = part;
			break;
		}
	}
	return { serviceRequestNumber, appfolioPropertyId };
};

const extractPlainBody = (payload) => {
	const plain = findBodyPart(payload, 'text/plain');
	if (plain) return normalizeQuotedPrintable(decodeBase64Url(plain));
	const html = findBodyPart(payload, 'text/html');
	if (html) return stripHtml(normalizeQuotedPrintable(decodeBase64Url(html)));
	return '';
};

// Resolve which workspace owns the property, requiring AppFolio email tracking.
const resolveWorkspace = async (appfolioPropertyId) => {
	const { data } = await supabaseAdmin
		.from('properties')
		.select('workspace_id, workspaces!inner(appfolio_email_tracking)')
		.eq('appfolio_property_number', appfolioPropertyId)
		.eq('workspaces.appfolio_email_tracking', true)
		.maybeSingle();
	return data?.workspace_id ?? null;
};

const dispatchIntakeAgent = (payload) => {
	return fetch(`${PUBLIC_SUPABASE_URL}/functions/v1/intake-agent`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			apikey: SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
		},
		body: JSON.stringify(payload)
	})
		.then(async (response) => {
			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				console.error('pubsub-hook intake-agent dispatch failed', { status: response.status, detail });
			}
		})
		.catch((err) => console.error('pubsub-hook intake-agent dispatch error', err));
};

const processMessage = async (accessToken, messageId) => {
	const message = await fetchMessage(accessToken, messageId);
	if (!message) return;
	const headers = message.payload?.headers ?? [];
	const senderEmail = extractEmail(getHeader(headers, 'from'));
	const subject = getHeader(headers, 'subject');
	const body = extractPlainBody(message.payload);

	// Test-mode: johnbedrocktest@gmail.com → skip subject parsing + AppFolio API.
	// intake-agent treats it as a synthetic work order.
	if (TEST_SENDERS.has(senderEmail)) {
		console.log('pubsub-hook routing test email to intake-agent', { messageId, subject });
		await dispatchIntakeAgent({
			isTest: true,
			workspaceId: TEST_WORKSPACE_ID,
			subject,
			body,
			gmailMessageId: messageId
		});
		return;
	}

	if (senderEmail !== APPFOLIO_SENDER) return; // tenant emails dropped in v2

	const { serviceRequestNumber, appfolioPropertyId } = parseAppfolioSubject(subject);
	if (!serviceRequestNumber || !appfolioPropertyId) {
		console.warn('pubsub-hook appfolio: could not parse subject', { subject });
		return;
	}

	const workspaceId = await resolveWorkspace(appfolioPropertyId);
	if (!workspaceId) {
		console.warn('pubsub-hook appfolio: no workspace with email tracking', { appfolioPropertyId });
		return;
	}

	console.log('pubsub-hook routing to intake-agent', {
		messageId,
		serviceRequestNumber,
		appfolioPropertyId,
		workspaceId
	});

	await dispatchIntakeAgent({
		workspaceId,
		serviceRequestNumber,
		appfolioPropertyId,
		subject,
		body,
		gmailMessageId: messageId
	});
};

// ── Handler ──────────────────────────────────────────────────────────────────

export const POST = async ({ request }) => {
	if (!AGENT_WEBHOOK_SECRET) return json({ error: 'Missing AGENT_WEBHOOK_SECRET' }, { status: 500 });
	if (!SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' }, { status: 500 });

	const payload = await request.json().catch(() => null);
	if (!payload?.message?.data) return json({ error: 'Missing Pub/Sub message' }, { status: 400 });
	if (!isPubsubSecretValid(request)) return json({ error: 'Unauthorized' }, { status: 401 });

	let parsed = null;
	try {
		parsed = JSON.parse(decodeBase64Url(payload.message.data));
	} catch (err) {
		console.error('pubsub-hook decode/parse failed', err);
		return json({ error: 'Invalid Pub/Sub payload' }, { status: 400 });
	}
	if (!parsed?.emailAddress || !parsed?.historyId) {
		return json({ error: 'Invalid Pub/Sub payload' }, { status: 400 });
	}

	const email = String(parsed.emailAddress).trim().toLowerCase();
	const historyId = String(parsed.historyId).trim();
	console.log('pubsub-hook received', { email, history_id: historyId });

	const { data: connection } = await supabaseAdmin
		.from('gmail_connections')
		.select('*')
		.eq('email', email)
		.maybeSingle();

	if (!connection) {
		console.log('pubsub-hook skip-no-connection', { email });
		return json({ status: 'ignored' }, { status: 200 });
	}

	if (connection.mode === 'write') {
		console.log('pubsub-hook skip-write-mode', { email });
		return json({ status: 'skip' }, { status: 200 });
	}

	let accessToken;
	try {
		accessToken = await refreshAccessTokenIfNeeded(connection);
	} catch (err) {
		console.error('pubsub-hook refresh failed', err);
		return json({ error: err?.message ?? 'Token refresh failed' }, { status: 500 });
	}
	if (!accessToken) return json({ status: 'skip' }, { status: 200 });

	let storedHistoryId = connection.last_history_id ?? null;
	if (storedHistoryId && storedHistoryId.length >= 13) storedHistoryId = null;

	let historyResponse;
	try {
		historyResponse = await fetchHistory(accessToken, storedHistoryId ?? historyId);
	} catch (err) {
		if (err?.status === 404) {
			// History expired — reset cursor to current and acknowledge.
			const profile = await fetchProfile(accessToken);
			await supabaseAdmin
				.from('gmail_connections')
				.update({
					last_history_id: String(profile.historyId),
					updated_at: new Date().toISOString()
				})
				.eq('id', connection.id);
			return json({ status: 'reset' }, { status: 200 });
		}
		console.error('pubsub-hook history error', err);
		return json({ error: err?.message ?? 'history error' }, { status: 500 });
	}

	const messageIds = new Set();
	for (const item of historyResponse.history ?? []) {
		for (const msg of item.messagesAdded ?? []) {
			if (msg.message?.id) messageIds.add(msg.message.id);
		}
	}

	for (const messageId of messageIds) {
		try {
			await processMessage(accessToken, messageId);
		} catch (err) {
			console.error('pubsub-hook process-message-failed', { messageId, error: err?.message ?? 'unknown' });
		}
	}

	const newHistoryId = historyResponse.historyId ?? historyId;
	await supabaseAdmin
		.from('gmail_connections')
		.update({
			last_history_id: String(newHistoryId),
			updated_at: new Date().toISOString()
		})
		.eq('id', connection.id);

	console.log('pubsub-hook processed', { email, message_count: messageIds.size });
	return json({ status: 'ok' }, { status: 200 });
};
