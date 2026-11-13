import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import type { AppIconInvoke } from './iconCache.ts';

const VALID_ICON = 'a'.repeat(101);
let importSequence = 0;

type IconCacheModule = typeof import('./iconCache.ts');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface ControlledIconRequest {
  appName: string;
  resolved: boolean;
  resolve: (value: string) => void;
}

interface QueuedIconRequest {
  appName: string;
  request: Deferred<string>;
}

interface StorageOverrides {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => {
    throw new Error('Deferred 尚未初始化');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createStorage(overrides: StorageOverrides = {}): Storage {
  const values = new Map<string, string>();

  return {
    get length(): number {
      return values.size;
    },
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return overrides.getItem?.(key) ?? values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      if (overrides.setItem) {
        overrides.setItem(key, value);
        return;
      }
      values.set(key, value);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePersistedKeys(serialized: string): string[] {
  const persisted: unknown = JSON.parse(serialized);
  assert.ok(isRecord(persisted));
  assert.ok(Array.isArray(persisted.items));

  return persisted.items.map((item: unknown) => {
    assert.ok(isRecord(item));
    assert.ok(typeof item.key === 'string');
    return item.key;
  });
}

async function importFresh(label: string): Promise<IconCacheModule> {
  importSequence += 1;
  const moduleUrl = new URL(
    `./iconCache.ts?${label}=${Date.now()}-${importSequence}`,
    import.meta.url,
  );
  return import(moduleUrl.href);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_500,
): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withWindow<T>(
  localStorage: Storage,
  callback: () => Promise<T>,
): Promise<T> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { localStorage },
  });

  try {
    return await callback();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

test('图标请求应统一字符串、camelCase、snake_case 与浏览器别名', async () => {
  const { getIconCacheKey } = await importFresh('normalize');

  assert.equal(getIconCacheKey('Safari'), 'Safari');
  assert.equal(
    getIconCacheKey({ appName: 'Safari', executablePath: '/Applications/Safari.app' }),
    'Safari::/Applications/Safari.app',
  );
  assert.equal(
    getIconCacheKey({ app_name: 'Safari', executable_path: '/Applications/Safari.app' }),
    'Safari::/Applications/Safari.app',
  );
  assert.equal(
    getIconCacheKey({ browser_name: 'Safari', executable_path: '/Applications/Safari.app' }),
    'Safari::/Applications/Safari.app',
  );
  assert.equal(getIconCacheKey(null), '');
});

test('持久化恢复应过滤损坏项、短图标与重复 key', async () => {
  const stored = JSON.stringify({
    items: [
      null,
      { key: 1, value: VALID_ICON },
      { key: 'short', value: 'small' },
      { key: 'Safari', value: VALID_ICON },
      { key: 'Safari', value: 'b'.repeat(101) },
    ],
  });

  await withWindow(createStorage({
    getItem: () => stored,
    setItem: () => {},
  }), async () => {
    const { appIconStore } = await importFresh('restore');
    assert.deepEqual(get(appIconStore), { Safari: VALID_ICON });
  });
});

test('同 key 应在排队和执行期间去重，且并发请求最多为三个', async () => {
  const { appIconStore, loadAppIcon } = await importFresh('concurrency');
  const started: string[] = [];
  const requests: ControlledIconRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const invoke: AppIconInvoke = async (_command, { appName }) => {
    started.push(appName);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const request = deferred<string>();
    requests.push({
      appName,
      resolved: false,
      resolve(value: string): void {
        active -= 1;
        request.resolve(value);
      },
    });
    return request.promise;
  };

  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    loadAppIcon(name, invoke);
  }
  loadAppIcon('A', invoke);

  assert.deepEqual(started, ['A', 'B', 'C']);
  assert.equal(maxActive, 3);

  for (let expectedStarts = 4; expectedStarts <= 6; expectedStarts += 1) {
    const request = requests.find((item) => active > 0 && !item.resolved);
    assert.ok(request);
    request.resolved = true;
    request.resolve(VALID_ICON);
    await waitFor(
      () => started.length === expectedStarts,
      `等待第 ${expectedStarts} 个图标请求启动超时`,
    );
  }

  for (const request of requests) {
    if (!request.resolved) {
      request.resolved = true;
      request.resolve(VALID_ICON);
    }
  }

  await waitFor(
    () => Object.keys(get(appIconStore)).length === 6,
    '等待全部图标写入 Store 超时',
  );
  assert.equal(maxActive, 3);
  assert.equal(started.filter((name) => name === 'A').length, 1);
});

test('多个请求完成后应在一百毫秒内合并为一次 Store 刷新', async () => {
  const { appIconStore, loadAppIcon } = await importFresh('store-batch');
  let emissions = 0;
  const unsubscribe = appIconStore.subscribe(() => {
    emissions += 1;
  });

  try {
    const invoke = async () => VALID_ICON;
    loadAppIcon('Batch A', invoke);
    loadAppIcon('Batch B', invoke);
    loadAppIcon('Batch C', invoke);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(emissions, 1, '一百毫秒窗口内不应逐个刷新 Store');

    await waitFor(() => emissions === 2, '等待合并后的 Store 刷新超时');
    assert.deepEqual(Object.keys(get(appIconStore)).sort(), [
      'Batch A',
      'Batch B',
      'Batch C',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(emissions, 2, '同一批完成请求只能触发一次 Store 刷新');
  } finally {
    unsubscribe();
  }
});

test('队列饱和时 priority 请求应先于普通排队请求执行', async () => {
  const { loadAppIcon } = await importFresh('priority');
  const started: string[] = [];
  const requests: QueuedIconRequest[] = [];
  const invoke: AppIconInvoke = async (_command, { appName }) => {
    started.push(appName);
    const request = deferred<string>();
    requests.push({ appName, request });
    return request.promise;
  };

  for (const name of ['A', 'B', 'C']) loadAppIcon(name, invoke);
  loadAppIcon('normal', invoke);
  loadAppIcon('priority', invoke, { priority: true });

  const firstRequest = requests[0];
  assert.ok(firstRequest);
  firstRequest.request.resolve(VALID_ICON);
  await waitFor(() => started.length === 4, '等待优先图标请求启动超时');
  assert.equal(started[3], 'priority');

  for (const { request } of requests) request.resolve(VALID_ICON);
  await waitFor(() => started.length === 5, '等待普通排队请求启动超时');
  const lastRequest = requests.at(-1);
  assert.ok(lastRequest);
  lastRequest.request.resolve(VALID_ICON);
});

test('失败图标应冷却三十秒并在边界时间允许重试', async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  try {
    const { appIconStore, loadAppIcon } = await importFresh('cooldown');
    let invokeCount = 0;
    const invoke = async () => {
      invokeCount += 1;
      return invokeCount === 1 ? '' : VALID_ICON;
    };

    loadAppIcon('Retry App', invoke);
    await waitFor(
      () => get(appIconStore)['Retry App'] === null,
      '等待失败图标写入 Store 超时',
    );

    now += 29_999;
    loadAppIcon('Retry App', invoke);
    assert.equal(invokeCount, 1);

    now += 1;
    loadAppIcon('Retry App', invoke);
    await waitFor(
      () => get(appIconStore)['Retry App'] === VALID_ICON,
      '等待失败图标重试成功超时',
    );
    assert.equal(invokeCount, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('缓存命中应更新 LRU，新增图标时淘汰真正最旧的条目', async () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    key: `app-${index}`,
    value: `${VALID_ICON}${index}`,
  }));

  await withWindow(createStorage({
    getItem: () => JSON.stringify({ items }),
    setItem: () => {},
  }), async () => {
    const { appIconStore, loadAppIcon } = await importFresh('lru');
    let invokeCount = 0;
    const invoke = async () => {
      invokeCount += 1;
      return VALID_ICON;
    };

    loadAppIcon('app-0', invoke);
    loadAppIcon('app-new', invoke);

    await waitFor(
      () => get(appIconStore)['app-new'] === VALID_ICON,
      '等待新图标写入 LRU Store 超时',
    );
    const state = get(appIconStore);
    assert.equal(invokeCount, 1);
    assert.equal(Object.keys(state).length, 120);
    assert.ok(state['app-0']);
    assert.equal(state['app-1'], undefined);
  });
});

test('高分辨率图标持久化应受总字符预算限制', async () => {
  let latestPersistedKey = '';
  let latestPersistedValue = '';
  let persistedCount = 0;
  const allPersisted = deferred<void>();

  await withWindow(createStorage({
    getItem: () => null,
    setItem: (key: string, value: string) => {
      latestPersistedKey = key;
      latestPersistedValue = value;
      persistedCount += 1;
      if (persistedCount === 3) allPersisted.resolve();
    },
  }), async () => {
    const { loadAppIcon } = await importFresh('budget');
    const largeIcon = 'a'.repeat(700_000);
    const invoke = async () => largeIcon;

    loadAppIcon('First App', invoke);
    loadAppIcon('Second App', invoke);
    loadAppIcon('Third App', invoke);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      allPersisted.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('等待图标持久化超时')), 1_000);
      }),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);

    assert.ok(latestPersistedValue.length > 0, '应写入至少一个有效图标');
    assert.equal(latestPersistedKey, 'work-review-app-icon-cache-v4');
    assert.ok(
      latestPersistedValue.length <= 1_500_000,
      `持久化内容不得超过字符预算，实际为 ${latestPersistedValue.length}`,
    );
    assert.deepEqual(
      parsePersistedKeys(latestPersistedValue),
      ['Second App', 'Third App'],
      '应以旧到新的顺序保留预算内最近使用的图标',
    );
  });
});

test('持久化缓存应只保留最近使用的三十六项', async () => {
  let latestPersistedValue = '';
  let persistedCount = 0;
  const allPersisted = deferred<void>();

  await withWindow(createStorage({
    getItem: () => null,
    setItem: (_key: string, value: string) => {
      latestPersistedValue = value;
      persistedCount += 1;
      if (persistedCount === 37) allPersisted.resolve();
    },
  }), async () => {
    const { loadAppIcon } = await importFresh('persistent-limit');
    const invoke: AppIconInvoke = async (_command, { appName }) => (
      `${VALID_ICON}${appName}`
    );

    for (let index = 0; index < 37; index += 1) {
      loadAppIcon(`app-${index}`, invoke);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      allPersisted.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('等待三十七个图标持久化超时')),
          1_000,
        );
      }),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);

    const persistedKeys = parsePersistedKeys(latestPersistedValue);
    assert.equal(persistedKeys.length, 36);
    assert.deepEqual(
      persistedKeys,
      Array.from({ length: 36 }, (_, index) => `app-${index + 1}`),
    );
  });
});
