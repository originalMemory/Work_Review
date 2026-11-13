export interface PromptAppliedToastInput {
  readonly configAiMode: unknown;
  readonly customPrompt: unknown;
  readonly reportAiMode: unknown;
}

function stringifyTruthy(value: unknown): string {
  return value ? (value as { toString(): string }).toString() : '';
}

export function shouldShowPromptAppliedToast({
  configAiMode,
  customPrompt,
  reportAiMode,
}: PromptAppliedToastInput): boolean {
  const normalizedConfigMode = stringifyTruthy(configAiMode).trim().toLowerCase();
  const normalizedReportMode = stringifyTruthy(reportAiMode).trim().toLowerCase();
  const trimmedPrompt = stringifyTruthy(customPrompt).trim();

  return (
    normalizedConfigMode === 'summary'
    && normalizedReportMode === 'summary'
    && trimmedPrompt.length > 0
  );
}
