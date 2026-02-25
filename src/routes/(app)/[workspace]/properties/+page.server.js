// @ts-nocheck
import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const resolveWorkspace = async (userId, workspaceSlug) => {
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, admin_user_id')
		.eq('slug', workspaceSlug)
		.maybeSingle();
	if (!adminWorkspace?.id) return null;
	if (adminWorkspace.admin_user_id === userId) {
		return adminWorkspace;
	}
	const { data: member } = await supabaseAdmin
		.from('members')
		.select('id')
		.eq('workspace_id', adminWorkspace.id)
		.eq('user_id', userId)
		.maybeSingle();
	if (!member?.id) return null;
	return adminWorkspace;
};

export const actions = {
	createProperty: async ({ request, locals, params }) => {
		if (!locals.user) throw redirect(303, '/');
		const form = await request.formData();
		const name = form.get('name');
		const address = form.get('address');
		const city = form.get('city');
		const state = form.get('state');
		const postalCode = form.get('postalCode');
		const country = form.get('country');
		if (!name || typeof name !== 'string' || !name.trim()) {
			return fail(400, { error: 'Property name is required.' });
		}
		if (!address || typeof address !== 'string' || !address.trim()) {
			return fail(400, { error: 'Address is required.' });
		}
		if (!city || typeof city !== 'string' || !city.trim()) {
			return fail(400, { error: 'City is required.' });
		}
		if (!state || typeof state !== 'string' || !state.trim()) {
			return fail(400, { error: 'State is required.' });
		}
		if (!postalCode || typeof postalCode !== 'string' || !postalCode.trim()) {
			return fail(400, { error: 'Postal code is required.' });
		}
		if (!country || typeof country !== 'string' || !country.trim()) {
			return fail(400, { error: 'Country is required.' });
		}
		const workspace = await resolveWorkspace(locals.user.id, params.workspace);
		if (!workspace?.id) {
			return fail(403, { error: 'Workspace access denied.' });
		}
		const { data, error } = await supabaseAdmin
			.from('properties')
			.insert({
				workspace_id: workspace.id,
				name: name.trim(),
				address: typeof address === 'string' && address.trim() ? address.trim() : null,
				city: typeof city === 'string' && city.trim() ? city.trim() : null,
				state: typeof state === 'string' && state.trim() ? state.trim() : null,
				postal_code: typeof postalCode === 'string' && postalCode.trim() ? postalCode.trim() : null,
				country: typeof country === 'string' && country.trim() ? country.trim() : null
			})
			.select('id, name')
			.single();
		if (error) {
			return fail(500, { error: error.message });
		}
		return { property: data };
	}
};
