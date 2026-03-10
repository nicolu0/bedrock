import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!supabaseUrl || !supabaseServiceKey) {
	throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
	auth: { persistSession: false, autoRefreshToken: false }
});

const registerWatch = async (accessToken: string) => {
	const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
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
		throw new Error(await response.text());
	}

	return response.json();
};

const refreshAccessToken = async (refreshToken: string) => {
	const body = new URLSearchParams({
		client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
		client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
		refresh_token: refreshToken,
		grant_type: 'refresh_token'
	});

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!response.ok) {
		throw new Error(await response.text());
	}

	return response.json();
};

const shouldRenew = (watchExpiresAt?: string | null, renewWithinMs = 48 * 60 * 60 * 1000) => {
	if (!watchExpiresAt) {
		return true;
	}

	const expiresAt = new Date(watchExpiresAt).getTime();
	if (Number.isNaN(expiresAt)) {
		return true;
	}

	return expiresAt - Date.now() < renewWithinMs;
};

serve(async () => {
	const { data: connections, error } = await supabase.from('gmail_connections').select('*');
	if (error) {
		return new Response(`Failed to load connections: ${error.message}`, { status: 500 });
	}

	const { data: ingestionState, error: ingestionError } = await supabase
		.from('email_ingestion_state')
		.select('connection_id, watch_expires_at');

	if (ingestionError) {
		return new Response(`Failed to load ingestion state: ${ingestionError.message}`, {
			status: 500
		});
	}

	const stateByConnectionId = new Map<string, { watch_expires_at: string | null }>();
	for (const state of ingestionState ?? []) {
		if (state.connection_id) {
			stateByConnectionId.set(state.connection_id, { watch_expires_at: state.watch_expires_at });
		}
	}

	for (const connection of connections ?? []) {
		try {
			if (connection.mode === 'write') {
				continue;
			}

			const state = stateByConnectionId.get(connection.id);
			if (state && !shouldRenew(state.watch_expires_at)) {
				continue;
			}

			let accessToken = connection.access_token;
			const expiresAt = new Date(connection.expires_at).getTime();
			const refreshNeeded = Number.isNaN(expiresAt) || expiresAt - Date.now() < 120000;

			if (refreshNeeded) {
				const refreshed = await refreshAccessToken(connection.refresh_token);
				accessToken = refreshed.access_token;
				const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
				await supabase
					.from('gmail_connections')
					.update({
						access_token: accessToken,
						expires_at: newExpiresAt,
						updated_at: new Date().toISOString()
					})
					.eq('id', connection.id);
			}

			const watch = await registerWatch(accessToken);
			await supabase.from('email_ingestion_state').upsert({
				user_id: connection.user_id,
				connection_id: connection.id,
				last_history_id: watch?.historyId ?? null,
				watch_expires_at: watch?.expiration
					? new Date(Number(watch.expiration)).toISOString()
					: null,
				updated_at: new Date().toISOString()
			});
		} catch (err) {
			await supabase.from('ingestion_errors').insert({
				user_id: connection.user_id,
				source: 'gmail-watch-renew',
				detail: err instanceof Error ? err.message : 'Unknown error'
			});
		}
	}

	return new Response(JSON.stringify({ status: 'ok' }), {
		headers: { 'Content-Type': 'application/json' }
	});
});
