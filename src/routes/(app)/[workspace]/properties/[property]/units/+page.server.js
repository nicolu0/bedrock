// @ts-nocheck
import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const slugify = (value) => {
	if (!value) return '';
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '');
};

export const load = async ({ parent, params, depends }) => {
	depends('app:units');

	const parentData = await parent();
	const { workspace } = parentData;

	// Resolve properties from parent (may be a streaming promise)
	const propertiesList = parentData.properties instanceof Promise
		? await parentData.properties
		: (parentData.properties ?? []);

	const propertySlug = params.property;
	const property = (Array.isArray(propertiesList) ? propertiesList : []).find(
		(p) => slugify(p.name) === propertySlug
	);

	if (!property?.id) {
		return { property: null, propertyUnits: [] };
	}

	const { data: units } = await supabaseAdmin
		.from('units')
		.select('id, name, property_id, tenants(id, name, email, unit_id)')
		.eq('property_id', property.id)
		.order('name', { ascending: true });

	const propertyUnits = (units ?? []).map((unit) => ({
		id: unit.id,
		name: unit.name,
		property_id: unit.property_id,
		tenant: (unit.tenants ?? [])[0] ?? null
	}));

	return { property, propertyUnits };
};

export const actions = {
	createUnit: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const name = form.get('name');
		const tenantName = form.get('tenantName');
		const tenantEmail = form.get('tenantEmail');
		const hasTenantInfo =
			(typeof tenantName === 'string' && tenantName.trim()) ||
			(typeof tenantEmail === 'string' && tenantEmail.trim());

		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Unit number is required.' });
		}

		// Resolve workspace
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('slug', params.workspace)
			.maybeSingle();
		if (!workspace?.id) return fail(403, { error: 'Workspace not found.' });

		// Resolve property by slug within workspace
		const { data: properties } = await supabaseAdmin
			.from('properties')
			.select('id, name')
			.eq('workspace_id', workspace.id);
		const property = (properties ?? []).find((p) => {
			const slug = p.name
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)+/g, '');
			return slug === params.property;
		});
		if (!property?.id) return fail(404, { error: 'Property not found.' });

		const { data, error } = await supabaseAdmin
			.from('units')
			.insert({
				property_id: property.id,
				name: name.trim()
			})
			.select('id, name')
			.single();

		if (error) return fail(500, { error: error.message });

		if (hasTenantInfo) {
			const { error: tenantError } = await supabaseAdmin.from('tenants').insert({
				unit_id: data.id,
				user_id: locals.user.id,
				name: typeof tenantName === 'string' && tenantName.trim() ? tenantName.trim() : null,
				email:
					typeof tenantEmail === 'string' && tenantEmail.trim()
						? tenantEmail.trim().toLowerCase()
						: null
			});
			if (tenantError) return fail(500, { error: tenantError.message });
		}
		return { unit: data };
	},
	updateUnit: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const unitId = form.get('unitId');
		const tenantId = form.get('tenantId');
		const name = form.get('name');
		const tenantName = form.get('tenantName');
		const tenantEmail = form.get('tenantEmail');
		const hasTenantInfo =
			(typeof tenantName === 'string' && tenantName.trim()) ||
			(typeof tenantEmail === 'string' && tenantEmail.trim());

		if (!unitId || typeof unitId !== 'string') {
			return fail(400, { error: 'Unit ID is required.' });
		}
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Unit number is required.' });
		}

		// Resolve workspace
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('slug', params.workspace)
			.maybeSingle();
		if (!workspace?.id) return fail(403, { error: 'Workspace not found.' });

		// Resolve property by slug within workspace
		const { data: properties } = await supabaseAdmin
			.from('properties')
			.select('id, name')
			.eq('workspace_id', workspace.id);
		const property = (properties ?? []).find((p) => {
			const slug = p.name
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)+/g, '');
			return slug === params.property;
		});
		if (!property?.id) return fail(404, { error: 'Property not found.' });

		const { data, error } = await supabaseAdmin
			.from('units')
			.update({
				name: name.trim()
			})
			.eq('id', unitId)
			.eq('property_id', property.id)
			.select('id, name')
			.single();

		if (error) return fail(500, { error: error.message });

		if (hasTenantInfo) {
			if (tenantId && typeof tenantId === 'string') {
				const { error: tenantError } = await supabaseAdmin
					.from('tenants')
					.update({
						name: typeof tenantName === 'string' && tenantName.trim() ? tenantName.trim() : null,
						email:
							typeof tenantEmail === 'string' && tenantEmail.trim()
								? tenantEmail.trim().toLowerCase()
								: null,
						updated_at: new Date().toISOString()
					})
					.eq('id', tenantId)
					.eq('unit_id', unitId);
				if (tenantError) return fail(500, { error: tenantError.message });
			} else {
				const { error: tenantError } = await supabaseAdmin.from('tenants').insert({
					unit_id: unitId,
					user_id: locals.user.id,
					name: typeof tenantName === 'string' && tenantName.trim() ? tenantName.trim() : null,
					email:
						typeof tenantEmail === 'string' && tenantEmail.trim()
							? tenantEmail.trim().toLowerCase()
							: null
				});
				if (tenantError) return fail(500, { error: tenantError.message });
			}
		} else if (tenantId && typeof tenantId === 'string') {
			const { error: tenantError } = await supabaseAdmin
				.from('tenants')
				.delete()
				.eq('id', tenantId)
				.eq('unit_id', unitId);
			if (tenantError) return fail(500, { error: tenantError.message });
		}
		return { unit: data };
	},
	deleteUnit: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const unitId = form.get('unitId');
		if (!unitId || typeof unitId !== 'string') {
			return fail(400, { error: 'Unit ID is required.' });
		}

		// Resolve workspace
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('slug', params.workspace)
			.maybeSingle();
		if (!workspace?.id) return fail(403, { error: 'Workspace not found.' });

		// Resolve property by slug within workspace
		const { data: properties } = await supabaseAdmin
			.from('properties')
			.select('id, name')
			.eq('workspace_id', workspace.id);
		const property = (properties ?? []).find((p) => {
			const slug = p.name
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/(^-|-$)+/g, '');
			return slug === params.property;
		});
		if (!property?.id) return fail(404, { error: 'Property not found.' });

		const { error: tenantError } = await supabaseAdmin
			.from('tenants')
			.delete()
			.eq('unit_id', unitId);
		if (tenantError) return fail(500, { error: tenantError.message });

		const { error } = await supabaseAdmin
			.from('units')
			.delete()
			.eq('id', unitId)
			.eq('property_id', property.id);
		if (error) return fail(500, { error: error.message });

		return { unitId };
	}
};
