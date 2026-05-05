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
	const fallbackName = user.user_metadata?.name ?? user.email?.split('@')[0] ?? 'User';
	const { data: existingUser } = await supabase
		.from('users')
		.select('name')
		.eq('id', user.id)
		.maybeSingle();
	const resolvedName =
		existingUser?.name && existingUser.name.trim() ? existingUser.name : fallbackName;
	if (!existingUser?.name || !existingUser.name.trim()) {
		await supabase.from('users').upsert({ id: user.id, name: resolvedName });
	}
	const { supabaseAdmin } = await import('$lib/supabaseAdmin');
	// If the user is already a member somewhere (e.g. accepted an invite),
	// don't create a new workspace for them.
	const { data: existingMembers, error: memberError } = await supabaseAdmin
		.from('people')
		.select('workspace_id, updated_at, workspaces(id, slug)')
		.eq('user_id', user.id)
		.order('updated_at', { ascending: false })
		.limit(1);
	if (memberError) throw memberError;
	const existingMember = existingMembers?.[0] ?? null;
	if (existingMember?.workspaces) {
		return existingMember.workspaces;
	}
	const { data: adminWorkspaces, error: adminLookupError } = await supabaseAdmin
		.from('workspaces')
		.select('id, slug')
		.eq('admin_user_id', user.id)
		.order('created_at', { ascending: true })
		.limit(1);
	if (adminLookupError) throw adminLookupError;
	let workspace = adminWorkspaces?.[0] ?? null;
	if (!workspace) {
		const workspaceName = `${resolvedName} Workspace`;
		const baseSlug = slugify(workspaceName);
		const slug = await getAvailableSlug(supabaseAdmin, baseSlug);
		const { data: newWorkspace, error: insertError } = await supabaseAdmin
			.from('workspaces')
			.insert({ admin_user_id: user.id, name: workspaceName, slug })
			.select('id, slug')
			.single();
		if (insertError) throw insertError;
		workspace = newWorkspace ?? null;
	}
	return workspace;
};

/** @param {any} supabase @param {any} user @param {string | null} slug */
const getWorkspaceForUser = async (supabase, user, slug = null) => {
	if (!user) return null;
	if (slug) {
		const { data } = await supabase
			.from('people')
			.select('workspace_id, workspaces!inner(id, name, slug, admin_user_id)')
			.eq('user_id', user.id)
			.eq('workspaces.slug', slug)
			.maybeSingle();
		return data?.workspaces ?? null;
	}
	const { data } = await supabase
		.from('people')
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
	const { data: workspace } = await supabaseAdmin
		.from('workspaces')
		.select('id, slug, admin_user_id')
		.eq('slug', workspaceSlug)
		.maybeSingle();
	if (!workspace?.id) return null;
	if (workspace.admin_user_id === userId) return workspace;
	const { data: memberWorkspace } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('user_id', userId)
		.eq('workspace_id', workspace.id)
		.maybeSingle();
	if (memberWorkspace?.id) return workspace;
	return null;
};

export { ensureWorkspace, getWorkspaceForUser, resolveWorkspace, slugify };
