import { writable, type Readable } from 'svelte/store';
import { t } from '$lib/i18n/index.ts';

export type ConfirmTone = 'info' | 'warning' | 'error';

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
}

export interface ConfirmDialogState {
  id: number;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  tone: ConfirmTone;
}

export type ConfirmDialogStore = Readable<ConfirmDialogState | null>;

const { subscribe, set } = writable<ConfirmDialogState | null>(null);

let currentId = 0;
let activeResolver: ((result: boolean) => void) | null = null;

export const confirmDialog: ConfirmDialogStore = {
  subscribe,
};

function closeWith(result: boolean): void {
  const resolver = activeResolver;
  activeResolver = null;
  set(null);
  resolver?.(result);
}

export function confirm(options: ConfirmOptions = {}): Promise<boolean> {
  if (activeResolver) {
    closeWith(false);
  }

  currentId += 1;

  const state: ConfirmDialogState = {
    id: currentId,
    title: options.title?.trim() || t('common.notice'),
    message: options.message?.trim() || '',
    confirmText: options.confirmText?.trim() || t('common.confirm'),
    cancelText: options.cancelText?.trim() || t('common.cancel'),
    tone: options.tone || 'info',
  };

  set(state);

  return new Promise<boolean>((resolve) => {
    activeResolver = resolve;
  });
}

export function resolveConfirm(result: boolean): void {
  closeWith(result);
}
