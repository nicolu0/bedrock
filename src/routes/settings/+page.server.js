import { fail, redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const { data: member } = await supabaseAdmin
		.from('members')
		.select('workspace_id, role')
		.eq('user_id', locals.user.id)
		.maybeSingle();

	if (!member || member.role !== 'admin') throw redirect(303, '/agentmvp');

	const { data: members } = await supabaseAdmin
		.from('members')
		.select('user_id, role, users(name)')
		.eq('workspace_id', member.workspace_id);

	return { members: members ?? [] };
};

export const actions = {
	invite: async ({ request, locals, fetch }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });

		const form = await request.formData();
		const emails = form.getAll('email');
		const roles = form.getAll('role');

		const invites = emails
			.map((email, i) => ({ email: String(email).trim(), role: String(roles[i] ?? 'member') }))
			.filter(({ email }) => email);

		if (!invites.length) return fail(400, { error: 'No invites provided.' });

		const res = await fetch('/api/invites', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ invites })
		});

		const json = await res.json();
		if (!res.ok) return fail(res.status, { error: json.error ?? 'Failed to send invites.' });

		return { invited: json.invited };
	}
};
