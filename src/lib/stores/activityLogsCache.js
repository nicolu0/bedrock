// @ts-nocheck
import { writable } from 'svelte/store';

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const activityLogsCache = writable(initialState);

export const applyActivityLogDelta = (log) => {
	if (!log?.issue_id) return;
	activityLogsCache.update((state) => {
		const data = state.data ?? { logsByIssue: {} };
		const nextLogsByIssue = { ...data.logsByIssue };
		const list = [...(nextLogsByIssue[log.issue_id] ?? [])];
		const idx = list.findIndex((l) => l.id === log.id);
		if (idx >= 0) { list[idx] = { ...list[idx], ...log }; } else { list.push(log); }
		list.sort((a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0));
		nextLogsByIssue[log.issue_id] = list;
		return { ...state, data: { ...data, logsByIssue: nextLogsByIssue } };
	});
};

export const removeActivityLogFromCache = (log) => {
	if (!log?.issue_id) return;
	activityLogsCache.update((state) => {
		const data = state.data ?? { logsByIssue: {} };
		const nextLogsByIssue = { ...data.logsByIssue };
		const list = (nextLogsByIssue[log.issue_id] ?? []).filter((l) => l.id !== log.id);
		if (list.length) { nextLogsByIssue[log.issue_id] = list; }
		else { delete nextLogsByIssue[log.issue_id]; }
		return { ...state, data: { ...data, logsByIssue: nextLogsByIssue } };
	});
};

export const primeActivityLogsCache = (workspaceSlug, data) => {
	if (!data || !workspaceSlug) return;
	activityLogsCache.set({ workspace: workspaceSlug, data, loading: false, error: null, fetchedAt: Date.now() });
};
