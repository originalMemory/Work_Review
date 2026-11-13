export interface TimelineActivity {
  readonly id: number | null;
  readonly timestamp: number;
  readonly app_name: string;
  readonly window_title: string;
  readonly screenshot_path: string;
  readonly ocr_text: string | null;
  readonly category: string;
  readonly duration: number;
  readonly browser_url: string | null;
  readonly executable_path: string | null;
  readonly semantic_category: string | null;
  readonly semantic_confidence: number | null;
  readonly screenshot_url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function isTimelineActivity(value: unknown): value is TimelineActivity {
  if (!isRecord(value)) return false;

  return (value.id === null || isFiniteNumber(value.id))
    && isFiniteNumber(value.timestamp)
    && typeof value.app_name === 'string'
    && typeof value.window_title === 'string'
    && typeof value.screenshot_path === 'string'
    && isNullableString(value.ocr_text)
    && typeof value.category === 'string'
    && isFiniteNumber(value.duration)
    && isNullableString(value.browser_url)
    && isNullableString(value.executable_path)
    && isNullableString(value.semantic_category)
    && (value.semantic_confidence === null || isFiniteNumber(value.semantic_confidence))
    && (value.screenshot_url === undefined || typeof value.screenshot_url === 'string');
}

export function parseTimelineActivities(value: unknown): TimelineActivity[] {
  if (!Array.isArray(value) || !value.every(isTimelineActivity)) {
    throw new TypeError('时间线活动载荷格式无效');
  }
  return value;
}

function getActivityGroupKey(activity: TimelineActivity): string {
  const appName = activity.app_name || '';
  const browserUrl = activity.browser_url;
  const normalizedUrl = browserUrl ? browserUrl.replace(/\/+$/, '') : '';
  if (browserUrl && browserUrl.trim()) {
    return `url:${appName}|${normalizedUrl}`;
  }
  return `app:${appName}|${activity.window_title || ''}`;
}

export function prepareTimelineActivities(
  activitiesData: readonly TimelineActivity[],
): TimelineActivity[] {
  return [...activitiesData].sort((a, b) => {
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }
    return (b.id || 0) - (a.id || 0);
  });
}

export function upsertTimelineActivity(
  currentActivities: readonly TimelineActivity[],
  newActivity: TimelineActivity,
): TimelineActivity[] {
  const existingById = newActivity.id === null
    ? -1
    : currentActivities.findIndex((activity) => activity.id === newActivity.id);
  if (existingById >= 0) {
    return currentActivities.map((activity) =>
      activity.id === newActivity.id ? newActivity : activity
    );
  }

  // 后端时间线按应用和 URL/窗口标题聚合；实时新行应刷新已有聚合项。
  const newGroupKey = getActivityGroupKey(newActivity);
  const existingByGroup = currentActivities.findIndex(
    (activity) => getActivityGroupKey(activity) === newGroupKey
  );
  if (existingByGroup >= 0) {
    const existing = currentActivities[existingByGroup];
    const merged: TimelineActivity = {
      ...existing,
      timestamp: newActivity.timestamp,
      screenshot_path: newActivity.screenshot_path || existing.screenshot_path,
    };
    return prepareTimelineActivities(
      currentActivities.map((activity, index) =>
        index === existingByGroup ? merged : activity
      )
    );
  }

  return prepareTimelineActivities([newActivity, ...currentActivities]);
}
