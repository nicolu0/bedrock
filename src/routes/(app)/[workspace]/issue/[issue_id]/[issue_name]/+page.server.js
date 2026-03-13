// @ts-nocheck
import { error } from '@sveltejs/kit';
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

	const { data: issueRow, error: issueErr } = await supabaseAdmin
		.from('issues')
		.select(
			'id, name, description, status, issue_number, readable_id, assignee_id, unit_id, units(name, properties(name))'
		)
		.eq('workspace_id', workspace.id)
		.eq('readable_id', readableId)
		.maybeSingle();

	if (issueErr) {
		console.error('[issue page server] fetch error:', issueErr);
		throw error(500, 'Failed to load issue');
	}
	if (!issueRow?.id) {
		throw error(404, 'Issue not found');
	}

	const issue = {
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

	const [subIssuesResult, activityData, activityLogsData, members, vendors] = await Promise.all([
		supabaseAdmin
			.from('issues')
			.select(
				'id, name, status, parent_id, issue_number, readable_id, assignee_id, units(name, properties(name))'
			)
			.eq('parent_id', issueRow.id),
		loadActivityData(workspace.id, [issueRow.id]),
		loadActivityLogsData(workspace.id, [issueRow.id]),
		loadPeopleMembers(workspace.id),
		loadVendors(workspace.id)
	]);

	const subIssues = (subIssuesResult.data ?? []).map((s) => ({
		id: s.id,
		name: s.name,
		status: s.status,
		issueNumber: s.issue_number ?? null,
		readableId: s.readable_id ?? null,
		assigneeId: s.assignee_id ?? null,
		assignee_id: s.assignee_id ?? null,
		parent_id: issueRow.id,
		property: s.units?.properties?.name ?? null,
		unit: s.units?.name ?? null
	}));

	return { issue, subIssues, activityData, activityLogsData, members, vendors };
};
