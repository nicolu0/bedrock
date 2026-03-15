// @ts-nocheck

/** @type {Map<string, { issue: any, subIssues: any[], assignee: any, fetchedAt: number }>} */
const memoryCache = new Map();

/**
 * Pre-populates the detail cache from the flat issues list.
 * @param {any[]} issuesList
 */
export const primeDetailCacheFromIssuesList = (issuesList) => {
	if (!issuesList?.length) return;

	const childrenByParentId = new Map();
	for (const issue of issuesList) {
		if (!issue.parent_id) continue;
		if (!childrenByParentId.has(issue.parent_id)) childrenByParentId.set(issue.parent_id, []);
		childrenByParentId.get(issue.parent_id).push(issue);
	}

	for (const issue of issuesList) {
		const subIssues = (childrenByParentId.get(issue.id) ?? []).map((s) => ({
			id: s.id,
			name: s.name ?? s.title,
			status: s.status,
			parent_id: issue.id,
			property: s.property ?? null,
			unit: s.unit ?? null,
			issueNumber: s.issueNumber ?? null,
			readableId: s.readableId ?? null
		}));
		memoryCache.set(issue.id, {
			issue: {
				id: issue.id,
				name: issue.name ?? issue.title,
				status: issue.status,
				description: issue.description ?? null,
				property: issue.property ?? null,
				unit: issue.unit ?? null,
				issueNumber: issue.issueNumber ?? null,
				readableId: issue.readableId ?? null
			},
			subIssues,
			assignee: null,
			fetchedAt: Date.now()
		});
	}
};
