import { writable, type Readable } from 'svelte/store';

export interface CacheActivity {
  readonly id: number | null;
}

export interface CacheEntry<TData = unknown> {
  data: TData;
  timestamp: number;
}

export interface OverviewCacheEntry<TData = unknown>
  extends CacheEntry<TData | null> {
  loading: boolean;
  date: string | null;
}

export interface TimelineCacheEntry<
  TActivity extends CacheActivity = CacheActivity,
  TSummary = unknown,
> extends CacheEntry<TActivity[]> {
  summaries: TSummary[];
}

export interface CacheState {
  overview: OverviewCacheEntry;
  timeline: Record<string, TimelineCacheEntry>;
  reports: Record<string, CacheEntry>;
  hourlySummaries: Record<string, unknown>;
  reportGenerating: boolean;
  config: unknown | null;
}

export type CacheInvalidationType = 'overview' | 'timeline' | 'report';
export type CacheValidityKey = 'overview' | 'timeline' | 'reports';

export interface CacheStore {
  subscribe: Readable<CacheState>['subscribe'];
  isValid(state: CacheState, key: 'overview'): boolean;
  isValid(
    entry: CacheEntry | null | undefined,
    key?: CacheValidityKey | null,
  ): boolean;
  setOverview: (data: unknown) => void;
  setTimeline: (
    date: string,
    data: CacheActivity[],
    summaries: unknown[],
  ) => void;
  setReport: (date: string, data: unknown) => void;
  setReportGenerating: (generating: boolean) => void;
  setConfig: (data: unknown | null) => void;
  addActivity: (activity: CacheActivity) => void;
  clear: () => void;
  invalidate: (type: CacheInvalidationType, date?: string | null) => void;
}

const CACHE_TTL: Record<CacheValidityKey | 'default', number> = {
  overview: 15_000,
  timeline: 30_000,
  reports: 300_000,
  default: 30_000,
};

const MAX_CACHE_DAYS = 7;

function getLocalDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createInitialState(): CacheState {
  return {
    overview: {
      data: null,
      timestamp: 0,
      loading: false,
      date: null,
    },
    timeline: {},
    reports: {},
    hourlySummaries: {},
    reportGenerating: false,
    config: null,
  };
}

function evictOldEntries<TEntry>(
  entries: Record<string, TEntry>,
  currentDate: string,
): Record<string, TEntry> {
  if (Object.keys(entries).length <= MAX_CACHE_DAYS) {
    return entries;
  }

  // 日报 key 可能带有 locale 后缀，淘汰时只比较日期部分。
  const baseDate = String(currentDate).split(':')[0];
  const cutoff = new Date(`${baseDate}T12:00:00`);
  if (Number.isNaN(cutoff.getTime())) {
    return entries;
  }

  cutoff.setDate(cutoff.getDate() - MAX_CACHE_DAYS);
  const cutoffString = [
    cutoff.getFullYear(),
    String(cutoff.getMonth() + 1).padStart(2, '0'),
    String(cutoff.getDate()).padStart(2, '0'),
  ].join('-');
  const filtered: Record<string, TEntry> = {};

  for (const [key, value] of Object.entries(entries)) {
    if (String(key).split(':')[0] >= cutoffString) {
      filtered[key] = value;
    }
  }

  return filtered;
}

function isCacheValid(state: CacheState, key: 'overview'): boolean;
function isCacheValid(
  entry: CacheEntry | null | undefined,
  key?: CacheValidityKey | null,
): boolean;
function isCacheValid(
  cache: unknown,
  key: CacheValidityKey | null = null,
): boolean {
  if (!cache || typeof cache !== 'object') {
    return false;
  }

  const cacheRecord = cache as Record<string, unknown>;
  const data = key !== null && cacheRecord[key] !== undefined
    ? cacheRecord[key]
    : cache;

  if (!data || typeof data !== 'object') {
    return false;
  }

  const entry = data as { timestamp?: unknown; date?: unknown };
  if (!entry.timestamp) {
    return false;
  }

  if (
    key === 'overview'
    && entry.date
    && entry.date !== getLocalDateString()
  ) {
    return false;
  }

  const ttl = key ? CACHE_TTL[key] : CACHE_TTL.default;
  return Date.now() - Number(entry.timestamp) < ttl;
}

function createCache(): CacheStore {
  const { subscribe, set, update } = writable<CacheState>(createInitialState());

  return {
    subscribe,
    isValid: isCacheValid,

    setOverview(data) {
      update((state) => ({
        ...state,
        overview: {
          data,
          timestamp: Date.now(),
          loading: false,
          date: getLocalDateString(),
        },
      }));
    },

    setTimeline(date, data, summaries) {
      update((state) => {
        const timeline = {
          ...evictOldEntries(state.timeline, date),
          [date]: { data, summaries, timestamp: Date.now() },
        };
        return { ...state, timeline };
      });
    },

    setReport(date, data) {
      update((state) => {
        const reports = {
          ...evictOldEntries(state.reports, date),
          [date]: { data, timestamp: Date.now() },
        };
        return { ...state, reports };
      });
    },

    setReportGenerating(generating) {
      update((state) => ({ ...state, reportGenerating: generating }));
    },

    setConfig(data) {
      update((state) => ({ ...state, config: data }));
    },

    addActivity(activity) {
      update((state) => {
        const today = getLocalDateString();
        const cachedTimeline = state.timeline[today];
        if (!cachedTimeline) {
          return state;
        }

        const existing = cachedTimeline.data || [];
        if (
          activity.id != null
          && existing.some((item) => item.id === activity.id)
        ) {
          return state;
        }

        return {
          ...state,
          timeline: {
            ...state.timeline,
            [today]: {
              ...cachedTimeline,
              data: [activity, ...existing],
              timestamp: Date.now(),
            },
          },
        };
      });
    },

    clear() {
      set(createInitialState());
    },

    invalidate(type, date = null) {
      update((state) => {
        if (type === 'overview') {
          return {
            ...state,
            overview: { ...state.overview, timestamp: 0 },
          };
        }

        if (type === 'timeline' && date) {
          const timeline = { ...state.timeline };
          delete timeline[date];
          return { ...state, timeline };
        }

        if (type === 'report' && date) {
          const reports = { ...state.reports };
          delete reports[date];
          return { ...state, reports };
        }

        return state;
      });
    },
  };
}

export const cache: CacheStore = createCache();
export const getLocalDate: () => string = getLocalDateString;
