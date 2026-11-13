import { writable, type Readable } from 'svelte/store';

export const BASIC_ASSISTANT_MODEL_ID = '__basic__';

export type AssistantMessageRole = 'user' | 'assistant';
export type AssistantStepStatus = 'running' | 'done';
export type AssistantConfirmStatus = 'pending' | 'approved' | 'denied' | 'rejected';

export interface AssistantReference {
  sourceType: string;
  sourceId: number | null;
  date: string;
  timestamp: number;
  title: string;
  excerpt: string;
  appName: string | null;
  browserUrl: string | null;
  duration: number | null;
  score: number;
  [key: string]: unknown;
}

export type AssistantCard = Record<string, unknown>;

export interface AssistantStep {
  tool?: string;
  label?: string;
  status?: AssistantStepStatus;
  ok?: boolean;
  hits?: number;
  references?: AssistantReference[];
  digest?: string;
  confirmId?: string;
  summary?: string;
  confirmStatus?: AssistantConfirmStatus;
  [key: string]: unknown;
}

/** 可由页面、SQLite 恢复逻辑或旧 localStorage 提供的消息形状。 */
export interface AssistantMessageInput {
  id?: string;
  role?: AssistantMessageRole;
  content?: string | null;
  cards?: unknown[];
  references?: unknown[];
  toolLabels?: unknown[];
  steps?: unknown[];
  streaming?: boolean;
  usedAi?: boolean;
  failed?: boolean;
  stopped?: boolean;
  modelName?: string;
  [key: string]: unknown;
}

/** Store 中完成旧消息归一化后的稳定消息形状。 */
export interface AssistantMessage extends AssistantMessageInput {
  id: string;
  cards: AssistantCard[];
  references: AssistantReference[];
  toolLabels: string[];
  steps: AssistantStep[];
  streaming: boolean;
}

export interface AssistantState {
  messages: AssistantMessage[];
  selectedModelId: string;
  hasUserSelectedModel: boolean;
  sending: boolean;
  sendingRequestId: string | null;
  conversationId: number | null;
}

export type AssistantMessageUpdater = (
  message: AssistantMessage,
) => AssistantMessageInput;

export interface AssistantModelSelectionOptions {
  userInitiated?: boolean;
}

export interface AssistantStore extends Readable<AssistantState> {
  appendMessage: (message: AssistantMessageInput) => void;
  clearMessages: () => void;
  setSelectedModelId: (
    selectedModelId: unknown,
    options?: AssistantModelSelectionOptions,
  ) => void;
  setMessages: (messages: AssistantMessageInput[] | null | undefined) => void;
  setConversation: (
    conversationId: number | null | undefined,
    messages: AssistantMessageInput[] | null | undefined,
  ) => void;
  setConversationId: (conversationId: number | null | undefined) => void;
  beginSending: (requestId: string) => void;
  finishSending: (requestId: string) => void;
  updateLastStreaming: (updater: AssistantMessageUpdater) => void;
  updateMessageById: (messageId: string, updater: AssistantMessageUpdater) => void;
  reset: () => void;
}

const STORAGE_KEY = 'work-review-assistant-state';
const DEFAULT_STATE: AssistantState = {
  messages: [],
  selectedModelId: BASIC_ASSISTANT_MODEL_ID,
  // 标记用户是否曾手动操作过模型选择器。
  // false = 从未选过（首次打开），助手页可自动选中已配置的模型（issue #133）；
  // 一旦用户手动切换（含切回基础模板），就置 true，不再自动覆盖用户选择。
  hasUserSelectedModel: false,
  sending: false,
  sendingRequestId: null,
  // 当前会话在 SQLite 中的 id（P3 持久化）；null = 尚未落库的新对话
  conversationId: null,
};

function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeReference(value: unknown): AssistantReference | null {
  if (!isRecord(value)) return null;

  return {
    ...value,
    sourceType: optionalString(value.sourceType) ?? '',
    sourceId: nullableNumber(value.sourceId),
    date: optionalString(value.date) ?? '',
    timestamp: finiteNumber(value.timestamp, 0),
    title: optionalString(value.title) ?? '',
    excerpt: optionalString(value.excerpt) ?? '',
    appName: nullableString(value.appName),
    browserUrl: nullableString(value.browserUrl),
    duration: nullableNumber(value.duration),
    score: finiteNumber(value.score, 0),
  };
}

function normalizeReferences(value: unknown): AssistantReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((reference) => normalizeReference(reference))
    .filter((reference): reference is AssistantReference => reference !== null);
}

function normalizeCards(value: unknown): AssistantCard[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeToolLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((label): label is string => typeof label === 'string')
    : [];
}

function normalizeStep(value: unknown): AssistantStep | null {
  if (!isRecord(value)) return null;

  return {
    ...value,
    tool: optionalString(value.tool),
    label: optionalString(value.label),
    status:
      value.status === 'running' || value.status === 'done' ? value.status : undefined,
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    hits: typeof value.hits === 'number' && Number.isFinite(value.hits)
      ? value.hits
      : undefined,
    references: Array.isArray(value.references)
      ? normalizeReferences(value.references)
      : undefined,
    digest: optionalString(value.digest),
    confirmId: optionalString(value.confirmId),
    summary: optionalString(value.summary),
    confirmStatus:
      value.confirmStatus === 'pending'
      || value.confirmStatus === 'approved'
      || value.confirmStatus === 'denied'
      || value.confirmStatus === 'rejected'
        ? value.confirmStatus
        : undefined,
  };
}

function normalizeSteps(value: unknown): AssistantStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => normalizeStep(step))
    .filter((step): step is AssistantStep => step !== null);
}

function normalizeMessage(message: unknown): AssistantMessage {
  const value = isRecord(message) ? message : {};
  return {
    ...value,
    id: typeof value.id === 'string' && value.id ? value.id : genId(),
    role: value.role === 'user' || value.role === 'assistant' ? value.role : undefined,
    content: typeof value.content === 'string' || value.content === null
      ? value.content
      : undefined,
    cards: normalizeCards(value.cards),
    references: normalizeReferences(value.references),
    toolLabels: normalizeToolLabels(value.toolLabels),
    steps: normalizeSteps(value.steps),
    streaming: Boolean(value.streaming),
    usedAi: typeof value.usedAi === 'boolean' ? value.usedAi : undefined,
    failed: typeof value.failed === 'boolean' ? value.failed : undefined,
    stopped: typeof value.stopped === 'boolean' ? value.stopped : undefined,
    modelName: optionalString(value.modelName),
  };
}

function loadState(): AssistantState {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_STATE;
    }

    const parsed: unknown = JSON.parse(raw);
    const persisted = isRecord(parsed) ? parsed : {};
    return {
      messages: Array.isArray(persisted.messages)
        ? persisted.messages.map((message) => normalizeMessage(message))
        : [],
      selectedModelId:
        typeof persisted.selectedModelId === 'string' && persisted.selectedModelId.trim()
          ? persisted.selectedModelId
          : BASIC_ASSISTANT_MODEL_ID,
      hasUserSelectedModel: Boolean(persisted.hasUserSelectedModel),
      sending: false,
      sendingRequestId: null,
      conversationId:
        typeof persisted.conversationId === 'number' ? persisted.conversationId : null,
    };
  } catch (error) {
    console.warn('加载助手会话缓存失败:', error);
    return DEFAULT_STATE;
  }
}

function persistState(state: AssistantState): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('保存助手会话缓存失败:', error);
  }
}

function createAssistantStore(): AssistantStore {
  const { subscribe, set, update } = writable<AssistantState>(loadState());

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  subscribe((state) => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistState(state);
    }, 500);
  });

  return {
    subscribe,
    appendMessage: (message) =>
      update((state) => ({
        ...state,
        messages: [...state.messages, normalizeMessage(message)].slice(-40),
      })),
    clearMessages: () =>
      update((state) => ({
        ...state,
        messages: [],
      })),
    setSelectedModelId: (selectedModelId, { userInitiated = true } = {}) =>
      update((state) => ({
        ...state,
        selectedModelId:
          typeof selectedModelId === 'string' && selectedModelId.trim()
            ? selectedModelId
            : BASIC_ASSISTANT_MODEL_ID,
        // 只有用户手动操作（handleModelChange）才标记；程序内部初始化不算
        hasUserSelectedModel: userInitiated ? true : state.hasUserSelectedModel,
      })),
    setMessages: (messages) =>
      update((state) => ({
        ...state,
        messages: Array.isArray(messages)
          ? messages.slice(-40).map((message) => normalizeMessage(message))
          : [],
      })),
    // P3：绑定/切换 SQLite 会话（同时替换内存消息）
    setConversation: (conversationId, messages) =>
      update((state) => ({
        ...state,
        conversationId: typeof conversationId === 'number' ? conversationId : null,
        messages: Array.isArray(messages)
          ? messages.map((message) => normalizeMessage(message))
          : [],
      })),
    setConversationId: (conversationId) =>
      update((state) => ({
        ...state,
        conversationId: typeof conversationId === 'number' ? conversationId : null,
      })),
    beginSending: (requestId) =>
      update((state) => ({
        ...state,
        sending: true,
        sendingRequestId: requestId,
      })),
    finishSending: (requestId) =>
      update((state) => {
        if (state.sendingRequestId !== requestId) return state;
        return {
          ...state,
          sending: false,
          sendingRequestId: null,
        };
      }),
    // 增量更新当前 streaming 的 assistant message（流式事件驱动）。
    updateLastStreaming: (updater) =>
      update((state) => {
        const index = state.messages.findIndex((message) => message.streaming);
        if (index === -1) return state;
        const newMessages = state.messages.slice();
        newMessages[index] = normalizeMessage(updater({ ...newMessages[index] }));
        return { ...state, messages: newMessages };
      }),
    // 按请求对应的消息 ID 定点更新，避免并发流式消息互相覆盖。
    updateMessageById: (messageId, updater) =>
      update((state) => {
        const index = state.messages.findIndex((message) => message.id === messageId);
        if (index === -1) return state;
        const newMessages = state.messages.slice();
        newMessages[index] = normalizeMessage(updater({ ...newMessages[index] }));
        return { ...state, messages: newMessages };
      }),
    reset: () => set(DEFAULT_STATE),
  };
}

export const assistantStore: AssistantStore = createAssistantStore();
