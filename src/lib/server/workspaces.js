/** @param {string} value */
const slugify = (value) => {
	const base = value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '');
	return base || 'workspace';
};

/** @param {any} supabaseAdmin @param {string} baseSlug */
const getAvailableSlug = async (supabaseAdmin, baseSlug) => {
	let slug = baseSlug;
	let suffix = 0;
	while (true) {
		const { data } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('slug', slug)
			.maybeSingle();
		if (!data) return slug;
		suffix += 1;
		slug = `${baseSlug}-${suffix}`;
	}
};

/** @param {any} supabase @param {any} user */
const ensureWorkspace = async (supabase, user) => {
	if (!user) return null;
	const name = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';
	await supabase.from('users').upsert({ id: user.id, name });
	const { supabaseAdmin } = await import('$lib/supabaseAdmin');
	const { data: existingWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, slug')
		.eq('admin_user_id', user.id)
		.maybeSingle();
	let workspace = existingWorkspace ?? null;
	if (!workspace) {
		// If the user is already a member somewhere (e.g. accepted an invite),
		// don't create a new workspace for them.
		const { data: existingMember } = await supabaseAdmin
			.from('members')
			.select('workspace_id, workspaces(id, slug)')
			.eq('user_id', user.id)
			.limit(1)
			.maybeSingle();
		if (existingMember?.workspaces) {
			return existingMember.workspaces;
		}

		const workspaceName = `${name} Workspace`;
		const baseSlug = slugify(workspaceName);
		const slug = await getAvailableSlug(supabaseAdmin, baseSlug);
		const { data: newWorkspace } = await supabaseAdmin
			.from('workspaces')
			.insert({ admin_user_id: user.id, name: workspaceName, slug })
			.select('id, slug')
			.single();
		workspace = newWorkspace ?? null;
	}
	if (workspace?.id) {
		await supabaseAdmin
			.from('members')
			.upsert(
				{ workspace_id: workspace.id, user_id: user.id, role: 'admin' },
				{ onConflict: 'workspace_id,user_id' }
			);
	}
	return workspace;
};

/** @param {any} supabase @param {any} user @param {string | null} slug */
const getWorkspaceForUser = async (supabase, user, slug = null) => {
	if (!user) return null;
	if (slug) {
		const { data } = await supabase
			.from('members')
			.select('workspace_id, workspaces!inner(id, name, slug, admin_user_id)')
			.eq('user_id', user.id)
			.eq('workspaces.slug', slug)
			.maybeSingle();
		return data?.workspaces ?? null;
	}
	const { data } = await supabase
		.from('members')
		.select('workspace_id, workspaces(id, name, slug, admin_user_id)')
		.eq('user_id', user.id)
		.limit(1)
		.maybeSingle();
	return data?.workspaces ?? null;
};

/** @param {string} workspaceSlug @param {string} userId */
const resolveWorkspace = async (workspaceSlug, userId) => {
	if (!workspaceSlug) return null;
	const { supabaseAdmin } = await import('$lib/supabaseAdmin');
	const { data: adminWorkspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, slug')
		.eq('slug', workspaceSlug)
		.eq('admin_user_id', userId)
		.maybeSingle();
	if (adminWorkspace?.id) return adminWorkspace;
	const { data: memberWorkspace } = await supabaseAdmin
		.from('members')
		.select('workspaces:workspaces(id, slug)')
		.eq('user_id', userId)
		.eq('workspaces.slug', workspaceSlug)
		.maybeSingle();
	return memberWorkspace?.workspaces ?? null;
};

export { ensureWorkspace, getWorkspaceForUser, resolveWorkspace, slugify };
