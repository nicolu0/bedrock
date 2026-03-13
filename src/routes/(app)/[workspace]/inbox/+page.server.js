// @ts-nocheck
import {
	loadNotificationsData,
	loadActivityData,
	loadActivityLogsData,
	loadVendors
} from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:notifications');
	depends('app:activity');
	depends('app:activityLogs');
	depends('app:people');

	const { workspace, userId } = await parent();

	const [notificationsData, vendors] = await Promise.all([
		loadNotificationsData(workspace.id, userId),
		loadVendors(workspace.id)
	]);

	const issueIds = (notificationsData.notifications ?? [])
		.map((n) => n.issues?.id)
		.filter(Boolean);

	const uniqueIssueIds = [...new Set(issueIds)];

	const [activityData, activityLogsData] = await Promise.all([
		loadActivityData(workspace.id, uniqueIssueIds),
		loadActivityLogsData(workspace.id, uniqueIssueIds)
	]);

	return { notificationsData, activityData, activityLogsData, vendors };
};
