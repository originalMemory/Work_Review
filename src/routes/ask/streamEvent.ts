import { formatUserError } from '../../lib/utils/errorDisplay.ts';
import type { AssistantConfirmStatus } from '../../lib/stores/assistant.ts';

/** 与后端 executor.rs 的 CANCELLED_ANSWER 常量保持一致。 */
export const CANCELLED_ANSWER_MARKER = '已按你的要求停止。';

export type StreamReference = Record<string, unknown>;

export interface StreamStep {
  tool?: string;
  label?: string;
  status?: 'running' | 'done';
  ok?: boolean;
  hits?: number;
  references?: StreamReference[];
  digest?: string;
  confirmId?: string;
  summary?: string;
  confirmStatus?: AssistantConfirmStatus;
  [key: string]: unknown;
}

export interface StreamMessage {
  content?: string | null;
  steps?: StreamStep[];
  references?: StreamReference[];
  toolLabels?: string[];
  streaming?: boolean;
  failed?: boolean;
  stopped?: boolean;
  [key: string]: unknown;
}

export interface StreamEventResult {
  message: StreamMessage;
  terminal: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function referenceKey(reference: StreamReference): string {
  return `${String(reference.sourceId ?? '')}|${String(reference.timestamp)}|${String(reference.title)}`;
}

function normalizeReferences(value: unknown): StreamReference[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function mergeReferences(
  existing: unknown,
  incoming: unknown,
): StreamReference[] {
  const current = normalizeReferences(existing);
  const additions = normalizeReferences(incoming);
  if (additions.length === 0) return current;

  const seen = new Set(current.map(referenceKey));
  const merged = [...current];
  for (const reference of additions) {
    const key = referenceKey(reference);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(reference);
    }
  }
  return merged;
}

function findLatestRunningStep(steps: StreamStep[], tool: unknown): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.status === 'running' && steps[index]?.tool === tool) {
      return index;
    }
  }
  return -1;
}

/**
 * 将单个后端流式事件归约到指定消息，不依赖组件或全局 store。
 * terminal=true 表示收到 done/error，调用方应停止接受后续事件。
 */
export function reduceStreamEvent(
  message: StreamMessage,
  event: unknown,
  fallbackError?: string,
): StreamEventResult {
  if (!isRecord(event)) {
    return { message, terminal: false };
  }

  switch (event.type) {
    case 'stepStart': {
      const steps = Array.isArray(message.steps) ? message.steps : [];
      return {
        message: {
          ...message,
          steps: [
            ...steps,
            {
              tool: typeof event.tool === 'string' ? event.tool : '',
              label: typeof event.label === 'string' ? event.label : '',
              status: 'running',
            },
          ],
        },
        terminal: false,
      };
    }
    case 'stepResult': {
      const steps = Array.isArray(message.steps) ? message.steps : [];
      const targetIndex = findLatestRunningStep(steps, event.tool);
      const eventReferences = normalizeReferences(event.references);
      const nextSteps: StreamStep[] = targetIndex === -1
        ? steps
        : steps.map((step, index) =>
            index === targetIndex
              ? {
                  ...step,
                  status: 'done',
                  ok: event.ok === true ? true : event.ok === false ? false : undefined,
                  hits:
                    typeof event.hits === 'number'
                    && Number.isFinite(event.hits)
                    && event.hits >= 0
                      ? event.hits
                      : undefined,
                  references: eventReferences,
                  ...(typeof event.digest === 'string' ? { digest: event.digest } : {}),
                }
              : step
          );
      return {
        message: {
          ...message,
          steps: nextSteps,
          references: mergeReferences(message.references, eventReferences),
        },
        terminal: false,
      };
    }
    case 'confirmRequest': {
      const steps = Array.isArray(message.steps) ? message.steps : [];
      const targetIndex = findLatestRunningStep(steps, event.tool);
      const confirmPatch = {
        confirmId: typeof event.confirmId === 'string' ? event.confirmId : '',
        summary: typeof event.summary === 'string' ? event.summary : '',
        confirmStatus: 'pending' as const,
      };
      const nextSteps: StreamStep[] = targetIndex === -1
        ? [
            ...steps,
            {
              tool: typeof event.tool === 'string' ? event.tool : '',
              label: typeof event.label === 'string' ? event.label : '',
              status: 'running',
              ...confirmPatch,
            },
          ]
        : steps.map((step, index) =>
            index === targetIndex ? { ...step, ...confirmPatch } : step
          );
      return {
        message: { ...message, steps: nextSteps },
        terminal: false,
      };
    }
    case 'token':
      return {
        message: {
          ...message,
          content: `${message.content ?? ''}${typeof event.token === 'string' ? event.token : ''}`,
        },
        terminal: false,
      };
    case 'done': {
      const answer = typeof event.answer === 'string' ? event.answer : undefined;
      const references = normalizeReferences(event.references);
      const toolLabels = normalizeStrings(event.toolLabels);
      // 用户主动停止时保留已流式出来的部分内容。
      const cancelled =
        answer === CANCELLED_ANSWER_MARKER && (message.content ?? '').trim();
      return {
        message: {
          ...message,
          content: cancelled ? message.content : answer ?? message.content,
          references: references?.length ? references : message.references,
          toolLabels: toolLabels?.length ? toolLabels : message.toolLabels,
          streaming: false,
          failed: false,
          stopped: Boolean(cancelled) || answer === CANCELLED_ANSWER_MARKER,
        },
        terminal: true,
      };
    }
    case 'error': {
      const displayError = typeof event.error === 'string'
        ? formatUserError(event.error, fallbackError ?? '')
        : '';
      return {
        message: {
          ...message,
          content: displayError || message.content || fallbackError,
          streaming: false,
          failed: true,
        },
        terminal: true,
      };
    }
    default:
      return { message, terminal: false };
  }
}
