export interface StarterPromptOptions {
  localPrompts?: unknown;
  dynamicPrompts?: unknown;
  previousPrompts?: unknown;
  count?: unknown;
  random?: () => unknown;
}

/**
 * 清理并随机抽取欢迎态快捷问题。
 *
 * 动态问题优先进入候选池，但最终会与本地问题一起洗牌。random 可注入，
 * 便于对随机行为做确定性测试。
 */
export function selectStarterPrompts({
  localPrompts,
  dynamicPrompts = [],
  previousPrompts = [],
  count = 4,
  random = Math.random,
}: StarterPromptOptions = {}): string[] {
  const normalizedCount =
    typeof count === 'number' && Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 4;
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const prompt of [...asArray(dynamicPrompts), ...asArray(localPrompts)]) {
    if (typeof prompt !== 'string') continue;
    const normalized = prompt.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }

  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const normalizedRandom = Number.isFinite(value)
      ? Math.min(Math.max(value, 0), 0.9999999999999999)
      : 0;
    const swapIndex = Math.floor(normalizedRandom * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  const selected = shuffled.slice(0, normalizedCount);
  if (selected.length > 1 && arraysEqual(selected, normalizePrompts(previousPrompts))) {
    if (shuffled.length > selected.length) {
      selected[selected.length - 1] = shuffled[selected.length];
    } else {
      selected.push(selected.shift()!);
    }
  }

  return selected;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePrompts(prompts: unknown): string[] {
  return asArray(prompts)
    .filter((prompt): prompt is string => typeof prompt === 'string')
    .map((prompt) => prompt.trim())
    .filter(Boolean);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
