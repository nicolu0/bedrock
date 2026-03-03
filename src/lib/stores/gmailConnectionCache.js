import { writable } from 'svelte/store';

// undefined = not yet loaded; null = loaded, no connection; object = loaded + connected
export const gmailConnectionCache = writable(undefined);

export const primeGmailConnectionCache = (data) => {
	gmailConnectionCache.set(data ?? null);
};
