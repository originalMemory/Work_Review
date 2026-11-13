import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTimelineActivities,
  prepareTimelineActivities,
  upsertTimelineActivity,
  type TimelineActivity,
} from './timelineData.ts';

function activity(overrides: Partial<TimelineActivity>): TimelineActivity {
  return {
    id: null,
    timestamp: 0,
    app_name: '',
    window_title: '',
    screenshot_path: '',
    ocr_text: null,
    category: '',
    duration: 0,
    browser_url: null,
    executable_path: null,
    semantic_category: null,
    semantic_confidence: null,
    ...overrides,
  };
}

test('时间线外部载荷应只接收结构完整的活动数组', () => {
  const valid = activity({
    id: 1,
    timestamp: 1710000010,
    app_name: 'Code',
    window_title: 'timelineData.test.ts',
  });

  assert.deepEqual(parseTimelineActivities([valid]), [valid]);
  assert.throws(
    () => parseTimelineActivities(null),
    /时间线活动载荷格式无效/
  );
  assert.throws(
    () => parseTimelineActivities([{ ...valid, timestamp: '1710000010' }]),
    /时间线活动载荷格式无效/
  );
});

test('时间线不应按应用名二次合并不同窗口记录', () => {
  const input = [
    activity({
      id: 101,
      timestamp: 1710000010,
      app_name: 'Windows Terminal',
      window_title: 'npm run tauri dev',
      screenshot_path: 'screenshots/2026-03-29/0010.jpg',
      duration: 240,
      browser_url: null,
    }),
    activity({
      id: 102,
      timestamp: 1710000090,
      app_name: 'Windows Terminal',
      window_title: 'cargo test',
      screenshot_path: 'screenshots/2026-03-29/0090.jpg',
      duration: 180,
      browser_url: null,
    }),
  ];

  const result = prepareTimelineActivities(input);

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => item.id),
    [102, 101]
  );
});

test('实时更新只按 id 覆盖，否则应插入新活动', () => {
  const current = [
    activity({
      id: 201,
      timestamp: 1710000010,
      app_name: 'Windows Terminal',
      window_title: 'npm run tauri dev',
      screenshot_path: 'screenshots/2026-03-29/0010.jpg',
      duration: 240,
      browser_url: null,
    }),
  ];

  const appended = upsertTimelineActivity(current, activity({
    id: 202,
    timestamp: 1710000100,
    app_name: 'Windows Terminal',
    window_title: 'cargo test',
    screenshot_path: 'screenshots/2026-03-29/0100.jpg',
    duration: 60,
    browser_url: null,
  }));

  assert.equal(appended.length, 2);
  assert.equal(appended[0].id, 202);
  assert.equal(appended[1].id, 201);

  const replaced = upsertTimelineActivity(appended, activity({
    id: 202,
    timestamp: 1710000160,
    app_name: 'Windows Terminal',
    window_title: 'cargo test --lib',
    screenshot_path: 'screenshots/2026-03-29/0160.jpg',
    duration: 120,
    browser_url: null,
  }));

  assert.equal(replaced.length, 2);
  assert.equal(replaced[0].id, 202);
  assert.equal(replaced[0].window_title, 'cargo test --lib');
  assert.equal(replaced[0].screenshot_path, 'screenshots/2026-03-29/0160.jpg');
});

test('没有数据库 id 的不同实时活动应全部保留', () => {
  const current = [
    activity({
      id: null,
      timestamp: 1710000010,
      app_name: 'Terminal',
      window_title: '[内容已脱敏]',
      screenshot_path: '',
      duration: 60,
      browser_url: null,
    }),
  ];

  const result = upsertTimelineActivity(current, activity({
    id: null,
    timestamp: 1710000100,
    app_name: 'Code',
    window_title: '[内容已脱敏]',
    screenshot_path: '',
    duration: 90,
    browser_url: null,
  }));

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.app_name), ['Code', 'Terminal']);
});

test('没有数据库 id 的同分组实时活动仍应刷新聚合项', () => {
  const current = [
    activity({
      id: null,
      timestamp: 1710000010,
      app_name: 'Terminal',
      window_title: '[内容已脱敏]',
      screenshot_path: '',
      duration: 60,
      browser_url: null,
    }),
  ];

  const result = upsertTimelineActivity(current, {
    ...current[0],
    timestamp: 1710000100,
    duration: 90,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, null);
  assert.equal(result[0].duration, 60);
  assert.equal(result[0].timestamp, 1710000100);
});

test('同分组但数据库 id 不同时应更新聚合项并保留聚合身份和时长', () => {
  const current = [
    activity({
      id: 301,
      timestamp: 1710000010,
      app_name: 'Safari',
      window_title: 'Work Review',
      screenshot_path: 'screenshots/2026-03-29/0010.jpg',
      duration: 120,
      browser_url: 'https://example.com/work/',
    }),
  ];

  const result = upsertTimelineActivity(current, activity({
    id: 302,
    timestamp: 1710000100,
    app_name: 'Safari',
    window_title: 'Work Review',
    screenshot_path: 'screenshots/2026-03-29/0100.jpg',
    duration: 45,
    browser_url: 'https://example.com/work',
  }));

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 301);
  assert.equal(result[0].duration, 120);
  assert.equal(result[0].timestamp, 1710000100);
  assert.equal(result[0].screenshot_path, 'screenshots/2026-03-29/0100.jpg');
});

test('时间线排序和实时更新不应修改输入数组', () => {
  const first = activity({
    id: 401,
    timestamp: 1710000010,
    app_name: 'Code',
    window_title: 'timelineData.test.ts',
    screenshot_path: '',
    duration: 60,
    browser_url: null,
  });
  const second = {
    ...first,
    id: 402,
    timestamp: 1710000100,
  };
  const unsorted = [first, second];
  const current = [first];

  const sorted = prepareTimelineActivities(unsorted);
  const updated = upsertTimelineActivity(current, second);

  assert.deepEqual(unsorted, [first, second]);
  assert.deepEqual(current, [first]);
  assert.notStrictEqual(sorted, unsorted);
  assert.notStrictEqual(updated, current);
});
