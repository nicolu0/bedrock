// @ts-nocheck
import { fail, redirect } from '@sveltejs/kit';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

/** @type {import('./$types').PageServerLoad} */
export const load = async ({ locals, url }) => {
	if (!locals.user) {
		const inviteToken = url.searchParams.get('invite');
		let inviteEmail = null;
		let inviteName = null;
		if (inviteToken) {
			const { data: invite } = await supabaseAdmin
				.from('invites')
				.select('email, accepted_at, expires_at, workspace_id')
				.eq('token', inviteToken)
				.maybeSingle();
			if (invite && !invite.accepted_at && new Date(invite.expires_at) > new Date()) {
				inviteEmail = invite.email ?? null;
				if (invite.workspace_id && invite.email) {
					const { data: person } = await supabaseAdmin
						.from('people')
						.select('name')
						.eq('workspace_id', invite.workspace_id)
						.eq('pending', true)
						.ilike('email', invite.email)
						.maybeSingle();
					inviteName = person?.name ?? null;
				}
			}
		}
		return { inviteToken, inviteEmail, inviteName };
	}
	await ensureWorkspace(locals.supabase, locals.user);
	const workspace = await getWorkspaceForUser(locals.supabase, locals.user);
	if (workspace?.slug) {
		throw redirect(303, `/${workspace.slug}`);
	}
	throw redirect(303, '/');
};

/** @type {import('./$types').Actions} */
export const actions = {
	login: async ({ request, locals }) => {
		const form = await request.formData();
		const email = form.get('email');
		const password = form.get('password');
		const inviteToken = form.get('invite_token') || null;

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required.' });
		}

		const { data: authData, error } = await locals.supabase.auth.signInWithPassword({
			email,
			password
		});
		if (error) return fail(400, { error: error.message });

		if (inviteToken) {
			throw redirect(303, `/accept-invite?token=${inviteToken}`);
		}

		const workspace = await ensureWorkspace(locals.supabase, authData.user);
		if (workspace?.slug) {
			throw redirect(303, `/${workspace.slug}`);
		}
		throw redirect(303, '/');
	}
};
