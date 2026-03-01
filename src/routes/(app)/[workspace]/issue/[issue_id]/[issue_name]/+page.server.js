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

	const normalizedSubIssues = [];
	const assignee = null;

	// Streamed detail fetch for client-side seeding/cache priming
	const issueDetail = (async () => {
		const parentData = await parent();
		const workspaceId = parentData?.workspace?.id ?? null;
		if (!workspaceId) {
			return { issue: null, subIssues: [], assignee: null };
		}
		const [{ data: fullIssue }, { data: fullSubIssues }, { data: fullAssignee }] =
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

		const normalizedFullIssue = fullIssue
			? {
					...fullIssue,
					description: fullIssue?.description ?? null,
					status: allowedStatuses.has(fullIssue.status) ? fullIssue.status : 'todo'
				}
			: null;

		const normalizedFullSubIssues = (fullSubIssues ?? []).map((subIssue) => ({
			...subIssue,
			status: allowedStatuses.has(subIssue.status) ? subIssue.status : 'todo'
		}));

		return {
			issue: normalizedFullIssue,
			subIssues: normalizedFullSubIssues,
			assignee: fullAssignee
		};
	})();

	return {
		issue: null,
		subIssues: normalizedSubIssues,
		assignee,
		userId,
		issueDetail
	};
};
