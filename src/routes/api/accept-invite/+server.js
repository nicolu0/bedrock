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
	if (new Date(invite.expires_at) < new Date()) return json({ error: 'Invite expired' }, { status: 400 });
	if (invite.email !== user.email) return json({ error: 'Invite email does not match your account' }, { status: 400 });

	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';

	// Upsert user profile
	await supabaseAdmin.from('users').upsert({ id: user.id, name });

	// Upsert member
	const { data: existingMember } = await supabaseAdmin
		.from('members')
		.select('user_id')
		.eq('workspace_id', invite.workspace_id)
		.eq('user_id', user.id)
		.maybeSingle();

	if (existingMember) {
		await supabaseAdmin
			.from('members')
			.update({ role: invite.role })
			.eq('workspace_id', invite.workspace_id)
			.eq('user_id', user.id);
	} else {
		await supabaseAdmin
			.from('members')
			.insert({ workspace_id: invite.workspace_id, user_id: user.id, role: invite.role });
	}

	// Mark invite as accepted
	await supabaseAdmin
		.from('invites')
		.update({ accepted_at: new Date().toISOString() })
		.eq('token', token);

	return json({ profile: { id: user.id, name }, workspace_id: invite.workspace_id, role: invite.role });
};
