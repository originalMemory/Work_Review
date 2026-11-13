export interface ReportRequestSnapshot {
  readonly requestId: number;
  readonly targetDate: string;
  readonly targetLocale: string;
  readonly targetCacheKey: string;
  readonly targetDeviceId: string | null;
}

export interface ReportGenerationOwnership {
  claim(requestId: number, reportGenerating: boolean): boolean;
  release(requestId: number): boolean;
}

function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftIsoDate(dateValue: string, offsetDays: number): string {
  const next = new Date(`${dateValue}T12:00:00`);
  next.setDate(next.getDate() + offsetDays);
  return formatIsoDate(next);
}

export function createReportRequestSnapshot(
  requestId: number,
  selectedDate: string,
  locale: string,
  deviceId: string | null = null,
): ReportRequestSnapshot {
  return {
    requestId,
    targetDate: selectedDate,
    targetLocale: locale,
    targetCacheKey: `${selectedDate}:${locale}:${deviceId || 'all'}`,
    targetDeviceId: deviceId,
  };
}

export function createReportGenerationOwnership(): ReportGenerationOwnership {
  let ownerRequestId: number | null = null;

  return {
    claim(requestId, reportGenerating) {
      if (ownerRequestId !== null || reportGenerating) return false;
      ownerRequestId = requestId;
      return true;
    },
    release(requestId) {
      if (ownerRequestId !== requestId) return false;
      ownerRequestId = null;
      return true;
    },
  };
}
