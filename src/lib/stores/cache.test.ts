import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import { cache, getLocalDate, type CacheActivity } from './cache.ts';

type TitledCacheActivity = CacheActivity & { title: string };

function titledActivity(id: number | null, title: string): TitledCacheActivity {
  return { id, title };
}

function hasTitle(activity: CacheActivity): activity is TitledCacheActivity {
  return 'title' in activity && typeof activity.title === 'string';
}

afterEach(() => {
  cache.clear();
});

test('概览缓存应按 TTL 校验并在跨日时失效', () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    cache.setOverview({ totalDuration: 120 });
    const state = get(cache);

    assert.equal(cache.isValid(state, 'overview'), true);

    now += 15_000;
    assert.equal(cache.isValid(state, 'overview'), false);
    assert.equal(
      cache.isValid({
        ...state,
        overview: { ...state.overview, date: '2000-01-01' },
      }, 'overview'),
      false,
    );
  } finally {
    Date.now = originalNow;
  }
});

test('日报条目应支持直接校验并使用五分钟 TTL', () => {
  const originalNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;

  try {
    cache.setReport('2026-08-09:en', { content: 'report' });
    const entry = get(cache).reports['2026-08-09:en'];

    now += 299_999;
    assert.equal(cache.isValid(entry, 'reports'), true);

    now += 1;
    assert.equal(cache.isValid(entry, 'reports'), false);
  } finally {
    Date.now = originalNow;
  }
});

test('按日期缓存应淘汰七天窗口之外的旧条目并保留日报 locale 后缀', () => {
  for (let day = 1; day <= 9; day += 1) {
    const date = `2026-08-${String(day).padStart(2, '0')}`;
    cache.setTimeline(date, [{ id: day }], []);
    cache.setReport(`${date}:zh-CN`, `report-${day}`);
  }

  const state = get(cache);
  assert.equal(state.timeline['2026-08-01'], undefined);
  assert.equal(state.reports['2026-08-01:zh-CN'], undefined);
  assert.deepEqual(Object.keys(state.timeline), [
    '2026-08-02',
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-08',
    '2026-08-09',
  ]);
  assert.equal(state.reports['2026-08-09:zh-CN'].data, 'report-9');
});

test('新增活动应只按非空 id 去重并把新活动放到最前面', () => {
  const today = getLocalDate();
  cache.setTimeline(today, [titledActivity(1, 'existing')], []);

  cache.addActivity(titledActivity(1, 'duplicate'));
  cache.addActivity(titledActivity(2, 'new'));
  cache.addActivity(titledActivity(null, 'anonymous-a'));
  cache.addActivity(titledActivity(null, 'anonymous-b'));

  const activities = get(cache).timeline[today].data;
  assert.ok(activities.every(hasTitle));
  assert.deepEqual(
    activities.map((activity) => activity.title),
    ['anonymous-b', 'anonymous-a', 'new', 'existing'],
  );
});

test('新增活动不应创建缺失的今日缓存或替换重复活动与摘要', () => {
  const today = getLocalDate();
  cache.setTimeline('2000-01-01', [{ id: 1 }], ['old-summary']);

  cache.addActivity(titledActivity(2, 'ignored'));
  assert.equal(get(cache).timeline[today], undefined);

  cache.setTimeline(today, [titledActivity(1, 'existing')], ['summary']);
  const stateBeforeDuplicate = get(cache);
  const summaries = stateBeforeDuplicate.timeline[today].summaries;

  cache.addActivity(titledActivity(1, 'replacement'));
  const stateAfterDuplicate = get(cache);

  assert.equal(stateAfterDuplicate, stateBeforeDuplicate);
  assert.deepEqual(stateAfterDuplicate.timeline[today].data, [
    { id: 1, title: 'existing' },
  ]);
  assert.equal(stateAfterDuplicate.timeline[today].summaries, summaries);
});

test('缓存 setter 应保留输入数据引用而不做隐式转换', () => {
  const overview = { totalDuration: 120 };
  const report = { content: 'report' };
  const config = { language: 'en' };
  const summaries = [{ hour: 9 }];
  const activities = [{ id: 1 }];

  cache.setOverview(overview);
  cache.setReport('2026-08-09:en', report);
  cache.setConfig(config);
  cache.setTimeline('2026-08-09', activities, summaries);

  const state = get(cache);
  assert.equal(state.overview.data, overview);
  assert.equal(state.reports['2026-08-09:en'].data, report);
  assert.equal(state.config, config);
  assert.equal(state.timeline['2026-08-09'].data, activities);
  assert.equal(state.timeline['2026-08-09'].summaries, summaries);
});

test('invalidate 应只失效目标缓存，clear 应恢复完整初始状态', () => {
  const today = getLocalDate();
  cache.setOverview({ totalDuration: 120 });
  cache.setTimeline(today, [{ id: 1 }], []);
  cache.setReport(`${today}:en`, 'report');
  cache.setReportGenerating(true);
  cache.setConfig({ language: 'en' });

  cache.invalidate('overview');
  cache.invalidate('timeline', today);
  cache.invalidate('report', `${today}:en`);

  let state = get(cache);
  assert.equal(state.overview.timestamp, 0);
  assert.equal(state.timeline[today], undefined);
  assert.equal(state.reports[`${today}:en`], undefined);
  assert.equal(state.reportGenerating, true);

  cache.clear();
  state = get(cache);
  assert.deepEqual(state, {
    overview: { data: null, timestamp: 0, loading: false, date: null },
    timeline: {},
    reports: {},
    hourlySummaries: {},
    reportGenerating: false,
    config: null,
  });
});
