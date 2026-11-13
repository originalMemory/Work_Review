import { t } from '../i18n/index.ts';

export interface AvatarSettingsConfig {
  avatar_enabled?: unknown;
  break_reminder_enabled?: unknown;
  avatar_scale?: unknown;
  avatar_opacity?: unknown;
}

export type AvatarConfigSaver<TConfig> = (config: TConfig) => void | PromiseLike<void>;

export interface AvatarToggleUiState {
  trackClass: string;
  thumbClass: string;
  buttonClass: string;
  ariaLabel: string;
}

export const AVATAR_SCALE_MIN = 0.4;
export const AVATAR_SCALE_MAX = 1.3;
export const AVATAR_SCALE_DEFAULT = 0.9;
export const AVATAR_OPACITY_MIN = 0.45;
export const AVATAR_OPACITY_MAX = 1;
export const AVATAR_OPACITY_DEFAULT = 0.82;

export function getAvatarToggleToast(enabled: boolean): string {
  return enabled
    ? t('settingsAppearance.avatarShownToast')
    : t('settingsAppearance.avatarHiddenToast');
}

export function getAvatarToggleUiState(
  enabled: boolean,
  saving = false,
): AvatarToggleUiState {
  return {
    trackClass: enabled
      ? 'bg-primary-500 hover:bg-primary-500/90'
      : 'bg-slate-300 hover:bg-slate-400 dark:bg-slate-600 dark:hover:bg-slate-500',
    thumbClass: enabled ? 'translate-x-5' : 'translate-x-0',
    buttonClass: saving ? 'cursor-wait opacity-80' : 'cursor-pointer',
    ariaLabel: enabled
      ? t('settingsAppearance.avatarDisableAria')
      : t('settingsAppearance.avatarEnableAria'),
  };
}

export async function toggleAvatarSetting<TConfig extends AvatarSettingsConfig>(
  config: TConfig,
  saveConfig: AvatarConfigSaver<TConfig>,
): Promise<boolean> {
  const previousEnabled = Boolean(config.avatar_enabled);
  const previousBreakReminderEnabled = Boolean(config.break_reminder_enabled);
  const nextEnabled = !previousEnabled;

  config.avatar_enabled = nextEnabled;
  if (!nextEnabled) {
    config.break_reminder_enabled = false;
  }

  try {
    await saveConfig(config);
    return nextEnabled;
  } catch (error) {
    config.avatar_enabled = previousEnabled;
    config.break_reminder_enabled = previousBreakReminderEnabled;
    throw error;
  }
}

export function clampAvatarScale(value: unknown): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return AVATAR_SCALE_DEFAULT;
  }

  return Math.min(AVATAR_SCALE_MAX, Math.max(AVATAR_SCALE_MIN, numericValue));
}

export function formatAvatarScaleLabel(value: unknown): string {
  return `${Math.round(clampAvatarScale(value) * 100)}%`;
}

export async function updateAvatarScaleSetting<TConfig extends AvatarSettingsConfig>(
  config: TConfig,
  nextScale: unknown,
  saveConfig: AvatarConfigSaver<TConfig>,
): Promise<number> {
  const previousScale = clampAvatarScale(config.avatar_scale);
  const clampedScale = clampAvatarScale(nextScale);

  config.avatar_scale = clampedScale;

  try {
    await saveConfig(config);
    return clampedScale;
  } catch (error) {
    config.avatar_scale = previousScale;
    throw error;
  }
}

export function clampAvatarOpacity(value: unknown): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return AVATAR_OPACITY_DEFAULT;
  }

  return Math.min(AVATAR_OPACITY_MAX, Math.max(AVATAR_OPACITY_MIN, numericValue));
}

export function formatAvatarOpacityLabel(value: unknown): string {
  return `${Math.round(clampAvatarOpacity(value) * 100)}%`;
}

export async function updateAvatarOpacitySetting<TConfig extends AvatarSettingsConfig>(
  config: TConfig,
  nextOpacity: unknown,
  saveConfig: AvatarConfigSaver<TConfig>,
): Promise<number> {
  const previousOpacity = clampAvatarOpacity(config.avatar_opacity);
  const clampedOpacity = clampAvatarOpacity(nextOpacity);

  config.avatar_opacity = clampedOpacity;

  try {
    await saveConfig(config);
    return clampedOpacity;
  } catch (error) {
    config.avatar_opacity = previousOpacity;
    throw error;
  }
}
