// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { workspace: workspaceSlug, name, address, city, state, postalCode, country, ownerId } = body;

	if (!name?.trim()) return json({ error: 'Property name is required.' }, { status: 400 });
	if (!address?.trim()) return json({ error: 'Address is required.' }, { status: 400 });
	if (!city?.trim()) return json({ error: 'City is required.' }, { status: 400 });
	if (!state?.trim()) return json({ error: 'State is required.' }, { status: 400 });
	if (!postalCode?.trim()) return json({ error: 'Postal code is required.' }, { status: 400 });
	if (!country?.trim()) return json({ error: 'Country is required.' }, { status: 400 });

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace access denied.' }, { status: 403 });

	const ownerIdValue = typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null;
	if (ownerIdValue) {
		const { data: ownerRow } = await supabaseAdmin
			.from('people')
			.select('id')
			.eq('id', ownerIdValue)
			.eq('workspace_id', workspace.id)
			.eq('role', 'owner')
			.maybeSingle();
		if (!ownerRow?.id) return json({ error: 'Owner not found.' }, { status: 400 });
	}

	const { data, error } = await supabaseAdmin
		.from('properties')
		.insert({
			workspace_id: workspace.id,
			name: name.trim(),
			address: address.trim(),
			city: city.trim(),
			state: state.trim(),
			postal_code: postalCode.trim(),
			country: country.trim(),
			owner_id: ownerIdValue
		})
		.select('id, name')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });
	return json(data);
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json();
	const { workspace: workspaceSlug, propertyId, name, address, city, state, postalCode, country, ownerId } = body;

	if (!propertyId) return json({ error: 'Property ID is required.' }, { status: 400 });
	if (!name?.trim()) return json({ error: 'Property name is required.' }, { status: 400 });
	if (!address?.trim()) return json({ error: 'Address is required.' }, { status: 400 });
	if (!city?.trim()) return json({ error: 'City is required.' }, { status: 400 });
	if (!state?.trim()) return json({ error: 'State is required.' }, { status: 400 });
	if (!postalCode?.trim()) return json({ error: 'Postal code is required.' }, { status: 400 });
	if (!country?.trim()) return json({ error: 'Country is required.' }, { status: 400 });

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace access denied.' }, { status: 403 });

	const ownerIdValue = typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : null;
	if (ownerIdValue) {
		const { data: ownerRow } = await supabaseAdmin
			.from('people')
			.select('id')
			.eq('id', ownerIdValue)
			.eq('workspace_id', workspace.id)
			.eq('role', 'owner')
			.maybeSingle();
		if (!ownerRow?.id) return json({ error: 'Owner not found.' }, { status: 400 });
	}

	const { data, error } = await supabaseAdmin
		.from('properties')
		.update({
			name: name.trim(),
			address: address.trim(),
			city: city.trim(),
			state: state.trim(),
			postal_code: postalCode.trim(),
			country: country.trim(),
			owner_id: ownerIdValue
		})
		.eq('id', propertyId)
		.eq('workspace_id', workspace.id)
		.select('id, name')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });
	return json(data);
};
