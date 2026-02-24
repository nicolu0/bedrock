// @ts-nocheck
import { createServerClient } from '@supabase/ssr';
import { PUBLIC_SUPABASE_ANON_KEY, PUBLIC_SUPABASE_URL } from '$env/static/public';

export const handle = async ({ event, resolve }) => {
	const supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
		cookies: {
			get: (key) => event.cookies.get(key),
			set: (key, value, options) => event.cookies.set(key, value, { path: '/', ...options }),
			remove: (key, options) => event.cookies.delete(key, { path: '/', ...options })
		}
	});

	event.locals.supabase = supabase;

	const { data } = await supabase.auth.getUser();
	event.locals.user = data?.user ?? null;

	return resolve(event, {
		filterSerializedResponseHeaders: (name) =>
			name === 'content-range' || name === 'x-supabase-api-version'
	});
};
