// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const statusOrder = ['in_progress', 'todo', 'done'];
const allowedStatuses = new Set(statusOrder);

const loadIssue = async (workspaceId, issueId) => {
	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, description')
		.eq('id', issueId)
		.eq('workspace_id', workspaceId)
		.maybeSingle();

	return issue
		? {
				...issue,
				status: allowedStatuses.has(issue.status) ? issue.status : 'todo'
			}
		: null;
};

const loadSubIssues = async (workspaceId, issueId) => {
	const { data: subIssues } = await supabaseAdmin
		.from('issues')
		.select('id, name, status, parent_id')
		.eq('parent_id', issueId)
		.eq('workspace_id', workspaceId)
		.order('updated_at', { ascending: false });

	return (subIssues ?? []).map((subIssue) => ({
		...subIssue,
		status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
	}));
};

const loadAssignee = async (userId) => {
	const { data: assignee } = await supabaseAdmin
		.from('users')
		.select('id, name')
		.eq('id', userId)
		.maybeSingle();
	return assignee ?? null;
};

export const load = async ({ locals, params, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}

	const parentData = await parent();
	const workspaceId = parentData?.workspace?.id ?? null;
	if (!workspaceId) {
		return { issue: null, subIssues: [], assignee: null };
	}

	const issue = await loadIssue(workspaceId, params.issue_id);
	const subIssues = await loadSubIssues(workspaceId, params.issue_id);
	const assignee = await loadAssignee(locals.user.id);
	return { issue, subIssues, assignee };
};
