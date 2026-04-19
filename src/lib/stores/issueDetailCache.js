// @ts-nocheck

/** @type {Map<string, { issue: any, subIssues: any[], fetchedAt: number }>} */
const memoryCache = new Map();

/** @type {Map<string, string>} readableId → issue.id */
const byReadableId = new Map();

/**
 * @param {any} issue
 * @param {any[]} subIssues
 */
export const seedIssueDetail = (issue, subIssues = []) => {
	if (!issue?.id) return;
	const rid = issue.readableId ?? issue.readable_id ?? null;
	const existing = memoryCache.get(issue.id);
	const resolvedVendorId =
		issue.vendorId ??
		issue.vendor_id ??
		existing?.issue?.vendorId ??
		existing?.issue?.vendor_id ??
		null;
	const resolvedVendorName = issue.vendorName ?? existing?.issue?.vendorName ?? null;
	const normalizedIssue = {
		id: issue.id,
		name: issue.name ?? issue.title,
		status: issue.status,
		urgent: issue.urgent ?? existing?.issue?.urgent ?? false,
		// Preserve an existing cached description if the incoming data doesn't
		// have one — section items from the issues list don't carry description,
		// and we don't want them to wipe a value set by a more complete fetch.
		description: issue.description ?? existing?.issue?.description ?? null,
		property: issue.property ?? null,
		unit: issue.unit ?? null,
		issueNumber: issue.issueNumber ?? null,
		readableId: rid,
		assignee_id: issue.assignee_id ?? issue.assigneeId ?? null,
		assigneeId: issue.assigneeId ?? issue.assignee_id ?? null,
		vendorId: resolvedVendorId,
		vendorName: resolvedVendorName
	};
	const normalizedSubIssues = (subIssues ?? []).map((s) => ({
		id: s.id,
		name: s.name ?? s.title,
		status: s.status,
		urgent: s.urgent ?? false,
		parent_id: issue.id,
		property: s.property ?? null,
		unit: s.unit ?? null,
		issueNumber: s.issueNumber ?? null,
		readableId: s.readableId ?? null,
		assignee_id: s.assignee_id ?? s.assigneeId ?? null,
		assigneeId: s.assigneeId ?? s.assignee_id ?? null,
		vendorId: s.vendorId ?? s.vendor_id ?? resolvedVendorId,
		vendorName: s.vendorName ?? resolvedVendorName
	}));
	memoryCache.set(issue.id, {
		issue: normalizedIssue,
		subIssues: normalizedSubIssues,
		fetchedAt: Date.now()
	});
	if (rid) byReadableId.set(rid, issue.id);
};

/**
 * @param {string} readableId
 */
export const getIssueDetailByReadableId = (readableId) => {
	if (!readableId) return null;
	const id = byReadableId.get(readableId);
	if (!id) return null;
	return memoryCache.get(id) ?? null;
};

/**
 * @param {string} id
 */
export const getIssueDetailById = (id) => {
	if (!id) return null;
	return memoryCache.get(id) ?? null;
};

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
		const subIssues = childrenByParentId.get(issue.id) ?? [];
		seedIssueDetail(issue, subIssues);
	}
};
