// @ts-nocheck
import { writable } from 'svelte/store';

const initialState = {
	workspace: null,
	data: null,
	loading: false,
	error: null,
	fetchedAt: 0
};

export const notificationsCache = writable(initialState);

export const addNotificationToCache = (notification) => {
	notificationsCache.update((state) => {
		if (!state.data?.notifications) return state;
		if (state.data.notifications.some((n) => n.id === notification.id)) return state;
		const notifications = [notification, ...state.data.notifications];
		return { ...state, data: { ...state.data, notifications } };
	});
};

export const updateNotificationInCache = (notification) => {
	notificationsCache.update((state) => {
		if (!state.data?.notifications) return state;
		const notifications = state.data.notifications.map((n) =>
			n.id === notification.id ? { ...n, ...notification } : n
		);
		return { ...state, data: { ...state.data, notifications } };
	});
};

export const primeNotificationsCache = (workspaceSlug, data) => {
	if (!workspaceSlug || !data) return;
	if (!Array.isArray(data.notifications)) return;
	notificationsCache.set({
		workspace: workspaceSlug,
		data,
		loading: false,
		error: null,
		fetchedAt: Date.now()
	});
};
