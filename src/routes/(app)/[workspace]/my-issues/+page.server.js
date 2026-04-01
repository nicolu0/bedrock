// @ts-nocheck
import { loadIssueReadsData, loadIssuesData, loadPeopleMembers } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:issues');
	depends('app:people');

	const parentData = await parent();
	const { workspace, userId, role, ownerPersonId } = parentData;

	const members = loadPeopleMembers(workspace.id);
	const issuesData = loadIssuesData(workspace.id, userId, role, ownerPersonId, {
		includeSubIssues: false,
		includeActivity: true
	}).then(async (payload) => {
		const issueIds = (payload?.issues ?? []).map((issue) => issue.id).filter(Boolean);
		const reads = await loadIssueReadsData(workspace.id, userId, issueIds);
		const issueReadsById = (reads?.issueReads ?? []).reduce((acc, row) => {
			if (!row?.issue_id) return acc;
			acc[row.issue_id] = row.last_seen_at ?? null;
			return acc;
		}, {});
		return { ...payload, issueReadsById, issueReadsUserId: userId };
	});

	return { issuesData, members };
};
