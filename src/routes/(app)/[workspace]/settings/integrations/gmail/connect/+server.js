// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { GOOGLE_CLIENT_ID } from '$env/static/private';

export const GET = async ({ locals, params, url }) => {
	const user = locals.user;

	if (!user) {
		throw redirect(302, '/');
	}

	const redirectUri = `${url.origin}/api/gmail/callback`;
	const state = `${user.id}:${params.workspace}`;
	const paramsQuery = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope:
			'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
		access_type: 'offline',
		prompt: 'consent',
		state
	});

	throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${paramsQuery.toString()}`);
};
