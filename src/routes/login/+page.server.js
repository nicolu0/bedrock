import { fail, redirect } from '@sveltejs/kit';

export const load = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/agentmvp');
	return { inviteToken: url.searchParams.get('invite') };
};

export const actions = {
	login: async ({ request, locals, url }) => {
		const form = await request.formData();
		const email = form.get('email');
		const password = form.get('password');
		const inviteToken = form.get('invite_token') || null;

		if (!email || !password) {
			return fail(400, { error: 'Email and password are required.' });
		}

		const { error } = await locals.supabase.auth.signInWithPassword({ email, password });
		if (error) return fail(400, { error: error.message });

		if (inviteToken) {
			throw redirect(303, `/accept-invite?token=${inviteToken}`);
		}
		throw redirect(303, '/agentmvp');
	}
};
