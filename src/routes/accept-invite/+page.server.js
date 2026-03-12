// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ url, locals }) => {
	const token = url.searchParams.get('token');
	if (!token) throw redirect(303, '/');
	let inviteEmail = null;
	const { data: invite } = await supabaseAdmin
		.from('invites')
		.select('email, accepted_at, expires_at')
		.eq('token', token)
		.maybeSingle();
	if (invite && !invite.accepted_at && new Date(invite.expires_at) > new Date()) {
		inviteEmail = invite.email ?? null;
	}
	return { token, user: locals.user, inviteEmail };
};
