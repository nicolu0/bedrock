// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const statusOrder = ['in_progress', 'todo', 'done'];
const allowedStatuses = new Set(statusOrder);

export const load = async ({ locals, params, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}

	const parentData = await parent();
	const workspaceId = parentData?.workspace?.id ?? null;
	if (!workspaceId) {
		return { issue: null, subIssues: [], assignee: null };
	}

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, description')
		.eq('id', params.issue_id)
		.eq('workspace_id', workspaceId)
		.maybeSingle();

	const normalizedIssue = issue
		? {
				...issue,
				status: allowedStatuses.has(issue.status) ? issue.status : 'todo'
			}
		: null;

	const { data: subIssues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id')
		.eq('parent_id', params.issue_id)
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	const normalizedSubIssues = (subIssues ?? []).map((subIssue) => ({
		...subIssue,
		status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
	}));

	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', locals.user.id)
		.maybeSingle();

	return { issue: normalizedIssue, subIssues: normalizedSubIssues, assignee };
};
