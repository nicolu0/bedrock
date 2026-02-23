import { redirect } from '@sveltejs/kit';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const fetchTokens = async ({ code, redirectUri }) => {
	const body = new URLSearchParams({
		code,
		client_id: GOOGLE_CLIENT_ID,
		client_secret: GOOGLE_CLIENT_SECRET,
		redirect_uri: redirectUri,
		grant_type: 'authorization_code'
	});

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Token exchange failed: ${detail}`);
	}

	return response.json();
};

const fetchGmailProfile = async (accessToken) => {
	const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Profile fetch failed: ${detail}`);
	}

	return response.json();
};

const registerWatch = async (accessToken) => {
	const topicName = GMAIL_PUBSUB_TOPIC;
	if (!topicName) {
		throw new Error('Missing GMAIL_PUBSUB_TOPIC');
	}
	const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			topicName,
			labelIds: ['INBOX'],
			labelFilterAction: 'include'
		})
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Watch registration failed: ${detail}`);
	}

	return response.json();
};

export const GET = async ({ url }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');

	if (error) {
		return new Response(`OAuth error: ${error}`, { status: 400 });
	}

	if (!code || !state) {
		return new Response('Missing code or state', { status: 400 });
	}

	const redirectUri = `${url.origin}/agentmvp/api/gmail/callback`;
	const tokenData = await fetchTokens({ code, redirectUri });
	const profile = await fetchGmailProfile(tokenData.access_token);
	const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

	const { data: connectionRow, error: upsertError } = await supabaseAdmin
		.from('gmail_connections')
		.upsert({
			user_id: state,
			email: profile.emailAddress.toLowerCase(),
			access_token: tokenData.access_token,
			refresh_token: tokenData.refresh_token,
			expires_at: expiresAt,
			updated_at: new Date().toISOString()
		})
		.select('id')
		.single();

	if (upsertError) {
		return new Response(`Failed to store Gmail tokens: ${upsertError.message}`, { status: 500 });
	}

	let watch = null;
	try {
		watch = await registerWatch(tokenData.access_token);
	} catch (watchError) {
		await supabaseAdmin.from('ingestion_errors').insert({
			user_id: state,
			source: 'gmail-watch',
			detail: watchError instanceof Error ? watchError.message : 'Watch registration failed'
		});
	}

	await supabaseAdmin.from('email_ingestion_state').upsert({
		user_id: state,
		connection_id: connectionRow?.id ?? null,
		last_history_id: watch?.historyId ?? profile.historyId ?? null,
		watch_expires_at: watch?.expiration ? new Date(Number(watch.expiration)).toISOString() : null,
		updated_at: new Date().toISOString()
	});

	throw redirect(302, '/agentmvp');
};
