import { fail, redirect } from '@sveltejs/kit';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';

/** @type {import('./$types').PageServerLoad} */
export const load = async (event) => {
	const locals = /** @type {any} */ (event.locals);
	const { url } = event;
	if (!locals.user) {
		return { inviteToken: url.searchParams.get('invite') };
	}
	await ensureWorkspace(locals.supabase, locals.user);
	const workspace = await getWorkspaceForUser(locals.supabase, locals.user);
	if (workspace?.slug) {
		throw redirect(303, `/${workspace.slug}`);
	}
	throw redirect(303, '/agentmvp');
};

/** @type {import('./$types').Actions} */
export const actions = {
	login: async (event) => {
		const form = await event.request.formData();
		const locals = /** @type {any} */ (event.locals);
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
