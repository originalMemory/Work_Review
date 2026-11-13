// AI 连接状态全局 Store
// 用于跨组件持久化 AI 连接测试状态，避免每次切换页面都重新测试

import { writable, type Readable } from 'svelte/store';

export type AiTestStatus = null | 'testing' | 'success' | 'error';

export interface AiTextModelConfigInput {
  provider: string;
  endpoint: string;
  model: string;
  api_key?: string | null;
}

export interface AiConfigInput {
  text_model?: AiTextModelConfigInput | null;
}

export interface AiStoreState {
  textTestStatus: AiTestStatus;
  textTestMessage: string;
  textConnectionVerified: boolean;
  lastTestedConfigHash: string | null;
}

export interface AiStore extends Readable<AiStoreState> {
  startTesting: () => void;
  setSuccess: (message: string) => void;
  setError: (message: string) => void;
  reset: () => void;
  setConfigHash: (hash: string | null) => void;
  getConfigHash: (config?: AiConfigInput | null) => string | null;
}

const DEFAULT_STATE: AiStoreState = {
  textTestStatus: null,
  textTestMessage: '',
  textConnectionVerified: false,
  lastTestedConfigHash: null,
};

function createAiStore(): AiStore {
  const { subscribe, update } = writable<AiStoreState>(DEFAULT_STATE);

  return {
    subscribe,

    // 开始测试
    startTesting: () => update((state) => ({
      ...state,
      textTestStatus: 'testing',
      textTestMessage: '',
    })),

    // 测试成功
    setSuccess: (message) => update((state) => ({
      ...state,
      textTestStatus: 'success',
      textTestMessage: message,
      textConnectionVerified: true,
    })),

    // 测试失败
    setError: (message) => update((state) => ({
      ...state,
      textTestStatus: 'error',
      textTestMessage: message,
      textConnectionVerified: false,
    })),

    // 重置状态（提供商变更时）
    reset: () => update((state) => ({
      ...state,
      textTestStatus: null,
      textTestMessage: '',
      textConnectionVerified: false,
      lastTestedConfigHash: null,
    })),

    // 设置配置指纹
    setConfigHash: (hash) => update((state) => ({
      ...state,
      lastTestedConfigHash: hash,
    })),

    // 计算配置指纹
    getConfigHash: (config) => {
      if (!config?.text_model) return null;
      const { provider, endpoint, model, api_key } = config.text_model;
      return `${provider}|${endpoint}|${model}|${api_key || ''}`;
    },
  };
}

export const aiStore: AiStore = createAiStore();
