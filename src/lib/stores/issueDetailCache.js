// @ts-nocheck
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SESSION_KEY = 'issueDetailCache';

/** @type {Map<string, { issue: any, subIssues: any[], assignee: any, fetchedAt: number }>} */
const memoryCache = new Map();

const loadFromSession = () => {
	try {
		const raw = sessionStorage.getItem(SESSION_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		for (const [key, value] of Object.entries(parsed)) {
			if (!memoryCache.has(key)) {
				memoryCache.set(key, value);
			}
		}
	} catch {
		// ignore
	}
};

const saveToSession = () => {
	try {
		const obj = {};
		for (const [key, value] of memoryCache.entries()) {
			obj[key] = value;
		}
		sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj));
	} catch {
		// ignore (e.g. quota exceeded)
	}
};

let sessionLoaded = false;

/**
 * @param {string} issueId
 * @returns {{ issue: any, subIssues: any[], assignee: any } | null}
 */
export const getIssueDetail = (issueId) => {
	if (!sessionLoaded) {
		loadFromSession();
		sessionLoaded = true;
	}
	const entry = memoryCache.get(issueId);
	if (!entry) return null;
	if (Date.now() - entry.fetchedAt > CACHE_TTL) {
		memoryCache.delete(issueId);
		return null;
	}
	return { issue: entry.issue, subIssues: entry.subIssues, assignee: entry.assignee };
};

/**
 * @param {string} issueId
 * @param {{ issue: any, subIssues: any[], assignee: any }} data
 */
export const primeIssueDetail = (issueId, data) => {
	memoryCache.set(issueId, { ...data, fetchedAt: Date.now() });
	saveToSession();
};

/**
 * Pre-populates the detail cache from the flat issues list returned by /api/issues-cache.
 * Skips entries that are already fresh in the cache.
 * @param {any[]} issuesList
 */
export const primeDetailCacheFromIssuesList = (issuesList) => {
	if (!issuesList?.length) return;
	if (!sessionLoaded) {
		loadFromSession();
		sessionLoaded = true;
	}

	const childrenByParentId = new Map();
	for (const issue of issuesList) {
		if (!issue.parent_id) continue;
		if (!childrenByParentId.has(issue.parent_id)) childrenByParentId.set(issue.parent_id, []);
		childrenByParentId.get(issue.parent_id).push(issue);
	}

	const now = Date.now();
	for (const issue of issuesList) {
		const existing = memoryCache.get(issue.id);
		if (existing && now - existing.fetchedAt < CACHE_TTL) continue;
		const subIssues = (childrenByParentId.get(issue.id) ?? []).map((s) => ({
			id: s.id,
			name: s.name ?? s.title,
			status: s.status,
			parent_id: issue.id
		}));
		memoryCache.set(issue.id, {
			issue: { id: issue.id, name: issue.name ?? issue.title, status: issue.status, description: null },
			subIssues,
			assignee: null,
			fetchedAt: now
		});
	}
	saveToSession();
};

/**
 * Optimistically updates the status of an issue in the detail cache.
 * @param {string} issueId
 * @param {string} newStatus
 */
export const updateIssueStatusInDetailCache = (issueId, newStatus) => {
	const entry = memoryCache.get(issueId);
	if (!entry) return;
	memoryCache.set(issueId, { ...entry, issue: { ...entry.issue, status: newStatus } });
	saveToSession();
};
