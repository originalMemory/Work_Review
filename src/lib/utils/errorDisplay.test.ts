import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatUserError } from './errorDisplay.ts';

test('后端友好错误应原样展示', () => {
  assert.equal(formatUserError('配置缺少 API Key', '请求失败'), '配置缺少 API Key');
});

test('空错误应使用已本地化的兜底文案', () => {
  assert.equal(formatUserError(null, '请求失败'), '请求失败');
});

test('技术异常应隐藏实现细节并使用兜底文案', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      formatUserError(new TypeError('Cannot read properties of undefined'), '请求失败'),
      '请求失败',
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('仅异常类型具有技术含义时也应隐藏错误详情', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(formatUserError(new TypeError('boom'), '请求失败'), '请求失败');
    assert.equal(formatUserError(new ReferenceError('secret'), '请求失败'), '请求失败');
  } finally {
    console.error = originalConsoleError;
  }
});

test('URI、聚合与 SQLite 技术错误应使用兜底文案', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(formatUserError(new URIError('URI malformed'), '请求失败'), '请求失败');
    assert.equal(
      formatUserError(new AggregateError([], '内部并发失败'), '请求失败'),
      '请求失败',
    );
    assert.equal(
      formatUserError(new Error('SQLITE_ERROR: no such table activity'), '请求失败'),
      '请求失败',
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('实际 rusqlite 错误链应隐藏数据库实现细节', () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      formatUserError(
        new Error('AI分析错误: 查询失败: 数据库错误: no such table: activities'),
        '请求失败',
      ),
      '请求失败',
    );
    assert.equal(
      formatUserError(new Error('数据库错误: database is locked'), '请求失败'),
      '请求失败',
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('主动抛出的本地化普通错误应保留友好消息', () => {
  assert.equal(
    formatUserError(new Error('请求超时，请稍后重试'), '请求失败'),
    '请求超时，请稍后重试',
  );
});

test('Overview 的域名详情错误应提供本地化兜底文案', async () => {
  const source = await readFile(new URL('../../routes/Overview.svelte', import.meta.url), 'utf8');

  assert.match(
    source,
    /domainOverlayError\s*=\s*formatUserError\(e,\s*t\('common\.loadFailedRetry'\)\)/,
  );
});

test('Ask 的失败消息不应再次拼接原始技术异常', async () => {
  const source = await readFile(new URL('../../routes/ask/Ask.svelte', import.meta.url), 'utf8');

  assert.doesNotMatch(
    source,
    /content:\s*m\.content\s*\|\|\s*`\$\{t\('ask\.requestFailed'\)\}:\s*\$\{e\}`/,
  );
  assert.match(source, /const\s+displayError\s*=\s*formatUserError\(e,/);
  assert.match(
    source,
    /content:\s*m\.content\s*\|\|\s*`\$\{t\('ask\.requestFailed'\)\}:\s*\$\{displayError\}`/,
  );
});
