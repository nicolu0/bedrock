// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const { workspace } = await parent();
	const user = locals.user;

	if (!user) {
		return { workspace, gmailConnection: null };
	}

	const { data: gmailConnection } = await supabaseAdmin
		.from('gmail_connections')
		.select('id, email, expires_at, mode, updated_at')
		.eq('user_id', user.id)
		.order('updated_at', { ascending: false })
		.limit(1)
		.maybeSingle();

	return { workspace, gmailConnection: gmailConnection ?? null };
};
