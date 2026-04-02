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
	const urgency = typeof body?.urgency === 'string' ? body.urgency.trim() : '';
	const maintenanceIssue =
		typeof body?.maintenance_issue === 'string' ? body.maintenance_issue.trim() : '';
	const template = typeof body?.template === 'string' ? body.template.trim() : '';

	const allowedTypes = new Set(['urgency', 'auto']);
	if (!allowedTypes.has(type)) {
		return json({ error: 'Invalid policy type.' }, { status: 400 });
	}
	if (email && !isValidEmail(email)) {
		return json({ error: 'Invalid sender email.' }, { status: 400 });
	}

	const allowedUrgency = new Set(['urgent', 'not_urgent']);
	if (type === 'urgency' && urgency && !allowedUrgency.has(urgency)) {
		return json({ error: 'Invalid urgency value.' }, { status: 400 });
	}
	if (!maintenanceIssue) {
		return json({ error: 'Maintenance issue is required.' }, { status: 400 });
	}
	if (type === 'auto' && !template) {
		return json({ error: 'Template is required.' }, { status: 400 });
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
			meta: {
				source: 'manual',
				urgency: type === 'urgency' ? urgency || null : null,
				maintenance_issue: maintenanceIssue || null,
				template: type === 'auto' ? template || null : null
			}
		})
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });

	return json({
		id: data.id,
		type: data.type ?? 'urgency',
		email: data.email ?? '',
		description: data.description ?? '',
		meta: data.meta ?? null,
		createdAt: data.created_at ?? null,
		createdById: data.created_by ?? null,
		createdByName: data.users?.name ?? 'Unknown'
	});
};

export const PATCH = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => null);
	const workspaceSlug = body?.workspace ?? null;
	const policyId = typeof body?.id === 'string' ? body.id.trim() : '';
	const type = typeof body?.type === 'string' ? body.type.trim() : '';
	const urgency = typeof body?.urgency === 'string' ? body.urgency.trim() : '';
	const maintenanceIssue =
		typeof body?.maintenance_issue === 'string' ? body.maintenance_issue.trim() : '';
	const template = typeof body?.template === 'string' ? body.template.trim() : '';

	if (!policyId) {
		return json({ error: 'Policy id is required.' }, { status: 400 });
	}

	const allowedTypes = new Set(['urgency', 'auto']);
	if (!allowedTypes.has(type)) {
		return json({ error: 'Invalid policy type.' }, { status: 400 });
	}

	const allowedUrgency = new Set(['urgent', 'not_urgent']);
	if (type === 'urgency' && urgency && !allowedUrgency.has(urgency)) {
		return json({ error: 'Invalid urgency value.' }, { status: 400 });
	}
	if (!maintenanceIssue) {
		return json({ error: 'Maintenance issue is required.' }, { status: 400 });
	}
	if (type === 'auto' && !template) {
		return json({ error: 'Template is required.' }, { status: 400 });
	}

	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) return json({ error: 'Workspace access denied.' }, { status: 403 });

	const { data: existing, error: existingError } = await supabaseAdmin
		.from('workspace_policies')
		.select('id, meta')
		.eq('id', policyId)
		.eq('workspace_id', workspace.id)
		.maybeSingle();

	if (existingError) return json({ error: existingError.message }, { status: 500 });
	if (!existing?.id) return json({ error: 'Policy not found.' }, { status: 404 });

	const meta = {
		...(existing.meta ?? {}),
		urgency: type === 'urgency' ? urgency || null : null,
		maintenance_issue: maintenanceIssue || null,
		template: type === 'auto' ? template || null : null
	};

	const { data, error } = await supabaseAdmin
		.from('workspace_policies')
		.update({
			type,
			email: null,
			description: null,
			meta
		})
		.eq('id', policyId)
		.eq('workspace_id', workspace.id)
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });

	return json({
		id: data.id,
		type: data.type ?? 'urgency',
		email: data.email ?? '',
		description: data.description ?? '',
		meta: data.meta ?? null,
		createdAt: data.created_at ?? null,
		createdById: data.created_by ?? null,
		createdByName: data.users?.name ?? 'Unknown'
	});
};
