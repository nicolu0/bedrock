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

	const { workspace } = await parent();
	const workspaceId = workspace?.id ?? null;
	if (!workspaceId) return { issueDetail: null };

	const issueDetail = (async () => {
		const [{ data: issue }, { data: subIssues }, { data: assignee }] = await Promise.all([
			supabaseAdmin
				.from('issues')
				.select('id, name, status, description')
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

		const normalizedIssue = issue
			? {
					...issue,
					status: allowedStatuses.has(issue.status) ? issue.status : 'todo'
				}
			: null;

		const normalizedSubIssues = (subIssues ?? []).map((subIssue) => ({
			...subIssue,
			status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
		}));

		return { issue: normalizedIssue, subIssues: normalizedSubIssues, assignee };
	})();

	return { issueDetail }; // streamed — navigation doesn't wait
};
