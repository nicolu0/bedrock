import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ locals }) => {
	const user = locals.user;
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Check if already bootstrapped
	const { data: existingMember } = await supabaseAdmin
		.from('members')
		.select('workspace_id, role')
		.eq('user_id', user.id)
		.maybeSingle();

	if (existingMember) {
		const { data: profile } = await supabaseAdmin
			.from('users')
			.select('id, name')
			.eq('id', user.id)
			.maybeSingle();
		return json({ profile, workspace_id: existingMember.workspace_id, role: existingMember.role });
	}

	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';

	// Create workspace
	const { data: workspace, error: workspaceError } = await supabaseAdmin
		.from('workspaces')
		.insert({ admin_user_id: user.id, name: `${name}'s Team`, slug: user.id })
		.select('id')
		.single();

	if (workspaceError) return json({ error: workspaceError.message }, { status: 500 });

	// Upsert user profile
	await supabaseAdmin.from('users').upsert({ id: user.id, name });

	// Add to members as admin
	const { data: existingMemberCheck } = await supabaseAdmin
		.from('members')
		.select('user_id')
		.eq('workspace_id', workspace.id)
		.eq('user_id', user.id)
		.maybeSingle();

	if (!existingMemberCheck) {
		await supabaseAdmin
			.from('members')
			.insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });
	}

	return json({ profile: { id: user.id, name }, workspace_id: workspace.id, role: 'admin' });
};
