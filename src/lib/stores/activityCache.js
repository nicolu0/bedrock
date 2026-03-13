// @ts-nocheck
import { writable } from 'svelte/store';

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const activityCache = writable(initialState);

export const applyMessageDelta = (message) => {
	if (!message?.issue_id) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextMessagesByIssue = { ...data.messagesByIssue };
		const list = [...(nextMessagesByIssue[message.issue_id] ?? [])];
		const idx = list.findIndex((m) => m.id === message.id);
		if (idx >= 0) { list[idx] = { ...list[idx], ...message }; } else { list.push(message); }
		list.sort((a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0));
		nextMessagesByIssue[message.issue_id] = list;
		return { ...state, data: { ...data, messagesByIssue: nextMessagesByIssue } };
	});
};

export const applyDraftDelta = (draft) => {
	const key = draft?.message_id ?? draft?.id;
	if (!key) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextDrafts = { ...data.emailDraftsByMessageId, [key]: draft };
		const nextIssueIds = [...new Set(Object.values(nextDrafts).map((d) => d.issue_id).filter(Boolean))];
		return { ...state, data: { ...data, emailDraftsByMessageId: nextDrafts, draftIssueIds: nextIssueIds } };
	});
};

export const removeMessageFromCache = (message) => {
	if (!message?.issue_id) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextMessagesByIssue = { ...data.messagesByIssue };
		const list = (nextMessagesByIssue[message.issue_id] ?? []).filter((m) => m.id !== message.id);
		if (list.length) { nextMessagesByIssue[message.issue_id] = list; }
		else { delete nextMessagesByIssue[message.issue_id]; }
		return { ...state, data: { ...data, messagesByIssue: nextMessagesByIssue } };
	});
};

export const removeDraftFromCache = (draft) => {
	const key = draft?.message_id ?? draft?.id;
	if (!key) return;
	activityCache.update((state) => {
		const data = state.data ?? { messagesByIssue: {}, emailDraftsByMessageId: {}, draftIssueIds: [] };
		const nextDrafts = { ...data.emailDraftsByMessageId };
		delete nextDrafts[key];
		const nextIssueIds = [...new Set(Object.values(nextDrafts).map((d) => d.issue_id).filter(Boolean))];
		return { ...state, data: { ...data, emailDraftsByMessageId: nextDrafts, draftIssueIds: nextIssueIds } };
	});
};

export const primeActivityCache = (workspaceSlug, data) => {
	if (!data || !workspaceSlug) return;
	activityCache.set({ workspace: workspaceSlug, data, loading: false, error: null, fetchedAt: Date.now() });
};
