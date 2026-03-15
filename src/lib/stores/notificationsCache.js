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

export const updateNotificationInCache = (notification) => {
	notificationsCache.update((state) => {
		if (!state.data?.notifications) return state;
		const notifications = state.data.notifications.map((n) =>
			n.id === notification.id ? { ...n, ...notification } : n
		);
		return { ...state, data: { ...state.data, notifications } };
	});
};
