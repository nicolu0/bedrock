// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
import { ensureWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

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
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			adminWorkspace.id,
			'admin',
			locals.user.id
		);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, adminWorkspace.id);
		return { workspace: adminWorkspace, properties, units, userId: locals.user.id };
	}
	const { data: memberWorkspace } = await supabaseAdmin
		.from('people')
		.select('role, workspaces:workspaces(id, name, slug)')
		.eq('user_id', locals.user.id)
		.eq('workspaces.slug', params.workspace)
		.maybeSingle();
	if (memberWorkspace?.workspaces?.slug) {
		let ownerPersonId = null;
		if (memberWorkspace.role === 'owner') {
			const { data: ownerPerson } = await supabaseAdmin
				.from('people')
				.select('id')
				.eq('workspace_id', memberWorkspace.workspaces.id)
				.eq('user_id', locals.user.id)
				.eq('role', 'owner')
				.maybeSingle();
			ownerPersonId = ownerPerson?.id ?? null;
		}
		const properties =
			memberWorkspace.role === 'owner' && !ownerPersonId
				? Promise.resolve([])
				: loadPropertiesList(
						locals.supabase,
						supabaseAdmin,
						memberWorkspace.workspaces.id,
						memberWorkspace.role,
						ownerPersonId ?? locals.user.id
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
const addPropertyCounts = async (adminClient, properties) => {
	if (!Array.isArray(properties) || properties.length === 0) return properties ?? [];
	const propertyIds = properties.map((property) => property.id).filter(Boolean);
	if (propertyIds.length === 0) return properties;

	const { data: units } = await adminClient
		.from('units')
		.select('id, property_id')
		.in('property_id', propertyIds);

	const unitCounts = new Map();
	const unitToProperty = new Map();
	for (const unit of units ?? []) {
		if (!unit?.property_id || !unit?.id) continue;
		unitToProperty.set(unit.id, unit.property_id);
		unitCounts.set(unit.property_id, (unitCounts.get(unit.property_id) ?? 0) + 1);
	}

	const unitIds = Array.from(unitToProperty.keys());
	const issueCounts = new Map();
	if (unitIds.length) {
		const { data: issues } = await adminClient
			.from('issues')
			.select('id, unit_id')
			.in('unit_id', unitIds);
		for (const issue of issues ?? []) {
			const propertyId = unitToProperty.get(issue?.unit_id);
			if (!propertyId) continue;
			issueCounts.set(propertyId, (issueCounts.get(propertyId) ?? 0) + 1);
		}
	}

	return properties.map((property) => ({
		...property,
		unit_count: unitCounts.get(property.id) ?? 0,
		issue_count: issueCounts.get(property.id) ?? 0
	}));
};

const loadPropertiesList = async (supabase, adminClient, workspaceId, userRole, userId) => {
	const buildQuery = (client) => {
		let q = client
			.from('properties')
			.select('id, name, address, city, state, postal_code, country, owner_id')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true });
		if (userRole === 'owner') {
			q = q.eq('owner_id', userId);
		}
		return q;
	};
	const { data: properties, error: propertiesError } = await buildQuery(supabase);
	if (!propertiesError) return addPropertyCounts(adminClient, properties ?? []);
	const { data: adminProperties } = await buildQuery(adminClient);
	return addPropertyCounts(adminClient, adminProperties ?? []);
};

const loadUnitsList = async (supabase, adminClient, workspaceId) => {
	const { data: units, error: unitsError } = await supabase
		.from('units')
		.select(
			'id, name, property_id, tenants(id, name, email, unit_id), properties!inner(workspace_id)'
		)
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!unitsError) {
		return (units ?? []).map((unit) => ({
			id: unit.id,
			name: unit.name,
			tenant: (unit.tenants ?? [])[0] ?? null,
			property_id: unit.property_id
		}));
	}
	const { data: adminUnits } = await adminClient
		.from('units')
		.select(
			'id, name, property_id, tenants(id, name, email, unit_id), properties!inner(workspace_id)'
		)
		.eq('properties.workspace_id', workspaceId)
		.order('name', { ascending: true });
	return (adminUnits ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		tenant: (unit.tenants ?? [])[0] ?? null,
		property_id: unit.property_id
	}));
};
