// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const { token } = await request.json();
	if (!token) return json({ error: 'Missing token' }, { status: 400 });

	// Look up invite
	const { data: invite } = await supabaseAdmin
		.from('invites')
		.select('*')
		.eq('token', token)
		.maybeSingle();

	if (!invite) return json({ error: 'Invite not found' }, { status: 404 });
	if (invite.accepted_at) return json({ error: 'Invite already used' }, { status: 400 });
	if (new Date(invite.expires_at) < new Date())
		return json({ error: 'Invite expired' }, { status: 400 });
	if (invite.email !== user.email)
		return json({ error: 'Invite email does not match your account' }, { status: 400 });

	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';

	// Upsert user profile
	await supabaseAdmin.from('users').upsert({ id: user.id, name });

	// Upsert person
	const { data: existingByUser } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', invite.workspace_id)
		.eq('user_id', user.id)
		.maybeSingle();

	let existingPersonId = existingByUser?.id ?? null;

	if (!existingPersonId && invite.people_id) {
		existingPersonId = invite.people_id;
	}

	if (!existingPersonId && invite.email) {
		const { data: existingPendingByEmail } = await supabaseAdmin
			.from('people')
			.select('id')
			.eq('workspace_id', invite.workspace_id)
			.eq('pending', true)
			.ilike('email', invite.email)
			.limit(1)
			.maybeSingle();
		existingPersonId = existingPendingByEmail?.id ?? null;
	}

	if (!existingPersonId && invite.email) {
		const { data: existingByEmail } = await supabaseAdmin
			.from('people')
			.select('id')
			.eq('workspace_id', invite.workspace_id)
			.ilike('email', invite.email)
			.limit(1)
			.maybeSingle();
		existingPersonId = existingByEmail?.id ?? null;
	}

	if (existingPersonId) {
		await supabaseAdmin
			.from('people')
			.update({
				role: invite.role,
				name,
				email: user.email ?? invite.email ?? null,
				user_id: user.id,
				pending: false
			})
			.eq('id', existingPersonId)
			.eq('workspace_id', invite.workspace_id);
	} else {
		await supabaseAdmin.from('people').insert({
			workspace_id: invite.workspace_id,
			user_id: user.id,
			role: invite.role,
			name,
			email: user.email ?? invite.email ?? null,
			pending: false
		});
	}

	// Mark invite as accepted
	await supabaseAdmin
		.from('invites')
		.update({ accepted_at: new Date().toISOString() })
		.eq('token', token);

	return json({
		profile: { id: user.id, name },
		workspace_id: invite.workspace_id,
		role: invite.role
	});
};
