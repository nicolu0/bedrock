// @ts-nocheck
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const CHAT_PANEL_OPEN_KEY = 'bedrock.chatPanel.open';

const readChatPanelOpenPreference = () => {
	if (!browser || typeof window === 'undefined') return null;
	try {
		const raw = window.localStorage?.getItem(CHAT_PANEL_OPEN_KEY);
		if (raw === null) return null;
		if (raw === 'true') return true;
		if (raw === 'false') return false;
		return null;
	} catch {
		return null;
	}
};

const writeChatPanelOpenPreference = (open) => {
	if (!browser || typeof window === 'undefined') return;
	try {
		window.localStorage?.setItem(CHAT_PANEL_OPEN_KEY, open ? 'true' : 'false');
	} catch {
		// Ignore storage failures (private mode, disabled storage, etc.)
	}
};

export const getChatPanelPreferredOpen = () => {
	const saved = readChatPanelOpenPreference();
	return saved ?? true; // default open
};

const isMobileChatDisabled = () => {
	if (!browser || typeof window === 'undefined' || !window.matchMedia) return true;
	return window.matchMedia('(max-width: 639px)').matches;
};

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
	if (isMobileChatDisabled()) {
		rightPanel.update((state) => ({ ...state, open: false, type: 'chat' }));
		return;
	}
	writeChatPanelOpenPreference(true);
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

export const openChatPanelIfPreferred = () => {
	if (!getChatPanelPreferredOpen()) return;
	openChatPanel();
};

export const toggleChatPanel = () => {
	rightPanel.update((state) => {
		if (isMobileChatDisabled()) {
			if (state.open && state.type === 'chat') {
				return { ...state, open: false };
			}
			return state;
		}
		if (state.open && state.type === 'chat') {
			writeChatPanelOpenPreference(false);
			return { ...state, open: false };
		}
		writeChatPanelOpenPreference(true);
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
	// Note: most callsites close the issue panel; only persist when explicitly requested.
	rightPanel.update((state) => ({ ...state, open: false }));
};

export const closePanelPersistingChatPreference = () => {
	rightPanel.update((state) => {
		if (state?.type === 'chat') writeChatPanelOpenPreference(false);
		return { ...state, open: false };
	});
};
