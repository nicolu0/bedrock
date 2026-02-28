// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
import { ensureWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const loadPropertiesList = async (supabase, adminClient, workspaceId, userRole, userId) => {
	const buildQuery = (client) => {
		let q = client
			.from('properties')
			.select('id, name, owner:users(name)')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true });
		if (userRole === 'property_owner') {
			q = q.eq('owner_id', userId);
		}
		return q;
	};
	const { data: properties, error: propertiesError } = await buildQuery(supabase);
	if (!propertiesError) return properties ?? [];
	const { data: adminProperties } = await buildQuery(adminClient);
	return adminProperties ?? [];
};

const loadUnitsList = async (supabase, adminClient, workspaceId) => {
	const { data: units, error: unitsError } = await supabase
		.from('units')
		.select('id, name, tenant_name, property_id, properties!inner(workspace_id)')
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!unitsError) {
		return (units ?? []).map((unit) => ({
			id: unit.id,
			name: unit.name,
			tenant_name: unit.tenant_name,
			property_id: unit.property_id
		}));
	}
	const { data: adminUnits } = await adminClient
		.from('units')
		.select('id, name, tenant_name, property_id, properties!inner(workspace_id)')
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	return (adminUnits ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		tenant_name: unit.tenant_name,
		property_id: unit.property_id
	}));
};

export const load = async ({ locals, params }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}
	const [, { data: adminWorkspace }] = await Promise.all([
		ensureWorkspace(locals.supabase, locals.user),
		supabaseAdmin
			.from('workspaces')
			.select('id, name, slug, admin_user_id')
			.eq('slug', params.workspace)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle()
	]);
	if (adminWorkspace?.slug) {
		supabaseAdmin
			.from('members')
			.upsert(
				{ workspace_id: adminWorkspace.id, user_id: locals.user.id, role: 'admin' },
				{ onConflict: 'workspace_id,user_id' }
			);
		const properties = loadPropertiesList(locals.supabase, supabaseAdmin, adminWorkspace.id, 'admin', locals.user.id);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, adminWorkspace.id);
		return { workspace: adminWorkspace, properties, units, userId: locals.user.id };
	}
	const { data: memberWorkspace } = await supabaseAdmin
		.from('members')
		.select('role, workspaces:workspaces(id, name, slug)')
		.eq('user_id', locals.user.id)
		.eq('workspaces.slug', params.workspace)
		.maybeSingle();
	if (memberWorkspace?.workspaces?.slug) {
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			memberWorkspace.workspaces.id,
			memberWorkspace.role,
			locals.user.id
		);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, memberWorkspace.workspaces.id);
		return { workspace: memberWorkspace.workspaces, properties, units, userId: locals.user.id };
	}
	// Check if the workspace slug exists at all
	const { data: existingWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('slug')
		.eq('slug', params.workspace)
		.maybeSingle();
	if (!existingWorkspace) {
		throw error(404, "This workspace doesn't exist.");
	}
	throw error(403, "You don't have access to this workspace.");
};
