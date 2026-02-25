import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/agentmvp');
	return { inviteToken: url.searchParams.get('invite') };
};

const bootstrap = async (user) => {
	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';

	const { data: existingMember } = await supabaseAdmin
		.from('members')
		.select('workspace_id')
		.eq('user_id', user.id)
		.maybeSingle();

	if (existingMember) return;

	// Must create public.users row first — workspaces.admin_user_id references it
	await supabaseAdmin.from('users').upsert({ id: user.id, name });

	const { data: workspace, error: workspaceError } = await supabaseAdmin
		.from('workspaces')
		.insert({ admin_user_id: user.id, name: `${name}'s Team`, slug: user.id })
		.select('id')
		.single();

	if (workspaceError) throw new Error(workspaceError.message);

	await supabaseAdmin.from('members').insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });
};

/** @returns {Promise<string|null>} workspace slug, or null if invite invalid */
const acceptInvite = async (user, token) => {
	const { data: invite } = await supabaseAdmin
		.from('invites')
		.select('*, workspaces(slug)')
		.eq('token', token)
		.maybeSingle();

	if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) return null;
	if (invite.email !== user.email) return null;

	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';
	await supabaseAdmin.from('users').upsert({ id: user.id, name });
	await supabaseAdmin.from('members').insert({ workspace_id: invite.workspace_id, user_id: user.id, role: invite.role });
	await supabaseAdmin.from('invites').update({ accepted_at: new Date().toISOString() }).eq('token', token);

	return invite.workspaces?.slug ?? null;
};

export const actions = {
	signup: async ({ request, locals, url }) => {
		const form = await request.formData();
		const name = form.get('name');
		const email = form.get('email');
		const password = form.get('password');
		const inviteToken = form.get('invite_token') || null;

		if (!name || !email || !password) {
			return fail(400, { error: 'All fields are required.' });
		}

		const { data, error } = await locals.supabase.auth.signUp({
			email,
			password,
			options: { data: { name } }
		});

		if (error) return fail(400, { error: error.message });
		if (!data.user) return fail(400, { error: 'Signup failed. Please try again.' });

		if (inviteToken) {
			const workspaceSlug = await acceptInvite(data.user, inviteToken);
			throw redirect(303, workspaceSlug ? `/${workspaceSlug}` : '/agentmvp');
		}

		await bootstrap(data.user);
		throw redirect(303, '/agentmvp');
	}
};
