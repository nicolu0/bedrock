// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent }) => {
	const vendors = (async () => {
		const { workspace } = await parent();
		const { data } = await supabaseAdmin
			.from('vendors')
			.select('id, name, email, trade, note, created_at')
			.eq('workspace_id', workspace.id)
			.order('name', { ascending: true });
		return data ?? [];
	})();

	return { vendors };
};
