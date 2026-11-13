import test from 'node:test';
import assert from 'node:assert/strict';

import { createTimelineGateway, type InvokeUnknown } from './timelineGateway.ts';

const activity = {
  id: 1,
  timestamp: 1710000010,
  app_name: 'Code',
  window_title: 'timelineGateway.test.ts',
  screenshot_path: '',
  ocr_text: null,
  category: 'development',
  duration: 60,
  browser_url: null,
  executable_path: null,
  semantic_category: null,
  semantic_confidence: null,
};

const summary = {
  hour: 9,
  summary: '完成时间线网关测试',
  main_apps: 'Code',
  activity_count: 1,
  total_duration: 60,
};

test('时间线网关应固定命令参数并返回已验证载荷', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeUnknown: InvokeUnknown = async (command, args) => {
    calls.push({ command, args });
    return command === 'get_timeline' ? [activity] : [summary];
  };
  const gateway = createTimelineGateway(invokeUnknown);

  assert.deepEqual(
    await gateway.getPage({ date: '2026-08-11', limit: 20, offset: 0 }),
    [activity],
  );
  assert.deepEqual(await gateway.getHourlySummaries('2026-08-11'), [summary]);
  assert.deepEqual(calls, [
    {
      command: 'get_timeline',
      args: { date: '2026-08-11', limit: 20, offset: 0 },
    },
    {
      command: 'get_hourly_summaries',
      args: { date: '2026-08-11' },
    },
  ]);
});

test('时间线网关应拒绝字段漂移的活动和小时摘要', async () => {
  const invalidActivityGateway = createTimelineGateway(async () => [
    { ...activity, timestamp: '1710000010' },
  ]);
  const invalidSummaryGateway = createTimelineGateway(async () => [
    { ...summary, hour: '9' },
  ]);

  await assert.rejects(
    invalidActivityGateway.getPage({ date: '2026-08-11', limit: 20, offset: 0 }),
    /时间线活动载荷格式无效/,
  );
  await assert.rejects(
    invalidSummaryGateway.getHourlySummaries('2026-08-11'),
    /小时摘要载荷格式无效/,
  );
});

test('时间线网关不应吞掉底层调用错误', async () => {
  const transportError = new Error('invoke failed');
  const gateway = createTimelineGateway(async () => {
    throw transportError;
  });

  await assert.rejects(
    gateway.getHourlySummaries('2026-08-11'),
    (error: unknown) => error === transportError,
  );
});


test('时间线分页与小时摘要应透传同一设备筛选', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const gateway = createTimelineGateway(async (command, args) => {
    calls.push({ command, args });
    return command === 'get_timeline' ? [activity] : [summary];
  });
  await gateway.getPage({ date: '2026-11-13', limit: 20, offset: 20, deviceId: 'device-a' });
  await gateway.getHourlySummaries('2026-11-13', 'device-a');
  assert.deepEqual(calls, [
    { command: 'get_timeline', args: { date: '2026-11-13', limit: 20, offset: 20, deviceId: 'device-a' } },
    { command: 'get_hourly_summaries', args: { date: '2026-11-13', deviceId: 'device-a' } },
  ]);
});
