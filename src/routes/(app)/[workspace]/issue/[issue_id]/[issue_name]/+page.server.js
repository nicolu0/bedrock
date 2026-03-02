// @ts-nocheck
import { redirect } from '@sveltejs/kit';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const statusOrder = ['in_progress', 'todo', 'done'];
const allowedStatuses = new Set(statusOrder);

export const load = async ({ locals, params, parent }) => {
	if (!locals.user) {
		throw redirect(303, '/');
	}

	const issueId = params.issue_id;
	const userId = locals.user.id;

	const parentData = await parent();
	const workspaceId = parentData?.workspace?.id ?? null;

	if (!workspaceId) {
		return { issue: null, subIssues: [], assignee: null, userId };
	}

	const [{ data: issueData }, { data: fullSubIssues }, { data: fullAssignee }] =
		await Promise.all([
			supabaseAdmin
				.from('issues')
				.select('id, name, status')
				.eq('id', issueId)
				.eq('workspace_id', workspaceId)
				.maybeSingle(),
			supabaseAdmin
				.from('issues')
				.select('id, name, status, parent_id')
				.eq('parent_id', issueId)
				.eq('workspace_id', workspaceId)
				.order('updated_at', { ascending: false }),
			supabaseAdmin.from('users').select('id, name').eq('id', userId).maybeSingle()
		]);

	const issue = issueData
		? {
				...issueData,
				description: null,
				status: allowedStatuses.has(issueData.status) ? issueData.status : 'todo'
			}
		: null;

	const subIssues = (fullSubIssues ?? []).map((s) => ({
		...s,
		status: allowedStatuses.has(s.status) ? s.status : 'todo'
	}));

	return { issue, subIssues, assignee: fullAssignee, userId };
};
