// @ts-nocheck
import { writable } from 'svelte/store';

export const chatMessages = writable([]);

export const chatStreaming = writable({ active: false, text: '' });

export const addChatMessage = (message) => {
	chatMessages.update((list) => [...list, message]);
};

export const setChatMessages = (messages) => {
	chatMessages.set(messages ?? []);
};

export const updateChatMessage = (id, updates) => {
	chatMessages.update((list) => list.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)));
};

export const clearChatMessages = () => {
	chatMessages.set([]);
};

export const startChatStreaming = () => {
	chatStreaming.set({ active: true, text: '' });
};

export const updateChatStreamingText = (text) => {
	chatStreaming.set({ active: true, text: text ?? '' });
};

export const stopChatStreaming = () => {
	chatStreaming.set({ active: false, text: '' });
};
