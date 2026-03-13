// @ts-nocheck
import { writable } from 'svelte/store';

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const peopleMembersCache = writable(initialState);

export const primePeopleMembersCache = (workspaceSlug, data) => {
	if (!workspaceSlug || !Array.isArray(data)) return;
	peopleMembersCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: Date.now()
	});
};
