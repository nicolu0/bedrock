// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	const { id } = await request.json();
	await supabaseAdmin.from('notifications').update({ is_read: true }).eq('id', id);
	return json({ success: true });
};
