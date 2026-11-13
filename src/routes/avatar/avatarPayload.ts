import type {
  AvatarMode,
  AvatarPersona,
} from '../../lib/components/Avatar/avatarStateMeta.ts';

export interface AvatarState {
  mode: AvatarMode;
  appName: string;
  contextLabel: string;
  hint: string;
  isIdle: boolean;
  isGeneratingReport: boolean;
  avatarOpacity: number;
  avatarPreset: string;
  avatarPersona: AvatarPersona;
  avatarBodyHidden: boolean;
}

export interface AvatarInputActivity {
  keyboardActive: boolean;
  mouseActive: boolean;
  keyboardGroup: string;
  keyboardVisualKey: string;
  mouseGroup: string;
  cursorRatioX: number;
  cursorRatioY: number;
  lastKeyboardInputAtMs: number;
  lastMouseInputAtMs: number;
}

export interface AvatarBubblePayload {
  message: string;
  tone?: string;
  persistent?: boolean;
  durationMs?: number | null;
  clear?: boolean;
}

export interface AvatarFollowupPayload {
  projectKey: string;
  date: string;
  title: string;
  sourceApp: string;
  sourceTitle: string;
  intentLabel: string;
  confidence: number;
  persona: AvatarPersona;
  sessionAgeHours: number;
}

const AVATAR_MODES: readonly AvatarMode[] = [
  'idle',
  'working',
  'reading',
  'meeting',
  'music',
  'video',
  'generating',
  'slacking',
];

const AVATAR_PERSONAS: readonly AvatarPersona[] = [
  'companion',
  'assistant',
  'coach',
];

const DEFAULT_INPUT_ACTIVITY: AvatarInputActivity = {
  keyboardActive: false,
  mouseActive: false,
  keyboardGroup: 'idle',
  keyboardVisualKey: '',
  mouseGroup: 'idle',
  cursorRatioX: 0.5,
  cursorRatioY: 0.5,
  lastKeyboardInputAtMs: 0,
  lastMouseInputAtMs: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAvatarMode(value: unknown): value is AvatarMode {
  return typeof value === 'string' && AVATAR_MODES.some((mode) => mode === value);
}

function isAvatarPersona(value: unknown): value is AvatarPersona {
  return typeof value === 'string'
    && AVATAR_PERSONAS.some((persona) => persona === value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function optionalDuration(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isFiniteNumber(value);
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function parseAvatarState(value: unknown): AvatarState | null {
  if (
    !isRecord(value)
    || !isAvatarMode(value.mode)
    || typeof value.appName !== 'string'
    || typeof value.contextLabel !== 'string'
    || typeof value.hint !== 'string'
    || typeof value.isIdle !== 'boolean'
    || typeof value.isGeneratingReport !== 'boolean'
    || !isFiniteNumber(value.avatarOpacity)
  ) {
    return null;
  }

  return {
    mode: value.mode,
    appName: value.appName,
    contextLabel: value.contextLabel,
    hint: value.hint,
    isIdle: value.isIdle,
    isGeneratingReport: value.isGeneratingReport,
    avatarOpacity: value.avatarOpacity,
    avatarPreset: stringOrDefault(value.avatarPreset, 'original-standard'),
    avatarPersona: isAvatarPersona(value.avatarPersona) ? value.avatarPersona : 'assistant',
    avatarBodyHidden: typeof value.avatarBodyHidden === 'boolean'
      ? value.avatarBodyHidden
      : false,
  };
}

export function normalizeAvatarInputActivity(value: unknown): AvatarInputActivity {
  const payload = isRecord(value) ? value : {};
  return {
    keyboardActive: typeof payload.keyboardActive === 'boolean'
      ? payload.keyboardActive
      : DEFAULT_INPUT_ACTIVITY.keyboardActive,
    mouseActive: typeof payload.mouseActive === 'boolean'
      ? payload.mouseActive
      : DEFAULT_INPUT_ACTIVITY.mouseActive,
    keyboardGroup: stringOrDefault(
      payload.keyboardGroup,
      DEFAULT_INPUT_ACTIVITY.keyboardGroup,
    ),
    keyboardVisualKey: stringOrDefault(
      payload.keyboardVisualKey,
      DEFAULT_INPUT_ACTIVITY.keyboardVisualKey,
    ),
    mouseGroup: stringOrDefault(payload.mouseGroup, DEFAULT_INPUT_ACTIVITY.mouseGroup),
    cursorRatioX: numberOrDefault(payload.cursorRatioX, DEFAULT_INPUT_ACTIVITY.cursorRatioX),
    cursorRatioY: numberOrDefault(payload.cursorRatioY, DEFAULT_INPUT_ACTIVITY.cursorRatioY),
    lastKeyboardInputAtMs: numberOrDefault(
      payload.lastKeyboardInputAtMs,
      DEFAULT_INPUT_ACTIVITY.lastKeyboardInputAtMs,
    ),
    lastMouseInputAtMs: numberOrDefault(
      payload.lastMouseInputAtMs,
      DEFAULT_INPUT_ACTIVITY.lastMouseInputAtMs,
    ),
  };
}

export function parseAvatarBubblePayload(value: unknown): AvatarBubblePayload | null {
  if (
    !isRecord(value)
    || typeof value.message !== 'string'
    || !optionalString(value.tone)
    || !optionalBoolean(value.persistent)
    || !optionalDuration(value.durationMs)
    || !optionalBoolean(value.clear)
  ) {
    return null;
  }

  return {
    message: value.message,
    tone: value.tone,
    persistent: value.persistent,
    durationMs: value.durationMs,
    clear: value.clear,
  };
}

export function parseAvatarFollowupPayload(value: unknown): AvatarFollowupPayload | null {
  if (
    !isRecord(value)
    || typeof value.projectKey !== 'string'
    || typeof value.date !== 'string'
    || typeof value.title !== 'string'
    || typeof value.sourceApp !== 'string'
    || typeof value.sourceTitle !== 'string'
    || typeof value.intentLabel !== 'string'
    || !isFiniteNumber(value.confidence)
    || !isFiniteNumber(value.sessionAgeHours)
  ) {
    return null;
  }

  return {
    projectKey: value.projectKey,
    date: value.date,
    title: value.title,
    sourceApp: value.sourceApp,
    sourceTitle: value.sourceTitle,
    intentLabel: value.intentLabel,
    confidence: value.confidence,
    persona: isAvatarPersona(value.persona) ? value.persona : 'assistant',
    sessionAgeHours: value.sessionAgeHours,
  };
}
