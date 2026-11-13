import { writable, type Readable, type Writable } from 'svelte/store';

export interface RecordingStateInput {
  isRecording?: unknown;
  isPaused?: unknown;
}

export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
}

export interface RecordingStore extends Readable<RecordingState> {
  set: Writable<RecordingState>['set'];
  setState: (isRecording: unknown, isPaused: unknown) => void;
  reset: () => void;
}

/**
 * 录制状态 store。
 *
 * App.svelte 在 onMount 时通过 get_recording_state 初始化，
 * 并监听 recording-state-changed 事件实时更新。
 * Overview 和 Timeline 读取此 store 来控制"实时"指示圆点的颜色/动画
 * （停止记录后圆点应变灰、停止脉冲），而不是仅看是否"今天"模式。
 *
 * 对应后端事件 payload：{ isRecording: bool, isPaused: bool }
 */
const DEFAULT_STATE: RecordingState = {
  isRecording: true,
  isPaused: false,
};

function createRecordingStore(): RecordingStore {
  const { subscribe, set } = writable<RecordingState>(DEFAULT_STATE);

  return {
    subscribe,
    set,
    setState: (isRecording, isPaused) =>
      set({ isRecording: Boolean(isRecording), isPaused: Boolean(isPaused) }),
    reset: () => set(DEFAULT_STATE),
  };
}

export const recordingStore: RecordingStore = createRecordingStore();

/** 是否正在活跃录制（录制中且未暂停）—— 组件直接用的派生布尔。 */
export function isActiveRecording(state?: RecordingStateInput | null): boolean {
  return Boolean(state?.isRecording) && !state?.isPaused;
}
