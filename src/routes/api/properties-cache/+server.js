// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	let role = null;
	let ownerPersonId = null;
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id')
		.eq('id', workspace.id)
		.eq('admin_user_id', locals.user.id)
		.maybeSingle();
	if (adminWorkspace?.id) {
		role = 'admin';
	} else {
		const { data: member } = await supabaseAdmin
			.from('people')
			.select('id, role')
			.eq('workspace_id', workspace.id)
			.eq('user_id', locals.user.id)
			.maybeSingle();
		role = member?.role ? String(member.role).toLowerCase() : null;
		if (role === 'owner') ownerPersonId = member?.id ?? null;
	}
	if (!role) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	if (role === 'vendor') {
		return json([]);
	}

	let query = supabaseAdmin
		.from('properties')
		.select('id, name, address, city, state, postal_code, country, owner_id')
		.eq('workspace_id', workspace.id)
		.order('name', { ascending: true });
	if (role === 'owner') {
		query = query.eq('owner_id', ownerPersonId ?? '__none__');
	}
	const { data: properties } = await query;
	if (!Array.isArray(properties) || properties.length === 0) {
		return json(properties ?? []);
	}

	const propertyIds = properties.map((property) => property.id).filter(Boolean);
	const { data: units } = propertyIds.length
		? await supabaseAdmin.from('units').select('id, property_id').in('property_id', propertyIds)
		: { data: [] };

	const unitCounts = new Map();
	const unitToProperty = new Map();
	for (const unit of units ?? []) {
		if (!unit?.property_id || !unit?.id) continue;
		unitToProperty.set(unit.id, unit.property_id);
		unitCounts.set(unit.property_id, (unitCounts.get(unit.property_id) ?? 0) + 1);
	}

	const unitIds = Array.from(unitToProperty.keys());
	const { data: issues } = unitIds.length
		? await supabaseAdmin.from('issues').select('id, unit_id').in('unit_id', unitIds)
		: { data: [] };

	const issueCounts = new Map();
	for (const issue of issues ?? []) {
		const propertyId = unitToProperty.get(issue?.unit_id);
		if (!propertyId) continue;
		issueCounts.set(propertyId, (issueCounts.get(propertyId) ?? 0) + 1);
	}

	const withCounts = properties.map((property) => ({
		...property,
		unit_count: unitCounts.get(property.id) ?? 0,
		issue_count: issueCounts.get(property.id) ?? 0
	}));

	return json(withCounts);
};
