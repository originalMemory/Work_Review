import { writable, type Readable } from 'svelte/store';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface ToastState {
  id: number;
  message: string;
  type: ToastType;
}

export type ToastStore = Readable<ToastState | null>;

const { subscribe, set, update } = writable<ToastState | null>(null);

let toastId = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export const toast: ToastStore = {
  subscribe,
};

export function showToast(
  message: unknown,
  type: ToastType = 'info',
  duration = 3000,
): void {
  const normalizedMessage = typeof message === 'string' ? message.trim() : '';
  const normalizedLower = normalizedMessage.toLowerCase();

  if (
    !normalizedMessage ||
    normalizedLower === 'undefined' ||
    normalizedLower === 'null'
  ) {
    return;
  }

  toastId += 1;
  const currentId = toastId;

  set({
    id: currentId,
    message: normalizedMessage,
    type,
  });

  if (hideTimer) {
    clearTimeout(hideTimer);
  }

  hideTimer = setTimeout(() => {
    update((current) => (current?.id === currentId ? null : current));
    hideTimer = null;
  }, duration);
}

export function clearToast(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  set(null);
}
