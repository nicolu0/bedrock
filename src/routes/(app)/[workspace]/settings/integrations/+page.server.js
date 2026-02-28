// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, locals }) => {
	const gmailConnection = (async () => {
		const { workspace } = await parent();
		if (!locals.user || !workspace) return null;
		const { data } = await supabaseAdmin
			.from('gmail_connections')
			.select('id, email, expires_at, mode, updated_at')
			.eq('user_id', locals.user.id)
			.order('updated_at', { ascending: false })
			.limit(1)
			.maybeSingle();
		return data ?? null;
	})();

	return { gmailConnection };
};
