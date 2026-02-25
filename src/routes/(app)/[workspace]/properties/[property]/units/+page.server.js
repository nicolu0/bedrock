// @ts-nocheck
import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const actions = {
	createUnit: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const name = form.get('name');
		const tenantName = form.get('tenantName');
		const vacant = form.get('vacant') === 'true';

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
				name: name.trim(),
				tenant_name: !vacant && tenantName && tenantName.trim() ? tenantName.trim() : null
			})
			.select('id, name')
			.single();

		if (error) return fail(500, { error: error.message });
		return { unit: data };
	}
};
