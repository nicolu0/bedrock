// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const workspaceSlug = body?.workspace ?? null;
	const type = typeof body?.type === 'string' ? body.type.trim() : '';
	const email = normalizeEmail(body?.email ?? '');
	const description = typeof body?.description === 'string' ? body.description.trim() : '';

	const allowedTypes = new Set(['allow', 'block', 'behavior']);
	if (!allowedTypes.has(type)) {
		return json({ error: 'Invalid policy type.' }, { status: 400 });
	}

	const requiresEmail = type === 'allow' || type === 'block';
	if (requiresEmail && !email) {
		return json({ error: 'Sender email is required for this policy.' }, { status: 400 });
	}
	if (email && !isValidEmail(email)) {
		return json({ error: 'Invalid sender email.' }, { status: 400 });
	}

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace access denied.' }, { status: 403 });

	const { data, error } = await supabaseAdmin
		.from('workspace_policies')
		.insert({
			workspace_id: workspace.id,
			type,
			email: email || null,
			description: description || null,
			created_by: locals.user.id,
			meta: { source: 'manual' }
		})
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });

	return json({
		id: data.id,
		type: data.type ?? 'behavior',
		email: data.email ?? '',
		description: data.description ?? '',
		meta: data.meta ?? null,
		createdAt: data.created_at ?? null,
		createdById: data.created_by ?? null,
		createdByName: data.users?.name ?? 'Unknown'
	});
};
