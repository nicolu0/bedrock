// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals }) => {
	if (!locals.user) {
		return {};
	}
	await ensureWorkspace(locals.supabase, locals.user);
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('slug')
		.eq('admin_user_id', locals.user.id)
		.maybeSingle();
	if (adminWorkspace?.slug) {
		throw redirect(303, `/${adminWorkspace.slug}`);
	}
	const workspace = await getWorkspaceForUser(locals.supabase, locals.user);
	if (workspace?.slug) {
		throw redirect(303, `/${workspace.slug}`);
	}
	return {};
};
