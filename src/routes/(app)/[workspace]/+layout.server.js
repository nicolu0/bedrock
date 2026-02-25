// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
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

const loadUnitsList = async (supabase, adminClient, workspaceId) => {
	const { data: units, error: unitsError } = await supabase
		.from('units')
		.select('id, name, property_id, properties!inner(workspace_id)')
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!unitsError) {
		return (units ?? []).map((unit) => ({
			id: unit.id,
			name: unit.name,
			property_id: unit.property_id
		}));
	}
	const { data: adminUnits } = await adminClient
		.from('units')
		.select('id, name, property_id, properties!inner(workspace_id)')
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	return (adminUnits ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		property_id: unit.property_id
	}));
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
		const units = loadUnitsList(locals.supabase, supabaseAdmin, adminWorkspace.id);
		return { workspace: adminWorkspace, properties, units };
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
		const units = loadUnitsList(locals.supabase, supabaseAdmin, memberWorkspace.workspaces.id);
		return { workspace: memberWorkspace.workspaces, properties, units };
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
