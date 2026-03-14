import { browser } from '$app/environment';

const CACHE_KEYS = [
	'issues-cache-v4',
	'issueDetailCache-v2',
	'properties-cache-v2',
	'people-cache-v1',
	'people-cache-deleted-v1',
	'people-members-cache-v2',
	'activity-cache-v1',
	'activity-logs-cache-v1',
	'units-cache-v1',
	'notifications-cache-v1'
];

export const clearSessionCaches = () => {
	if (!browser) return;
	try {
		for (const key of CACHE_KEYS) {
			sessionStorage.removeItem(key);
		}
	} catch {
		// ignore remove failures
	}
};
