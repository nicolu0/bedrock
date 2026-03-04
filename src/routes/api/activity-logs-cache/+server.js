// @ts-nocheck
import { json } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { resolveWorkspace } from '$lib/server/workspaces';

const ACTIVITY_WINDOW_DAYS = 30;

export const GET = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const workspaceSlug = url.searchParams.get('workspace');
	const workspace = await resolveWorkspace(workspaceSlug, locals.user.id);
	if (!workspace?.id) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const cutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const { data: logs } = await supabaseAdmin
		.from('activity_logs')
		.select('id, issue_id, workspace_id, type, from_email, to_emails, subject, body, data, created_by, created_at')
		.eq('workspace_id', workspace.id)
		.gte('created_at', cutoff)
		.order('created_at', { ascending: true });

	const logsByIssue = (logs ?? []).reduce((acc, log) => {
		if (!log.issue_id) return acc;
		if (!acc[log.issue_id]) acc[log.issue_id] = [];
		acc[log.issue_id].push(log);
		return acc;
	}, {});

	return json({ logsByIssue });
};
