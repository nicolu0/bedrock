// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { ensureWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const loadPropertiesList = async (supabase, adminClient, workspaceId) => {
	const { data: properties, error: propertiesError } = await supabase
		.from('properties')
		.select('id, name')
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!propertiesError) {
		return properties ?? [];
	}
	const { data: adminProperties } = await adminClient
		.from('properties')
		.select('id, name')
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	return adminProperties ?? [];
};

export const load = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}
	await ensureWorkspace(locals.supabase, locals.user);
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, name, slug, admin_user_id')
		.eq('slug', params.workspace)
		.eq('admin_user_id', locals.user.id)
		.maybeSingle();
	if (adminWorkspace?.slug) {
		await supabaseAdmin
			.from('members')
			.upsert(
				{ workspace_id: adminWorkspace.id, user_id: locals.user.id, role: 'admin' },
				{ onConflict: 'workspace_id,user_id' }
			);
		const properties = loadPropertiesList(locals.supabase, supabaseAdmin, adminWorkspace.id);
		return { workspace: adminWorkspace, properties };
	}
	const { data: memberWorkspace } = await supabaseAdmin
		.from('members')
		.select('workspaces:workspaces(id, name, slug)')
		.eq('user_id', locals.user.id)
		.eq('workspaces.slug', params.workspace)
		.maybeSingle();
	if (memberWorkspace?.workspaces?.slug) {
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			memberWorkspace.workspaces.id
		);
		return { workspace: memberWorkspace.workspaces, properties };
	}
	const { data: fallback } = await supabaseAdmin
		.from('workspaces')
		.select('slug')
		.eq('admin_user_id', locals.user.id)
		.maybeSingle();
	if (fallback?.slug) {
		throw redirect(303, `/${fallback.slug}`);
	}
	throw redirect(303, '/');
};
