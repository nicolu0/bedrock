// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data: vendors } = await supabaseAdmin
		.from('people')
		.select('id, name, email, trade, notes, created_at')
		.eq('workspace_id', workspace.id)
		.eq('role', 'vendor')
		.order('name', { ascending: true });

	return json(vendors ?? []);
};

export const POST = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { workspace: workspaceSlug, name, email, trade, note } = body;

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data, error } = await supabaseAdmin
		.from('people')
		.insert({ workspace_id: workspace.id, name, email, trade, notes: note, role: 'vendor' })
		.select('id, name, email, trade, notes, created_at')
		.single();

	if (error) {
		return json({ error: error.message }, { status: 500 });
	}

	return json(data);
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = await request.json();
	const { id, workspace: workspaceSlug, name, email, trade, note } = body;

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const { data, error } = await supabaseAdmin
		.from('people')
		.update({ name, email, trade, notes: note, updated_at: new Date().toISOString() })
		.eq('id', id)
		.eq('workspace_id', workspace.id)
		.select('id, name, email, trade, notes, created_at')
		.single();

	if (error) {
		return json({ error: error.message }, { status: 500 });
	}

	return json(data);
};
