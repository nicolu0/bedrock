// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';
import {
	loadActivityData,
	loadActivityLogsData,
	loadPeopleMembers,
	loadVendors
} from '$lib/server/loaders';

export const load = async ({ parent, params, depends }) => {
	depends('app:issues');
	depends('app:activity');
	depends('app:activityLogs');
	depends('app:people');

	const { workspace } = await parent();
	const readableId = params.issue_id;

	const issueRowPromise = supabaseAdmin
		.from('issues')
		.select(
			'id, name, description, status, issue_number, readable_id, assignee_id, unit_id, units(name, properties(name))'
		)
		.eq('workspace_id', workspace.id)
		.eq('readable_id', readableId)
		.maybeSingle()
		.then(({ data: issueRow, error: issueErr }) => {
			if (issueErr || !issueRow?.id) return null;
			return {
				id: issueRow.id,
				name: issueRow.name,
				description: issueRow.description ?? null,
				status: issueRow.status,
				issueNumber: issueRow.issue_number ?? null,
				readableId: issueRow.readable_id ?? null,
				assignee_id: issueRow.assignee_id ?? null,
				assigneeId: issueRow.assignee_id ?? null,
				property: issueRow.units?.properties?.name ?? null,
				unit: issueRow.units?.name ?? null
			};
		});

	const subIssues = issueRowPromise.then(async (issue) => {
		if (!issue?.id) return [];
		const { data } = await supabaseAdmin
			.from('issues')
			.select(
				'id, name, status, parent_id, issue_number, readable_id, assignee_id, units(name, properties(name))'
			)
			.eq('parent_id', issue.id);
		return (data ?? []).map((s) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			issueNumber: s.issue_number ?? null,
			readableId: s.readable_id ?? null,
			assigneeId: s.assignee_id ?? null,
			assignee_id: s.assignee_id ?? null,
			parent_id: issue.id,
			property: s.units?.properties?.name ?? null,
			unit: s.units?.name ?? null
		}));
	});

	const activityData = issueRowPromise.then((issue) =>
		issue?.id ? loadActivityData(workspace.id, [issue.id]) : null
	);
	const activityLogsData = issueRowPromise.then((issue) =>
		issue?.id ? loadActivityLogsData(workspace.id, [issue.id]) : null
	);
	const members = loadPeopleMembers(workspace.id);
	const vendors = loadVendors(workspace.id);

	return { issue: issueRowPromise, subIssues, activityData, activityLogsData, members, vendors };
};
