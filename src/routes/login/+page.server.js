// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';
import { actions as issueActions } from '$lib/server/issueDashboard';

export const actions = issueActions;

export const load = async ({ locals }) => {
	if (!locals.user) {
		return {};
	}
	await ensureWorkspace(locals.supabase, locals.user);
	const workspace = await getWorkspaceForUser(locals.supabase, locals.user);
	if (workspace?.slug) {
		throw redirect(303, `/${workspace.slug}`);
	}
	return {};
};
