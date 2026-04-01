// @ts-nocheck
import { writable } from 'svelte/store';

export const chatMessages = writable([]);

export const addChatMessage = (message) => {
	chatMessages.update((list) => [...list, message]);
};

export const clearChatMessages = () => {
	chatMessages.set([]);
};
