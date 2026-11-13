/**
 * 把助手多轮对话历史构造成发给后端的 payload。
 *
 * assistant 消息里的工具步骤不会被后端直接送入模型，因此这里只把已完成步骤的
 * 工具名与状态附在回答末尾，不携带任何工具返回正文。
 */

const TRUSTED_HISTORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_memory',
  'analyze_intents',
  'aggregate_stats',
  'category_search',
  'query_activities',
  'trend_comparison',
  'get_work_sessions',
  'get_insights',
  'weekly_review',
  'extract_todos',
  'get_daily_report',
  'get_current_context',
  'get_today_stats',
  'create_todo',
  'set_app_category',
  'pause_recording',
  'resume_recording',
  'open_timeline',
  'generate_daily_report',
  'search_user_memories',
  'remember_user_memory',
  'update_user_memory',
  'forget_user_memory',
  'fetch_url',
  'web_search',
]);

interface HistoryToolStepLike {
  tool?: unknown;
  status?: unknown;
  ok?: unknown;
  hits?: unknown;
}

interface CompletedHistoryToolStep extends HistoryToolStepLike {
  tool: string;
  status: 'done';
}

interface HistoryMessageLike {
  role?: unknown;
  content?: unknown;
  streaming?: unknown;
  failed?: unknown;
  steps?: unknown;
}

export interface HistoryPayloadEntry {
  role: 'user' | 'assistant';
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCompletedStep(value: unknown): value is CompletedHistoryToolStep {
  return (
    isRecord(value)
    && value.status === 'done'
    && typeof value.tool === 'string'
    && TRUSTED_HISTORY_TOOL_NAMES.has(value.tool)
  );
}

/** 工具名到摘要片段；仅处理已完成且工具名有效的步骤。 */
function summarizeDoneStep(step: CompletedHistoryToolStep): string {
  const tool = step.tool;
  if (step.ok === false) {
    return `${tool}↯`;
  }
  if (step.ok !== true) {
    return `${tool}?`;
  }
  return `${tool}✓`;
}

export function summarizeStepsForHistory(steps: unknown): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const doneSteps = steps.filter(isCompletedStep);
  if (doneSteps.length === 0) return null;

  return `[工具：${doneSteps.map(summarizeDoneStep).join(' | ')}]`;
}

/**
 * @deprecated 工具正文不得进入对话历史；保留空实现仅用于兼容迁移期类型契约。
 */
export function buildStepDigestForHistory(_steps: unknown): string | null {
  return null;
}

/**
 * 只保留完整的 user 到 assistant 轮次，并截取最近四轮。
 */
export function buildHistoryPayload(messages: unknown): HistoryPayloadEntry[] {
  const list = Array.isArray(messages) ? messages : [];
  const rounds: [HistoryPayloadEntry, HistoryPayloadEntry][] = [];
  let pendingUser: HistoryMessageLike | null = null;

  for (const value of list) {
    if (!isRecord(value)) continue;
    const message: HistoryMessageLike = value;

    if (message.role === 'user') {
      pendingUser = message;
      continue;
    }

    if (message.role !== 'assistant' || !pendingUser) continue;

    // streaming 使用 truthy 判断，failed 只接受严格 true，保持历史兼容语义。
    if (message.streaming || message.failed === true) {
      pendingUser = null;
      continue;
    }

    const baseContent = String(message.content ?? '');
    const summary = summarizeStepsForHistory(message.steps);
    rounds.push([
      { role: 'user', content: String(pendingUser.content ?? '') },
      {
        role: 'assistant',
        content: summary
          ? baseContent
            ? `${baseContent}\n\n${summary}`
            : summary
          : baseContent,
      },
    ]);
    pendingUser = null;
  }

  return rounds.slice(-4).flat();
}
