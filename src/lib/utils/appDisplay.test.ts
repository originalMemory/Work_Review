import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getPreferredTimelineAppName,
  shouldPreferTimelineFallbackIcon,
} from './appDisplay.ts';

test('时间线应优先显示更友好的窗口标题作为应用名', () => {
  assert.equal(
    getPreferredTimelineAppName({
      appName: 'uninstall',
      windowTitle: 'Work Review Uninstall',
    }),
    'Work Review Uninstall'
  );

  assert.equal(
    getPreferredTimelineAppName({
      appName: 'xfltd',
      windowTitle: 'XFLTD',
    }),
    'XFLTD'
  );

  assert.equal(
    getPreferredTimelineAppName({
      appName: 'Work_Review.v1.0.35_x64-setup',
      windowTitle: 'Work Review Setup',
    }),
    'Work Review Setup'
  );
});

test('时间线只应对明确安装器优先使用 fallback icon', () => {
  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'uninstall',
      windowTitle: 'Work Review Uninstall',
    }),
    true
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'Work_Review.v1.0.35_x64-setup',
      windowTitle: 'Work Review Setup',
    }),
    true
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'Acme-setup.exe',
      windowTitle: '',
    }),
    true
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'xfltd',
      windowTitle: 'XFLTD',
    }),
    false
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'Microsoft Edge',
      windowTitle: 'downloads-hub',
    }),
    false
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'Installment Calculator',
      windowTitle: 'Loan schedule',
    }),
    false
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      appName: 'installation-notes',
      windowTitle: 'README',
    }),
    false
  );
});

test('时间线不应因小写浏览器进程名与页面标题不同而丢弃原生图标', () => {
  assert.equal(
    shouldPreferTimelineFallbackIcon({
      app_name: 'centbrowser',
      window_title: 'mikumiku',
    }),
    false
  );

  assert.equal(
    shouldPreferTimelineFallbackIcon({
      app_name: 'centbrowser',
      window_title: '新标签页',
    }),
    false
  );
});

test('时间线展示工具应兼容后端活动记录的 snake_case 字段', () => {
  assert.equal(
    getPreferredTimelineAppName({
      app_name: 'Visual Studio Code',
      window_title: '优化时间线交互与分类弹层',
    }),
    'Visual Studio Code'
  );
});

test('时间线非安装器的 snake_case 活动记录不应强制使用 fallback icon', () => {
  assert.equal(
    shouldPreferTimelineFallbackIcon({
      app_name: 'xfltd',
      window_title: 'XFLTD',
    }),
    false
  );
});

test('应升级前端图标缓存版本以失效低分辨率旧图标', async () => {
  const source = await readFile(new URL('../stores/iconCache.ts', import.meta.url), 'utf8');

  assert.match(source, /work-review-app-icon-cache-v4/);
  assert.doesNotMatch(source, /work-review-app-icon-cache-v3/);
});

test('应用图标应使用浏览器默认高质量插值', async () => {
  const source = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  const rule = source.match(/\.app-icon\s*\{[^}]*\}/)?.[0] || '';

  assert.match(rule, /image-rendering:\s*auto/);
  assert.doesNotMatch(rule, /-webkit-optimize-contrast/);
});

test('展示层应剥离 Windows 挂起窗口的未响应后缀', async () => {
  const { stripNotRespondingSuffix, getPreferredTimelineAppName } = await import('./appDisplay.ts');

  assert.equal(stripNotRespondingSuffix('ChatGPT（未响应）'), 'ChatGPT');
  assert.equal(stripNotRespondingSuffix('任务管理器 (未响应)'), '任务管理器');
  assert.equal(stripNotRespondingSuffix('Notepad (Not Responding)'), 'Notepad');
  assert.equal(stripNotRespondingSuffix('正常标题'), '正常标题');
  assert.equal(
    stripNotRespondingSuffix('（未响应）的历史记录'),
    '（未响应）的历史记录',
  );

  // 旧版本已把后缀存入 app_name 的记录，展示时也应清洗
  assert.equal(
    getPreferredTimelineAppName({ app_name: 'ChatGPT（未响应）', window_title: '' }),
    'ChatGPT',
  );
});
