// @ts-nocheck
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
		console.error('gmail-watch registerWatch failed', {
			status: response.status,
			detail
		});
		throw new Error(`Watch registration failed: ${detail}`);
	}

	return response.json();
};

export const GET = async ({ url }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');
	console.log('gmail-callback invoked', {
		hasCode: Boolean(code),
		hasState: Boolean(state),
		error
	});

	if (error) {
		return new Response(`OAuth error: ${error}`, { status: 400 });
	}

	if (!code || !state) {
		return new Response('Missing code or state', { status: 400 });
	}

	const redirectUri = `${url.origin}/api/gmail/callback`;
	const tokenData = await fetchTokens({ code, redirectUri });
	const profile = await fetchGmailProfile(tokenData.access_token);
	console.log('gmail-callback profile fetched', { email: profile?.emailAddress });
	const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
	const [userId, workspaceSlug] = state.split(':');

	const resolveWorkspaceIdForUser = async (slug, id) => {
		if (!slug || !id) return null;
		const { data: adminWorkspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('slug', slug)
			.eq('admin_user_id', id)
			.maybeSingle();
		console.log('gmail-callback workspace-check admin', {
			user_id: id,
			slug,
			workspace_id: adminWorkspace?.id ?? null
		});
		if (adminWorkspace?.id) return adminWorkspace.id;
		const { data: memberWorkspace, error: memberWorkspaceError } = await supabaseAdmin
			.from('people')
			.select('workspace_id, workspaces!inner(id, slug)')
			.eq('user_id', id)
			.eq('workspaces.slug', slug)
			.maybeSingle();
		console.log('gmail-callback workspace-check people', {
			user_id: id,
			slug,
			workspace_id: memberWorkspace?.workspaces?.id ?? null,
			error: memberWorkspaceError?.message ?? null
		});
		if (memberWorkspace?.workspaces?.id) return memberWorkspace.workspaces.id;
		const { data: membershipWorkspace, error: membershipWorkspaceError } = await supabaseAdmin
			.from('members')
			.select('workspace_id, workspaces!inner(id, slug)')
			.eq('user_id', id)
			.eq('workspaces.slug', slug)
			.maybeSingle();
		console.log('gmail-callback workspace-check members', {
			user_id: id,
			slug,
			workspace_id: membershipWorkspace?.workspaces?.id ?? null,
			error: membershipWorkspaceError?.message ?? null
		});
		return membershipWorkspace?.workspaces?.id ?? null;
	};

	console.log('gmail-callback state parsed', { user_id: userId, workspace_slug: workspaceSlug });
	const workspaceId = await resolveWorkspaceIdForUser(workspaceSlug, userId);
	if (!workspaceId) {
		return new Response('Workspace not found for user', { status: 400 });
	}

	const { data: existingConnection } = await supabaseAdmin
		.from('gmail_connections')
		.select('id, refresh_token')
		.eq('email', profile.emailAddress.toLowerCase())
		.maybeSingle();

	const connectionPayload = {
		user_id: userId,
		workspace_id: workspaceId,
		email: profile.emailAddress.toLowerCase(),
		access_token: tokenData.access_token,
		refresh_token: tokenData.refresh_token ?? existingConnection?.refresh_token ?? null,
		expires_at: expiresAt,
		updated_at: new Date().toISOString()
	};

	let connectionRow = null;
	let upsertError = null;
	if (existingConnection?.id) {
		const { data, error } = await supabaseAdmin
			.from('gmail_connections')
			.update(connectionPayload)
			.eq('id', existingConnection.id)
			.select('id')
			.single();
		connectionRow = data ?? null;
		upsertError = error ?? null;
	} else {
		const { data, error } = await supabaseAdmin
			.from('gmail_connections')
			.insert(connectionPayload)
			.select('id')
			.single();
		connectionRow = data ?? null;
		upsertError = error ?? null;
	}

	if (upsertError) {
		return new Response(`Failed to store Gmail tokens: ${upsertError.message}`, { status: 500 });
	}

	let watch = null;
	try {
		watch = await registerWatch(tokenData.access_token);
		console.log('gmail-callback watch registered', {
			historyId: watch?.historyId,
			expiration: watch?.expiration
		});
	} catch (watchError) {
		console.error('gmail-callback watch error', watchError);
		await supabaseAdmin
			.schema('errors')
			.from('ingestion_errors')
			.insert({
				user_id: userId,
				source: 'gmail-watch',
				detail: watchError instanceof Error ? watchError.message : 'Watch registration failed'
			});
	}

	if (connectionRow?.id) {
		await supabaseAdmin
			.from('gmail_connections')
			.update({
				last_history_id: watch?.historyId ?? profile.historyId ?? null,
				watch_expires_at: watch?.expiration
					? new Date(Number(watch.expiration)).toISOString()
					: null,
				updated_at: new Date().toISOString()
			})
			.eq('id', connectionRow.id);
	}

	if (workspaceSlug) {
		throw redirect(302, `/${workspaceSlug}/settings/integrations`);
	}
	throw redirect(302, '/');
};
