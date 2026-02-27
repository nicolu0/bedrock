// @ts-nocheck
import { json } from '@sveltejs/kit';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';

export const GET = async () => {
	let host = PUBLIC_SUPABASE_URL;
	try {
		host = new URL(PUBLIC_SUPABASE_URL).host;
	} catch {
		// ignore parse errors
	}
	return json({ supabaseUrl: PUBLIC_SUPABASE_URL, host });
};
