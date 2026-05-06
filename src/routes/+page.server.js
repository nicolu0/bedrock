// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { ensureWorkspace, getWorkspaceForUser } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async () => {
	return {};
};
