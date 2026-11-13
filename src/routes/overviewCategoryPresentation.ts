export interface CategoryHourlySegmentInput {
  readonly category?: unknown;
  readonly duration?: unknown;
}

export interface CategoryHourlyAppInput {
  readonly app_name?: unknown;
  readonly category?: unknown;
  readonly duration?: unknown;
}

export interface CategoryAppBucketInput {
  readonly apps?: readonly (CategoryHourlyAppInput | null | undefined)[] | null;
}

export type CategoryCompositionTotalsInput = Readonly<Record<string, unknown>>;

export type CategoryHourlyBreakdownInput = Readonly<
  Record<
    string,
    readonly (CategoryHourlySegmentInput | null | undefined)[] | null | undefined
  >
>;

export interface CategoryCompositionSummaryOptions {
  readonly category?: unknown;
  readonly compositionTotals?: CategoryCompositionTotalsInput | null;
  readonly hourlyBreakdown?: CategoryHourlyBreakdownInput | null;
  readonly appBreakdown?: readonly (CategoryAppBucketInput | null | undefined)[] | null;
  readonly primaryAppLimit?: number;
}

export interface CategoryActiveRange {
  readonly startHour: number;
  readonly endHour: number;
  readonly duration: number;
}

export interface CategoryPrimaryApp {
  readonly appName: string;
  readonly duration: number;
}

export interface CategoryCompositionSummary {
  readonly category: string;
  readonly duration: number;
  readonly percentage: number;
  readonly activeRange: CategoryActiveRange | null;
  readonly primaryApps: CategoryPrimaryApp[];
}

interface ActiveRangeAccumulator {
  startHour: number;
  endHour: number;
  duration: number;
}

function toDuration(value: unknown): number {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function findPrimaryActiveRange(
  category: string,
  hourlyBreakdown: CategoryHourlyBreakdownInput | null | undefined,
): CategoryActiveRange | null {
  const activeHours = Object.entries(hourlyBreakdown || {})
    .map(([hour, segments]) => ({
      hour: Number(hour),
      duration: (segments || [])
        .filter((segment) => segment?.category === category)
        .reduce((sum, segment) => sum + toDuration(segment?.duration), 0),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.hour)
        && item.hour >= 0
        && item.hour <= 23
        && item.duration > 0
    )
    .sort((left, right) => left.hour - right.hour);

  if (activeHours.length === 0) return null;

  const ranges: ActiveRangeAccumulator[] = [];
  let current: ActiveRangeAccumulator | null = null;
  for (const item of activeHours) {
    if (!current || item.hour !== current.endHour + 1) {
      current = { startHour: item.hour, endHour: item.hour, duration: item.duration };
      ranges.push(current);
      continue;
    }
    current.endHour = item.hour;
    current.duration += item.duration;
  }

  return ranges.sort(
    (left, right) => right.duration - left.duration || left.startHour - right.startHour,
  )[0];
}

function collectPrimaryApps(
  category: string,
  appBreakdown: readonly (CategoryAppBucketInput | null | undefined)[] | null | undefined,
  limit: number,
): CategoryPrimaryApp[] {
  const totals = new Map<string, number>();
  for (const bucket of appBreakdown || []) {
    for (const app of bucket?.apps || []) {
      if (app?.category !== category) continue;
      const appName = String(app?.app_name || '').trim();
      if (!appName) continue;
      totals.set(appName, (totals.get(appName) || 0) + toDuration(app?.duration));
    }
  }

  return [...totals.entries()]
    .map(([appName, duration]) => ({ appName, duration }))
    .filter((app) => app.duration > 0)
    .sort((left, right) => right.duration - left.duration || left.appName.localeCompare(right.appName))
    .slice(0, limit);
}

export function buildCategoryCompositionSummary({
  category,
  compositionTotals = {},
  hourlyBreakdown = {},
  appBreakdown = [],
  primaryAppLimit = 3,
}: CategoryCompositionSummaryOptions = {}): CategoryCompositionSummary {
  const categoryKey = String(category || '');
  const duration = toDuration(compositionTotals?.[categoryKey]);
  const totalDuration = Object.values(compositionTotals || {})
    .reduce<number>((sum, value) => sum + toDuration(value), 0);

  return {
    category: categoryKey,
    duration,
    percentage: totalDuration > 0 ? Math.round((duration / totalDuration) * 100) : 0,
    activeRange: findPrimaryActiveRange(categoryKey, hourlyBreakdown),
    primaryApps: collectPrimaryApps(categoryKey, appBreakdown, Math.max(0, primaryAppLimit)),
  };
}
