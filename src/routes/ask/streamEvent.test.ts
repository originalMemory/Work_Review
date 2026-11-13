import { test } from 'node:test';
import assert from 'node:assert';
import {
  reduceStreamEvent,
  type StreamMessage,
  type StreamReference,
  type StreamStep,
} from './streamEvent.ts';

type TestStreamMessage = StreamMessage & {
  steps: StreamStep[];
  references: StreamReference[];
  toolLabels: string[];
  streaming: boolean;
};

function baseMessage(overrides: StreamMessage = {}): TestStreamMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    ...overrides,
    steps: overrides.steps ?? [],
    references: overrides.references ?? [],
    toolLabels: overrides.toolLabels ?? [],
    streaming: overrides.streaming ?? true,
  };
}

function messageSteps(message: StreamMessage): StreamStep[] {
  assert.ok(message.steps);
  return message.steps;
}

test('stepStart 追加 running 工具步骤且不结束流', () => {
  const original = baseMessage();

  const result = reduceStreamEvent(original, {
    type: 'stepStart',
    tool: 'search_memory',
    label: '记忆检索',
  });

  assert.deepEqual(result.message.steps, [
    { tool: 'search_memory', label: '记忆检索', status: 'running' },
  ]);
  assert.equal(result.terminal, false);
  assert.deepEqual(original.steps, []);
});

test('stepResult 更新最近一个 running 且 tool 匹配的步骤并保留 ok=false', () => {
  const existingReference = { sourceId: 'old', timestamp: 1, title: '旧引用' };
  const incomingReference = { sourceId: 'new', timestamp: 2, title: '新引用' };
  const original = baseMessage({
    steps: [
      { tool: 'search_memory', status: 'done', ok: true, hits: 1 },
      { tool: 'search_memory', status: 'running' },
      { tool: 'aggregate_stats', status: 'running' },
      { tool: 'search_memory', status: 'running' },
    ],
    references: [existingReference],
  });

  const result = reduceStreamEvent(original, {
    type: 'stepResult',
    tool: 'search_memory',
    ok: false,
    hits: 0,
    references: [incomingReference],
  });

  const resultSteps = messageSteps(result.message);
  assert.deepEqual(resultSteps[0], original.steps[0]);
  assert.deepEqual(resultSteps[1], original.steps[1]);
  assert.deepEqual(resultSteps[2], original.steps[2]);
  assert.deepEqual(resultSteps[3], {
    tool: 'search_memory',
    status: 'done',
    ok: false,
    hits: 0,
    references: [incomingReference],
  });
  assert.deepEqual(result.message.references, [existingReference, incomingReference]);
  assert.equal(result.terminal, false);
  const originalStep = original.steps[3];
  assert.ok(originalStep);
  assert.equal(originalStep.status, 'running');
});

test('stepResult 缺少 ok 时保留未知状态', () => {
  const original = baseMessage({
    steps: [{ tool: 'search_memory', status: 'running' }],
  });

  const result = reduceStreamEvent(original, {
    type: 'stepResult',
    tool: 'search_memory',
    hits: 2,
    references: [],
  });

  const step = messageSteps(result.message)[0];
  assert.ok(step);
  assert.equal(step.ok, undefined);
  assert.equal(step.hits, 2);
});

test('stepResult 缺少或非法 hits 时保留未知命中数', () => {
  for (const hits of [undefined, null, '3', Number.NaN, -1]) {
    const original = baseMessage({
      steps: [{ tool: 'search_memory', status: 'running' }],
    });

    const result = reduceStreamEvent(original, {
      type: 'stepResult',
      tool: 'search_memory',
      ok: true,
      hits,
      references: [],
    });

    const step = messageSteps(result.message)[0];
    assert.ok(step);
    assert.equal(step.hits, undefined);
  }
});

test('stepResult 找不到匹配步骤时不误改其他步骤', () => {
  const original = baseMessage({
    steps: [
      { tool: 'search_memory', status: 'running' },
      { tool: 'aggregate_stats', status: 'done', ok: true, hits: 2 },
    ],
  });

  const result = reduceStreamEvent(original, {
    type: 'stepResult',
    tool: 'query_activities',
    ok: false,
    hits: 0,
    references: [],
  });

  assert.deepEqual(result.message.steps, original.steps);
  assert.equal(result.terminal, false);
});

test('token 追加文本且不结束流', () => {
  const result = reduceStreamEvent(
    baseMessage({ content: '你好' }),
    { type: 'token', token: '，世界' }
  );

  assert.equal(result.message.content, '你好，世界');
  assert.equal(result.message.streaming, true);
  assert.equal(result.terminal, false);
});

test('done 用完整答案覆盖增量文本并结束流', () => {
  const references = [{ sourceId: 'done', timestamp: 3, title: '最终引用' }];
  const result = reduceStreamEvent(
    baseMessage({
      content: '不完整答案',
      references: [{ sourceId: 'partial', timestamp: 1, title: '临时引用' }],
      toolLabels: ['旧工具'],
    }),
    {
      type: 'done',
      answer: '完整答案',
      references,
      toolLabels: ['记忆检索'],
    }
  );

  assert.equal(result.message.content, '完整答案');
  assert.deepEqual(result.message.references, references);
  assert.deepEqual(result.message.toolLabels, ['记忆检索']);
  assert.equal(result.message.streaming, false);
  assert.equal(result.terminal, true);
});

test('error 使用事件错误并结束流', () => {
  const result = reduceStreamEvent(
    baseMessage(),
    { type: 'error', error: '后端失败' },
    '请求失败'
  );

  assert.equal(result.message.content, '后端失败');
  assert.equal(result.message.streaming, false);
  assert.equal(result.message.failed, true);
  assert.equal(result.terminal, true);
});

test('error 实际数据库错误链应使用 fallbackError，避免流式事件绕过错误脱敏', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = reduceStreamEvent(
      baseMessage(),
      {
        type: 'error',
        error: 'AI分析错误: 查询失败: 数据库错误: no such table: activities',
      },
      '请求失败',
    );

    assert.equal(result.message.content, '请求失败');
    assert.equal(result.message.failed, true);
    assert.equal(result.terminal, true);
  } finally {
    console.error = originalConsoleError;
  }
});

test('error 缺少错误文本时使用 fallbackError', () => {
  const result = reduceStreamEvent(baseMessage(), { type: 'error' }, '请求失败');

  assert.equal(result.message.content, '请求失败');
  assert.equal(result.message.streaming, false);
  assert.equal(result.terminal, true);
});

test('stepResult 携带 digest 时写入步骤（无 digest 不加键）', () => {
  const message = baseMessage({
    steps: [{ tool: 'query_activities', label: '活动查询', status: 'running' }],
  });

  const result = reduceStreamEvent(message, {
    type: 'stepResult',
    tool: 'query_activities',
    ok: true,
    hits: 0,
    references: [],
    digest: 'Top应用: Xcode(120分)',
  });

  const step = messageSteps(result.message)[0];
  assert.ok(step);
  assert.equal(step.digest, 'Top应用: Xcode(120分)');
  assert.equal(result.terminal, false);
});

test('confirmRequest 把最近 running 步骤标记为待确认', () => {
  const message = baseMessage({
    steps: [{ tool: 'create_todo', label: '新建待办', status: 'running' }],
  });

  const result = reduceStreamEvent(message, {
    type: 'confirmRequest',
    confirmId: 'c-1',
    tool: 'create_todo',
    label: '新建待办',
    summary: '新建待办：整理周报',
  });

  const step = messageSteps(result.message)[0];
  assert.ok(step);
  assert.equal(step.confirmId, 'c-1');
  assert.equal(step.confirmStatus, 'pending');
  assert.equal(step.summary, '新建待办：整理周报');
  assert.equal(step.status, 'running');
  assert.equal(result.terminal, false);
});

test('用户停止时 done 不应覆盖已流式出的内容', () => {
  const message = baseMessage({ content: '已经写出来的部分回答' });

  const result = reduceStreamEvent(message, {
    type: 'done',
    answer: '已按你的要求停止。',
    references: [],
    toolLabels: [],
  });

  assert.equal(result.message.content, '已经写出来的部分回答');
  assert.equal(result.message.stopped, true);
  assert.equal(result.terminal, true);
});

test('done 的畸形字段不应污染已有消息', () => {
  const references = [{ sourceId: 'old', timestamp: 1, title: '已有引用' }];
  const message = baseMessage({
    content: '已有回答',
    references,
    toolLabels: ['已有工具'],
  });

  const result = reduceStreamEvent(message, {
    type: 'done',
    answer: 42,
    references: 'invalid',
    toolLabels: 'invalid',
  });

  assert.equal(result.message.content, '已有回答');
  assert.strictEqual(result.message.references, references);
  assert.strictEqual(result.message.toolLabels, message.toolLabels);
  assert.equal(result.message.streaming, false);
  assert.equal(result.terminal, true);
});

test('error 的非字符串错误应回退到安全文案', () => {
  const result = reduceStreamEvent(
    baseMessage(),
    { type: 'error', error: { message: 'invalid' } },
    '请求失败',
  );

  assert.equal(result.message.content, '请求失败');
  assert.equal(result.message.failed, true);
  assert.equal(result.terminal, true);
});

test('stepResult 应忽略 references 中的非对象元素', () => {
  const validReference = { sourceId: 'new', timestamp: 2, title: '有效引用' };
  const message = baseMessage({
    steps: [{ tool: 'search_memory', status: 'running' }],
  });

  const result = reduceStreamEvent(message, {
    type: 'stepResult',
    tool: 'search_memory',
    ok: true,
    hits: 1,
    references: [null, 'invalid', [], validReference],
  });

  const step = messageSteps(result.message)[0];
  assert.ok(step);
  assert.deepEqual(step.references, [validReference]);
  assert.deepEqual(result.message.references, [validReference]);
  assert.equal(result.terminal, false);
});
