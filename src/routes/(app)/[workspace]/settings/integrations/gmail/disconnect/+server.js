// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const stopWatch = async ({ accessToken }) => {
	const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});
	return response;
};

const refreshAccessToken = async (refreshToken) => {
	const body = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID ?? '',
		client_secret: GOOGLE_CLIENT_SECRET ?? '',
		refresh_token: refreshToken,
		grant_type: 'refresh_token'
	});

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});

	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Token refresh failed: ${detail}`);
	}

	return response.json();
};

const logStopResult = async ({ userId, status, detail }) => {
	try {
		await supabaseAdmin
			.schema('errors')
			.from('ingestion_errors')
			.insert({ user_id: userId, source: 'gmail-stop', detail: `${status}: ${detail}` });
	} catch {
		// best effort
	}
};

export const POST = async ({ locals, params }) => {
	const user = locals.user;
	if (!user) {
		throw redirect(303, '/');
	}

	const { data: connection } = await supabaseAdmin
		.from('gmail_connections')
		.select('id, access_token, refresh_token, email')
		.eq('user_id', user.id)
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();

	if (!connection?.id) {
		throw redirect(303, `/${params.workspace}/settings/integrations`);
	}

	if (connection.access_token) {
		const stopResponse = await stopWatch({ accessToken: connection.access_token });
		if (stopResponse.ok) {
			await logStopResult({
				userId: user.id,
				status: 'stop_ok',
				detail: `Stopped watch for ${connection.email}`
			});
		} else if (connection.refresh_token) {
			try {
				const refreshed = await refreshAccessToken(connection.refresh_token);
				const refreshedStop = await stopWatch({ accessToken: refreshed.access_token });
				if (refreshedStop.ok) {
					await logStopResult({
						userId: user.id,
						status: 'stop_ok',
						detail: `Stopped watch after refresh for ${connection.email}`
					});
				} else {
					const detail = await refreshedStop.text();
					await logStopResult({
						userId: user.id,
						status: 'stop_failed',
						detail: `Stop failed after refresh: ${refreshedStop.status} ${detail}`
					});
				}
			} catch (err) {
				await logStopResult({
					userId: user.id,
					status: 'stop_failed',
					detail: err instanceof Error ? err.message : 'Stop failed after refresh'
				});
			}
		} else {
			const detail = await stopResponse.text();
			await logStopResult({
				userId: user.id,
				status: 'stop_failed',
				detail: `Stop failed: ${stopResponse.status} ${detail}`
			});
		}
	}

	await supabaseAdmin
		.from('gmail_connections')
		.delete()
		.eq('id', connection.id)
		.eq('user_id', user.id);

	throw redirect(303, `/${params.workspace}/settings/integrations`);
};
