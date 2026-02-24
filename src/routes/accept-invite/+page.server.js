import { redirect } from '@sveltejs/kit';

export const load = async ({ url, locals }) => {
	const token = url.searchParams.get('token');
	if (!token) throw redirect(303, '/');
	return { token, user: locals.user };
};
