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

	const notificationsData = loadNotificationsData(workspace.id, userId);
	const activityBundle = notificationsData.then(async (nd) => {
		const issueIds = [...new Set((nd.notifications ?? []).map((n) => n.issues?.id).filter(Boolean))];
		const [activityData, activityLogsData] = await Promise.all([
			loadActivityData(workspace.id, issueIds),
			loadActivityLogsData(workspace.id, issueIds)
		]);
		return { activityData, activityLogsData };
	});
	const vendors = loadVendors(workspace.id);

	return { notificationsData, activityBundle, vendors };
};
