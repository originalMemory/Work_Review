const TECHNICAL_PATTERNS = [
  /TypeError/i,
  /ReferenceError/i,
  /SyntaxError/i,
  /RangeError/i,
  /Cannot read propert/i,
  /undefined is not/i,
  /null is not/i,
  /is not a function/i,
  /is not defined/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /SQLITE_[A-Z_]+/i,
  /数据库错误\s*:/,
  /\[object [A-Z]/,
  /^\s*at\s+\S+\s+\(/m,
];

function isTechnicalError(error: unknown): boolean {
  return (
    error instanceof TypeError
    || error instanceof ReferenceError
    || error instanceof SyntaxError
    || error instanceof RangeError
    || error instanceof URIError
    || error instanceof EvalError
    || error instanceof AggregateError
  );
}

export function formatUserError(error: unknown, fallback: string): string {
  const text = String(error instanceof Error ? error.message : error ?? '').trim();
  if (!text) {
    return fallback;
  }
  if (isTechnicalError(error) || TECHNICAL_PATTERNS.some((pattern) => pattern.test(text))) {
    console.error('技术错误详情（不向用户展示）:', error);
    return fallback;
  }
  return text;
}
