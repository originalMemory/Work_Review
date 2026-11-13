export interface HourSummaryOrderable {
  readonly hour: number | string;
}

export interface HourlySummaryRecord extends HourSummaryOrderable {
  readonly hour: number;
  readonly summary: string;
  readonly main_apps: string;
  readonly activity_count: number;
  readonly total_duration: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isHourlySummaryRecord(value: unknown): value is HourlySummaryRecord {
  if (!isRecord(value)) return false;

  return isFiniteNumber(value.hour)
    && typeof value.summary === 'string'
    && typeof value.main_apps === 'string'
    && isFiniteNumber(value.activity_count)
    && isFiniteNumber(value.total_duration);
}

export function parseHourlySummaryRecords(value: unknown): HourlySummaryRecord[] {
  if (!Array.isArray(value) || !value.every(isHourlySummaryRecord)) {
    throw new TypeError('小时摘要载荷格式无效');
  }
  return value;
}

export interface SummaryDisplayParts {
  readonly primary: string;
  readonly secondary: string;
}

export type SummaryRhythmTone = 'deep' | 'steady' | 'light';

function normalizeSummary(text?: string | null): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function splitSummarySentences(text: string): string[] {
  return normalizeSummary(text)
    .split(/[。！？!?]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitSummaryClauses(text: string): string[] {
  return text
    .split(/[，,；;、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureChineseStop(text: string): string {
  if (!text) {
    return '';
  }
  return `${text.replace(/[。！？!?]+$/g, '').trim()}。`;
}

export function orderHourlySummariesForDisplay<T extends HourSummaryOrderable>(
  summaries: readonly T[] | null | undefined = [],
): T[] {
  const displaySummaries: readonly T[] = Array.isArray(summaries) ? summaries : [];
  return [...displaySummaries].sort(
    (left, right) => Number(right.hour) - Number(left.hour)
  );
}

export function formatHourRange(hour?: number | string | null): string {
  const numericHour = Number(hour);
  const normalizedHour = Number.isFinite(numericHour)
    ? Math.max(0, Math.min(23, Math.trunc(numericHour)))
    : 0;
  const start = String(normalizedHour).padStart(2, '0');
  const end = String(normalizedHour + 1).padStart(2, '0');
  return `${start}:00–${end}:00`;
}

export function getFullSummary(text?: string | null): string {
  return normalizeSummary(text);
}

export function getPrimarySummary(text?: string | null): string {
  const normalized = normalizeSummary(text);
  if (!normalized) {
    return '';
  }

  const firstSentence = splitSummarySentences(normalized)[0] || normalized;
  const clauses = splitSummaryClauses(firstSentence);

  if (clauses.length >= 3) {
    return clauses.slice(0, 2).join('，');
  }

  return firstSentence;
}

export function getSecondarySummary(text?: string | null): string {
  const normalized = normalizeSummary(text);
  if (!normalized) {
    return '';
  }

  const sentences = splitSummarySentences(normalized);
  const firstSentence = sentences[0] || normalized;
  const clauses = splitSummaryClauses(firstSentence);

  if (clauses.length >= 3) {
    return ensureChineseStop(clauses.slice(2).join('，'));
  }

  if (sentences.length > 1) {
    return ensureChineseStop(sentences.slice(1).join('。'));
  }

  return '';
}

export function getSummaryDisplayParts(
  text?: string | null,
  expanded = false,
): SummaryDisplayParts {
  if (expanded) {
    return {
      primary: getFullSummary(text),
      secondary: '',
    };
  }

  return {
    primary: getPrimarySummary(text),
    secondary: getSecondarySummary(text),
  };
}

export function getMainApps(mainApps?: string | null): string[] {
  return (mainApps || '')
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function getSummaryRhythmTone(totalDuration = 0): SummaryRhythmTone {
  if (totalDuration >= 45 * 60) {
    return 'deep';
  }

  if (totalDuration >= 20 * 60) {
    return 'steady';
  }

  return 'light';
}
