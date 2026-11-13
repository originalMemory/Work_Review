export interface RequestEventGate<TEvent> {
  handle(event: TEvent): boolean;
  close(): void;
}

export interface RequestEventGateOptions<TEvent> {
  isDestroyed: () => unknown;
  onEvent: (event: TEvent) => unknown;
}

/**
 * 为单次 Ask 请求创建事件门闩。
 *
 * 终态、超时主动关闭或组件销毁后，迟到事件都会被忽略，避免旧请求更新新回答。
 */
export function createRequestEventGate<TEvent>({
  isDestroyed,
  onEvent,
}: RequestEventGateOptions<TEvent>): RequestEventGate<TEvent> {
  let accepting = true;

  return {
    handle(event: TEvent): boolean {
      if (!accepting || isDestroyed()) return false;
      const terminal = onEvent(event) === true;
      if (terminal) accepting = false;
      return terminal;
    },
    close(): void {
      accepting = false;
    },
  };
}
