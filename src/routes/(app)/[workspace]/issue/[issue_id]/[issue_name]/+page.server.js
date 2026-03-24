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
			'id, name, description, status, urgent, parent_id, issue_number, readable_id, assignee_id, unit_id, property_id, properties(name), units(name, property_id, properties(name))'
		)
		.eq('workspace_id', workspace.id)
		.eq('readable_id', readableId)
		.maybeSingle()
		.then(async ({ data: issueRow, error: issueErr }) => {
			if (issueErr || !issueRow?.id) return null;
			const parentId = issueRow.parent_id ?? null;
			let rootUrgent = issueRow.urgent ?? false;
			let rootIssueId = issueRow.id;
			if (parentId) {
				const { data: parentRow } = await supabaseAdmin
					.from('issues')
					.select('id, urgent')
					.eq('id', parentId)
					.maybeSingle();
				rootUrgent = parentRow?.urgent ?? rootUrgent;
				rootIssueId = parentRow?.id ?? parentId;
			}
			const propertyId = issueRow.property_id ?? issueRow.units?.property_id ?? null;
			return {
				id: issueRow.id,
				name: issueRow.name,
				description: issueRow.description ?? null,
				status: issueRow.status,
				urgent: issueRow.urgent ?? false,
				parent_id: parentId,
				parentId,
				root_urgent: rootUrgent,
				rootIssueId,
				issueNumber: issueRow.issue_number ?? null,
				readableId: issueRow.readable_id ?? null,
				assignee_id: issueRow.assignee_id ?? null,
				assigneeId: issueRow.assignee_id ?? null,
				property: issueRow.units?.properties?.name ?? issueRow.properties?.name ?? null,
				unit: issueRow.units?.name ?? null,
				property_id: propertyId,
				propertyId,
				unit_id: issueRow.unit_id ?? null,
				unitId: issueRow.unit_id ?? null
			};
		});

	const subIssues = issueRowPromise.then(async (issue) => {
		if (!issue?.id) return [];
		const { data } = await supabaseAdmin
			.from('issues')
			.select(
				'id, name, description, status, urgent, parent_id, issue_number, readable_id, assignee_id, unit_id, property_id, properties(name), units(name, property_id, properties(name))'
			)
			.eq('parent_id', issue.id);
		return (data ?? []).map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description ?? null,
			status: s.status,
			urgent: s.urgent ?? false,
			issueNumber: s.issue_number ?? null,
			readableId: s.readable_id ?? null,
			assigneeId: s.assignee_id ?? null,
			assignee_id: s.assignee_id ?? null,
			parent_id: issue.id,
			property: s.units?.properties?.name ?? s.properties?.name ?? null,
			unit: s.units?.name ?? null,
			property_id: s.property_id ?? s.units?.property_id ?? null,
			propertyId: s.property_id ?? s.units?.property_id ?? null,
			unit_id: s.unit_id ?? null,
			unitId: s.unit_id ?? null
		}));
	});

	const activityData = Promise.all([issueRowPromise, subIssues]).then(([issue, subs]) => {
		if (!issue?.id) return null;
		const ids = [issue.id, ...(subs ?? []).map((s) => s.id).filter(Boolean)];
		return loadActivityData(workspace.id, ids);
	});
	const activityLogsData = Promise.all([issueRowPromise, subIssues]).then(([issue, subs]) => {
		if (!issue?.id) return null;
		const ids = [issue.id, ...(subs ?? []).map((s) => s.id).filter(Boolean)];
		return loadActivityLogsData(workspace.id, ids);
	});
	const members = loadPeopleMembers(workspace.id);
	const vendors = loadVendors(workspace.id);

	return { issue: issueRowPromise, subIssues, activityData, activityLogsData, members, vendors };
};
