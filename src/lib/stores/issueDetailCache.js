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
