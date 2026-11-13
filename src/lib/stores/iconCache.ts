import { writable, type Writable } from 'svelte/store';

export type AppIconCacheValue = string | null;
export type AppIconCacheState = Partial<Record<string, AppIconCacheValue>>;

export interface AppIconRequestEntry {
  appName?: string | null;
  app_name?: string | null;
  browserName?: string | null;
  browser_name?: string | null;
  executablePath?: string | null;
  executable_path?: string | null;
}

export type AppIconRequest =
  | string
  | AppIconRequestEntry
  | null
  | undefined;

export interface AppIconLoadOptions {
  priority?: boolean;
}

export interface GetAppIconArgs {
  appName: string;
  executablePath: string | null;
}

export type AppIconInvoke = (
  command: 'get_app_icon',
  args: GetAppIconArgs,
) => Promise<string>;

export type AppIconStore = Writable<AppIconCacheState>;

interface NormalizedAppIconRequest {
  appName: string;
  executablePath: string;
}

interface IconRequestQueueItem extends NormalizedAppIconRequest {
  cacheKey: string;
  invoke: AppIconInvoke;
}

interface PersistedIconCacheItem {
  key: string;
  value: string;
}

const MAX_ICON_CACHE = 120;
const MAX_PERSISTED_ICON_CACHE = 36;
const MAX_PERSISTED_ICON_CACHE_CHARS = 1_500_000;
const MAX_CONCURRENT_ICON_REQUESTS = 3;
const FAILED_ICON_RETRY_MS = 30 * 1_000;
// v4 对应后端 256px 高 DPI 图标，旧低分辨率缓存不能继续复用。
const STORAGE_KEY = 'work-review-app-icon-cache-v4';

const iconCache: AppIconCacheState = {};
const pendingRequests: Partial<Record<string, true>> = {};
const cacheKeys: string[] = [];
const requestQueue: IconRequestQueueItem[] = [];
const failedAt: Partial<Record<string, number>> = {};
let activeRequestCount = 0;
let storeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIconRequest(entry: AppIconRequest): NormalizedAppIconRequest {
  if (!entry) {
    return { appName: '', executablePath: '' };
  }

  if (typeof entry === 'string') {
    return { appName: entry, executablePath: '' };
  }

  return {
    appName:
      entry.appName
      || entry.app_name
      || entry.browserName
      || entry.browser_name
      || '',
    executablePath: entry.executablePath || entry.executable_path || '',
  };
}

export function getIconCacheKey(entry: AppIconRequest): string {
  const { appName, executablePath } = normalizeIconRequest(entry);
  return executablePath ? `${appName}::${executablePath}` : appName;
}

function loadPersistentIconCache(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const parsed: unknown = JSON.parse(raw);
    const items = isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : [];

    for (const item of items) {
      if (
        !isRecord(item)
        || typeof item.key !== 'string'
        || typeof item.value !== 'string'
      ) {
        continue;
      }

      if (item.value.length <= 100 || iconCache[item.key] !== undefined) {
        continue;
      }

      iconCache[item.key] = item.value;
      cacheKeys.push(item.key);
    }
  } catch (error) {
    console.warn('加载应用图标缓存失败:', error);
  }
}

function touchCacheKey(cacheKey: string): void {
  const index = cacheKeys.indexOf(cacheKey);
  if (index >= 0) {
    cacheKeys.splice(index, 1);
  }
  cacheKeys.push(cacheKey);
}

function pruneCache(): void {
  let scanned = 0;
  while (cacheKeys.length > MAX_ICON_CACHE && scanned < cacheKeys.length) {
    const oldest = cacheKeys.shift();
    if (oldest === undefined) {
      return;
    }

    // 排队或请求中的 key 必须保留，否则可能重复发起同一请求。
    if (pendingRequests[oldest]) {
      cacheKeys.push(oldest);
      scanned += 1;
      continue;
    }

    delete iconCache[oldest];
    delete failedAt[oldest];
  }
}

function persistIconCache(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const items: PersistedIconCacheItem[] = [];
    let persistedChars = JSON.stringify({ items: [] }).length;

    for (let index = cacheKeys.length - 1; index >= 0; index -= 1) {
      if (items.length >= MAX_PERSISTED_ICON_CACHE) {
        break;
      }

      const key = cacheKeys[index];
      const value = iconCache[key];
      if (typeof value !== 'string' || value.length <= 100) {
        continue;
      }

      const item = { key, value };
      const itemChars = JSON.stringify(item).length + (items.length > 0 ? 1 : 0);
      if (persistedChars + itemChars > MAX_PERSISTED_ICON_CACHE_CHARS) {
        continue;
      }

      items.push(item);
      persistedChars += itemChars;
    }

    items.reverse();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
  } catch (error) {
    console.warn('保存应用图标缓存失败:', error);
  }
}

loadPersistentIconCache();
pruneCache();

export const appIconStore: AppIconStore = writable({ ...iconCache });

function updateIconStore(): void {
  if (storeFlushTimer) {
    return;
  }

  storeFlushTimer = setTimeout(() => {
    storeFlushTimer = null;
    appIconStore.set({ ...iconCache });
  }, 100);
}

function runNextIconRequest(): void {
  while (
    activeRequestCount < MAX_CONCURRENT_ICON_REQUESTS
    && requestQueue.length > 0
  ) {
    const next = requestQueue.shift();
    if (!next) {
      return;
    }

    activeRequestCount += 1;

    void (async () => {
      const {
        cacheKey,
        appName,
        executablePath,
        invoke,
      } = next;

      try {
        const base64 = await invoke('get_app_icon', {
          appName,
          executablePath: executablePath || null,
        });

        if (base64 && base64.length > 100) {
          iconCache[cacheKey] = base64;
          delete failedAt[cacheKey];
        } else {
          iconCache[cacheKey] = null;
          failedAt[cacheKey] = Date.now();
        }

        touchCacheKey(cacheKey);
        pruneCache();
        persistIconCache();
      } catch {
        iconCache[cacheKey] = null;
        failedAt[cacheKey] = Date.now();
        touchCacheKey(cacheKey);
        pruneCache();
        persistIconCache();
      } finally {
        delete pendingRequests[cacheKey];
        activeRequestCount -= 1;
        updateIconStore();
        runNextIconRequest();
      }
    })();
  }
}

export function loadAppIcon(
  entry: AppIconRequest,
  invoke: AppIconInvoke,
  options: AppIconLoadOptions = {},
): void {
  const { appName, executablePath } = normalizeIconRequest(entry);
  if (!appName) {
    return;
  }

  const cacheKey = getIconCacheKey({ appName, executablePath });
  if (iconCache[cacheKey] !== undefined) {
    if (iconCache[cacheKey] !== null) {
      touchCacheKey(cacheKey);
      return;
    }

    const lastFailedAt = failedAt[cacheKey] || 0;
    if (Date.now() - lastFailedAt < FAILED_ICON_RETRY_MS) {
      return;
    }
  }

  if (pendingRequests[cacheKey]) {
    return;
  }
  pendingRequests[cacheKey] = true;

  const queueItem = {
    cacheKey,
    appName,
    executablePath,
    invoke,
  };
  if (options.priority) {
    requestQueue.unshift(queueItem);
  } else {
    requestQueue.push(queueItem);
  }

  runNextIconRequest();
}

export function preloadAppIcons(
  entries: readonly AppIconRequest[] | null | undefined,
  invoke: AppIconInvoke,
  options: AppIconLoadOptions = {},
): void {
  const normalizedEntries = Array.isArray(entries)
    ? entries.filter(
        (entry): entry is string | AppIconRequestEntry => Boolean(entry),
      )
    : [];
  const queueEntries = options.priority
    ? normalizedEntries.slice().reverse()
    : normalizedEntries;

  queueEntries.forEach((entry) => loadAppIcon(entry, invoke, options));
}
