// @ts-nocheck
import { redirect, error } from '@sveltejs/kit';
import { ensureWorkspace } from '$lib/server/workspaces';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals, params, depends, url }) => {
	depends('app:properties');
	depends('app:units');
	depends('app:workspace');
	if (!locals.user) {
		const returnTo = encodeURIComponent(`${url.pathname}${url.search}`);
		throw redirect(303, `/login?returnTo=${returnTo}`);
	}
	let userName =
		locals.user.user_metadata?.name ??
		locals.user.user_metadata?.full_name ??
		locals.user.email?.split('@')[0] ??
		'User';
	const [
		{
			data: { session }
		},
		,
		workspaceResp
	] = await Promise.all([
		locals.supabase.auth.getSession(),
		ensureWorkspace(locals.supabase, locals.user),
		supabaseAdmin
			.from('workspaces')
			.select('id, name, slug, admin_user_id, policy_learning_enabled')
			.eq('slug', params.workspace)
			.maybeSingle()
	]);

	// If the DB hasn't been migrated yet (missing columns), don't treat that as “workspace doesn't exist”.
	let workspaceBySlug = workspaceResp?.data ?? null;
	if (!workspaceBySlug && workspaceResp?.error) {
		const fallback = await supabaseAdmin
			.from('workspaces')
			.select('id, name, slug, admin_user_id')
			.eq('slug', params.workspace)
			.maybeSingle();
		workspaceBySlug = fallback?.data ?? null;
		if (workspaceBySlug && workspaceBySlug.policy_learning_enabled == null) {
			workspaceBySlug.policy_learning_enabled = false;
		}
	}
	if (workspaceBySlug?.id) {
		const { data: personProfile } = await supabaseAdmin
			.from('people')
			.select('name')
			.eq('workspace_id', workspaceBySlug.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		if (personProfile?.name?.trim()) {
			userName = personProfile.name.trim();
		}
	}

	if (workspaceBySlug?.admin_user_id === locals.user.id) {
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			workspaceBySlug.id,
			'admin',
			locals.user.id
		);
		const units = loadUnitsList(locals.supabase, supabaseAdmin, workspaceBySlug.id, 'admin');
		return {
			workspace: workspaceBySlug,
			properties,
			units,
			userId: locals.user.id,
			role: 'admin',
			ownerPersonId: null,
			session,
			userName
		};
	}
	const { data: memberWorkspace } = await supabaseAdmin
		.from('people')
		.select('id, role')
		.eq('user_id', locals.user.id)
		.eq('workspace_id', workspaceBySlug?.id ?? '')
		.maybeSingle();
	if (memberWorkspace?.role && workspaceBySlug?.id) {
		const normalizedRole = (memberWorkspace.role ?? '').toLowerCase();
		const ownerPersonId = normalizedRole === 'owner' ? (memberWorkspace.id ?? null) : null;
		let ownerTableId = null;
		if (normalizedRole === 'owner' && ownerPersonId) {
			const { data: ownerRec } = await supabaseAdmin
				.from('owners')
				.select('id')
				.eq('people_id', ownerPersonId)
				.eq('workspace_id', workspaceBySlug.id)
				.maybeSingle();
			ownerTableId = ownerRec?.id ?? null;
		}
		const properties = loadPropertiesList(
			locals.supabase,
			supabaseAdmin,
			workspaceBySlug.id,
			normalizedRole,
			ownerTableId
		);
		const units = loadUnitsList(
			locals.supabase,
			supabaseAdmin,
			workspaceBySlug.id,
			normalizedRole,
			ownerTableId
		);
		return {
			workspace: workspaceBySlug,
			properties,
			units,
			userId: locals.user.id,
			role: normalizedRole,
			session,
			userName,
			ownerPersonId: normalizedRole === 'owner' ? ownerPersonId : null
		};
	}
	// Check if the workspace slug exists at all
	if (!workspaceBySlug) {
		throw error(404, "This workspace doesn't exist.");
	}
	throw error(403, "You don't have access to this workspace.");
};

const addPropertyCounts = async (adminClient, properties, workspaceId) => {
	if (!Array.isArray(properties) || properties.length === 0) return properties ?? [];
	const propertyIds = properties.map((property) => property.id).filter(Boolean);
	if (propertyIds.length === 0) return properties;

	const [{ data: units }, { data: issues }] = await Promise.all([
		adminClient.from('units').select('id, property_id').in('property_id', propertyIds),
		workspaceId
			? adminClient
					.from('issues')
					.select('id, unit_id, property_id')
					.eq('workspace_id', workspaceId)
			: adminClient.from('issues').select('id, unit_id, property_id').in('property_id', propertyIds)
	]);

	const unitCounts = new Map();
	const unitToProperty = new Map();
	for (const unit of units ?? []) {
		if (!unit?.property_id || !unit?.id) continue;
		unitToProperty.set(unit.id, unit.property_id);
		unitCounts.set(unit.property_id, (unitCounts.get(unit.property_id) ?? 0) + 1);
	}

	const propertyIdSet = new Set(propertyIds);
	const issueCounts = new Map();
	for (const issue of issues ?? []) {
		const propertyId =
			(issue?.property_id && propertyIdSet.has(issue.property_id) ? issue.property_id : null) ??
			unitToProperty.get(issue?.unit_id) ??
			null;
		if (!propertyId) continue;
		issueCounts.set(propertyId, (issueCounts.get(propertyId) ?? 0) + 1);
	}

	return properties.map((property) => ({
		...property,
		unit_count: unitCounts.get(property.id) ?? 0,
		issue_count: issueCounts.get(property.id) ?? 0
	}));
};

const loadPropertiesList = async (supabase, adminClient, workspaceId, userRole, ownerTableId) => {
	const baseSelect =
		'id, name, address, city, state, postal_code, country, owner_properties(owner_id, owners(id, name))';
	const { data: properties, error: propertiesError } = await supabase
		.from('properties')
		.select(baseSelect)
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	if (!propertiesError) return addPropertyCounts(adminClient, properties ?? [], workspaceId);

	// Admin fallback: for owner role, filter via owner_properties
	if (userRole === 'owner' && ownerTableId) {
		const { data: ownerProps } = await adminClient
			.from('owner_properties')
			.select('property_id')
			.eq('owner_id', ownerTableId);
		const propertyIds = (ownerProps ?? []).map((op) => op.property_id);
		if (propertyIds.length === 0) return [];
		const { data: adminProperties } = await adminClient
			.from('properties')
			.select(baseSelect)
			.in('id', propertyIds)
			.order('name', { ascending: true });
		return addPropertyCounts(adminClient, adminProperties ?? [], workspaceId);
	}
	const { data: adminProperties } = await adminClient
		.from('properties')
		.select(baseSelect)
		.eq('workspace_id', workspaceId)
		.order('name', { ascending: true });
	return addPropertyCounts(adminClient, adminProperties ?? [], workspaceId);
};

const loadUnitsList = async (
	supabase,
	adminClient,
	workspaceId,
	userRole = null,
	ownerTableId = null
) => {
	const isOwner = (userRole ?? '').toLowerCase() === 'owner';
	const buildQuery = (client) => {
		return client
			.from('units')
			.select(
				'id, name, property_id, tenants(id, name, email, phone, unit_id), properties!inner(workspace_id)'
			)
			.eq('properties.workspace_id', workspaceId)
			.order('name', { ascending: true });
	};
	const { data: units, error: unitsError } = await buildQuery(supabase);
	const mappedUnits = (units ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		tenant: (unit.tenants ?? [])[0] ?? null,
		property_id: unit.property_id
	}));
	if (!unitsError) return mappedUnits;

	// Admin fallback: for owner role, filter via owner_properties
	if (isOwner && ownerTableId) {
		const { data: ownerProps } = await adminClient
			.from('owner_properties')
			.select('property_id')
			.eq('owner_id', ownerTableId);
		const propertyIds = (ownerProps ?? []).map((op) => op.property_id);
		if (propertyIds.length === 0) return [];
		const { data: adminUnits } = await adminClient
			.from('units')
			.select('id, name, property_id, tenants(id, name, email, phone, unit_id)')
			.in('property_id', propertyIds)
			.order('name', { ascending: true });
		return (adminUnits ?? []).map((unit) => ({
			id: unit.id,
			name: unit.name,
			tenant: (unit.tenants ?? [])[0] ?? null,
			property_id: unit.property_id
		}));
	}
	const { data: adminUnits } = await buildQuery(adminClient);
	return (adminUnits ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		tenant: (unit.tenants ?? [])[0] ?? null,
		property_id: unit.property_id
	}));
};
