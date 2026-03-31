// @ts-nocheck
import { writable } from 'svelte/store';

const initialState = {
	open: false,
	type: 'chat',
	issueId: null,
	seedIssue: null,
	activityData: null,
	activityLogsData: null,
	vendors: [],
	people: [],
	allIssues: [],
	onClose: null,
	onResolved: null
};

export const rightPanel = writable(initialState);

export const openChatPanel = () => {
	rightPanel.update((state) => ({
		...state,
		open: true,
		type: 'chat',
		issueId: null,
		seedIssue: null,
		activityData: null,
		activityLogsData: null,
		vendors: [],
		people: [],
		allIssues: [],
		onClose: null,
		onResolved: null
	}));
};

export const toggleChatPanel = () => {
	rightPanel.update((state) => {
		if (state.open && state.type === 'chat') {
			return { ...state, open: false };
		}
		return {
			...state,
			open: true,
			type: 'chat',
			issueId: null,
			seedIssue: null,
			activityData: null,
			activityLogsData: null,
			vendors: [],
			people: [],
			allIssues: [],
			onClose: null,
			onResolved: null
		};
	});
};

export const openIssuePanel = ({
	issueId,
	seedIssue,
	activityData,
	activityLogsData,
	vendors,
	people,
	allIssues,
	onClose,
	onResolved
}) => {
	rightPanel.set({
		open: true,
		type: 'issue',
		issueId: issueId ?? null,
		seedIssue: seedIssue ?? null,
		activityData: activityData ?? null,
		activityLogsData: activityLogsData ?? null,
		vendors: vendors ?? [],
		people: people ?? [],
		allIssues: allIssues ?? [],
		onClose: onClose ?? null,
		onResolved: onResolved ?? null
	});
};

export const closePanel = () => {
	rightPanel.update((state) => ({ ...state, open: false }));
};
