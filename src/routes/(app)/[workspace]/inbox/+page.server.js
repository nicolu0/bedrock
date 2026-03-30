// @ts-nocheck
import {
	loadNotificationsData,
	loadActivityData,
	loadActivityLogsData,
	loadVendors,
	loadPeople
} from '$lib/server/loaders';
import { supabaseAdmin } from '$lib/supabaseAdmin';

export const load = async ({ parent, depends }) => {
	depends('app:notifications');
	depends('app:activity');
	depends('app:activityLogs');
	depends('app:people');

	const { workspace, userId } = await parent();

	const notificationsData = loadNotificationsData(workspace.id, userId);
	const activityBundle = notificationsData.then(async (nd) => {
		const rootIssueIds = [
			...new Set((nd.notifications ?? []).map((n) => n.issues?.id).filter(Boolean))
		];
		// Also include subissue IDs so activity/logs for children appear in the panel
		let allIssueIds = rootIssueIds;
		if (rootIssueIds.length > 0) {
			const { data: subRows } = await supabaseAdmin
				.from('issues')
				.select('id')
				.in('parent_id', rootIssueIds);
			const subIds = (subRows ?? []).map((r) => r.id).filter(Boolean);
			allIssueIds = [...new Set([...rootIssueIds, ...subIds])];
		}
		const [activityData, activityLogsData] = await Promise.all([
			loadActivityData(workspace.id, allIssueIds),
			loadActivityLogsData(workspace.id, allIssueIds)
		]);
		return { activityData, activityLogsData };
	});
	const vendors = loadVendors(workspace.id);
	const people = loadPeople(workspace.id);

	return { notificationsData, activityBundle, vendors, people };
};
