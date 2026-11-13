import { writable } from 'svelte/store';

export const selectedDeviceId = writable<string | null>(null);
