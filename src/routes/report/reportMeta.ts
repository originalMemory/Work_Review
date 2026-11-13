const TEMPLATE_FALLBACK_HINTS = [
  '由基础模板生成',
  '使用基础模板生成',
  '由基礎模板生成',
  '使用基礎模板生成',
  'generated from the base template',
];

export interface ReportMetaInput {
  readonly ai_mode?: unknown;
  readonly model_name?: unknown;
  readonly fallback_reason?: unknown;
  readonly content?: unknown;
}

export interface ReportConfigMetaInput {
  readonly ai_mode?: unknown;
  readonly text_model?: unknown;
}

export interface ResolvedReportMeta {
  readonly reportMode: string;
  readonly showUsageMismatchNotice: boolean;
  readonly fallbackReason: string | null;
}

function stringifyTruthy(value: unknown): string {
  return value ? (value as { toString(): string }).toString() : '';
}

function normalizeMode(mode: unknown): string {
  return stringifyTruthy(mode).trim().toLowerCase();
}

function containsTemplateFallbackHint(content: unknown): boolean {
  const normalizedContent = stringifyTruthy(content);
  const contentLower = normalizedContent.toLowerCase();

  return TEMPLATE_FALLBACK_HINTS.some((hint) => {
    const normalizedHint = hint.toLowerCase();
    return normalizedHint === 'generated from the base template'
      ? contentLower.includes(normalizedHint)
      : normalizedContent.includes(hint);
  });
}

export function resolveReportMeta(
  reportData: ReportMetaInput | null | undefined,
  currentConfig: ReportConfigMetaInput | null | undefined,
): ResolvedReportMeta {
  const configMode = normalizeMode(currentConfig?.ai_mode);
  const fallbackReason = stringifyTruthy(reportData?.fallback_reason).trim() || null;

  let reportMode = normalizeMode(reportData?.ai_mode || configMode);

  if (containsTemplateFallbackHint(reportData?.content)) {
    reportMode = 'local';
  }

  if (!reportData) {
    reportMode = configMode;
  }

  const showUsageMismatchNotice = configMode === 'summary' && reportMode === 'local';

  return {
    reportMode,
    showUsageMismatchNotice,
    fallbackReason,
  };
}
