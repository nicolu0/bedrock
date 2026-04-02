// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const payload = await request.json().catch(() => null);
	const issueId = typeof payload?.issue_id === 'string' ? payload.issue_id : '';
	const template = typeof payload?.template === 'string' ? payload.template.trim() : '';

	if (!issueId || !template) {
		return json({ error: 'Missing auto policy fields.' }, { status: 400 });
	}

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, workspace_id')
		.eq('id', issueId)
		.maybeSingle();

	if (!issue?.workspace_id) {
		return json({ error: 'Issue not found.' }, { status: 404 });
	}

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', issue.workspace_id)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();
		if (!workspace?.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
	}

	const issueLabel = issue?.name?.toString().trim() || 'Maintenance issue';
	const meta = {
		source: 'draft-auto',
		maintenance_issue: issueLabel,
		template
	};

	const { data, error } = await supabaseAdmin
		.from('workspace_policies')
		.insert({
			workspace_id: issue.workspace_id,
			type: 'auto',
			email: null,
			description: 'Auto',
			created_by: locals.user.id,
			meta
		})
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });

	return json({
		policy: {
			id: data.id,
			type: data.type ?? 'auto',
			email: data.email ?? '',
			description: data.description ?? '',
			meta: data.meta ?? null,
			createdAt: data.created_at ?? null,
			createdById: data.created_by ?? null,
			createdByName: data.users?.name ?? 'Unknown'
		}
	});
};
