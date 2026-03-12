// @ts-nocheck
import { redirect } from '@sveltejs/kit';

export const POST = async ({ locals, url }) => {
	await locals.supabase.auth.signOut();
	const next = url.searchParams.get('redirect');
	const safeNext = next && next.startsWith('/') ? next : '/login';
	throw redirect(303, safeNext);
};
