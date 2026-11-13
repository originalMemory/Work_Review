import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as navigation from './reportDateNavigation.ts';

const reportUrl = new URL('./Report.svelte', import.meta.url);

test('日期偏移工具应按本地日历跨月回退', () => {
  assert.equal(typeof navigation.shiftIsoDate, 'function');
  assert.equal(navigation.shiftIsoDate('2026-08-01', -1), '2026-07-31');
});

test('日期偏移工具应按本地日历跨年回退', () => {
  assert.equal(typeof navigation.shiftIsoDate, 'function');
  assert.equal(navigation.shiftIsoDate('2026-01-01', -1), '2025-12-31');
});

test('日期偏移工具应正确处理闰年', () => {
  assert.equal(typeof navigation.shiftIsoDate, 'function');
  assert.equal(navigation.shiftIsoDate('2024-03-01', -1), '2024-02-29');
  assert.equal(navigation.shiftIsoDate('2025-03-01', -1), '2025-02-28');
});

test('日期偏移工具应支持零偏移和向后续日期移动', () => {
  assert.equal(navigation.shiftIsoDate('2026-08-09', 0), '2026-08-09');
  assert.equal(navigation.shiftIsoDate('2026-08-31', 1), '2026-09-01');
});

test('日报请求快照应冻结日期、语言和缓存键', () => {
  assert.equal(typeof navigation.createReportRequestSnapshot, 'function');
  assert.deepEqual(
    navigation.createReportRequestSnapshot(7, '2026-08-04', 'zh-CN'),
    {
      requestId: 7,
      targetDate: '2026-08-04',
      targetLocale: 'zh-CN',
      targetCacheKey: '2026-08-04:zh-CN:all',
      targetDeviceId: null,
    },
  );
});

test('日报生成所有者不得抢占已存在的生成状态', () => {
  assert.equal(typeof navigation.createReportGenerationOwnership, 'function');
  const ownership = navigation.createReportGenerationOwnership();

  assert.equal(ownership.claim(7, true), false);
  assert.equal(ownership.release(7), false);
});

test('新日期请求不得取消仍在执行的自动生成所有者', () => {
  assert.equal(typeof navigation.createReportGenerationOwnership, 'function');
  const ownership = navigation.createReportGenerationOwnership();

  assert.equal(ownership.claim(7, false), true);
  assert.equal('cancel' in ownership, false);
  assert.equal(ownership.claim(8, false), false);
  assert.equal(ownership.release(7), true);
  assert.equal(ownership.claim(8, false), true);
});

test('只有当前日报生成所有者可以释放生成状态', () => {
  assert.equal(typeof navigation.createReportGenerationOwnership, 'function');
  const ownership = navigation.createReportGenerationOwnership();

  assert.equal(ownership.claim(7, false), true);
  assert.equal(ownership.release(8), false);
  assert.equal(ownership.release(7), true);
});

test('日报生成所有者不应被同一请求重复领取或释放', () => {
  const ownership = navigation.createReportGenerationOwnership();

  assert.equal(ownership.claim(7, false), true);
  assert.equal(ownership.claim(7, false), false);
  assert.equal(ownership.release(7), true);
  assert.equal(ownership.release(7), false);
});

test('日报日期组最左侧应提供本地化的上一天按钮', async () => {
  const source = await readFile(reportUrl, 'utf8');
  const toolbarStart = source.indexOf('<div class="page-toolbar-end">');
  const previousDayIndex = source.indexOf("t('report.previousDay')", toolbarStart);
  const todayIndex = source.indexOf("t('report.today')", toolbarStart);
  const yesterdayIndex = source.indexOf("t('report.yesterday')", toolbarStart);
  const datePickerIndex = source.indexOf('<LocalizedDatePicker', toolbarStart);

  assert.notEqual(toolbarStart, -1);
  assert.notEqual(previousDayIndex, -1, '缺少上一天按钮');
  assert.ok(
    toolbarStart < previousDayIndex
      && previousDayIndex < todayIndex
      && todayIndex < yesterdayIndex
      && yesterdayIndex < datePickerIndex,
    '日期组顺序应为上一天、今天、昨天、日期选择器',
  );
  assert.match(source.slice(toolbarStart, todayIndex), /type="button"/);
  assert.match(source.slice(toolbarStart, todayIndex), /on:click=\{selectPreviousDay\}/);
});

test('上一天按钮文案应覆盖四种语言', async () => {
  const localeFiles = [
    ['zh-CN.ts', '上一天'],
    ['zh-TW.ts', '前一天'],
    ['en.ts', 'Previous day'],
    ['ar.ts', 'اليوم السابق'],
  ];

  for (const [fileName, label] of localeFiles) {
    const source = await readFile(new URL(`../../lib/i18n/locales/${fileName}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`previousDay:\\s*['\"]${label}['\"]`), `${fileName} 缺少 report.previousDay`);
  }
});

test('日报加载应在入口创建请求快照并只使用快照目标', async () => {
  const source = await readFile(reportUrl, 'utf8');
  const loadReportStart = source.indexOf('async function loadReport');
  const loadReportEnd = source.indexOf('\n  function selectDate', loadReportStart);
  const loadReportSource = source.slice(loadReportStart, loadReportEnd);

  assert.match(source, /import\s*\{\s*createReportGenerationOwnership,\s*createReportRequestSnapshot,\s*shiftIsoDate\s*\}\s*from\s*['"]\.\/reportDateNavigation\.ts['"]/);
  assert.match(
    loadReportSource,
    /createReportRequestSnapshot\(\s*\+\+reportRequestId,\s*selectedDate,\s*currentLocale,\s*\$selectedDeviceId,?\s*\)/,
  );
  assert.match(loadReportSource, /const\s*\{\s*requestId,\s*targetDate,\s*targetLocale,\s*targetCacheKey,\s*targetDeviceId\s*\}/);
  assert.match(loadReportSource, /get_daily_stats',\s*\{\s*date:\s*targetDate,\s*deviceId:\s*targetDeviceId\s*\}/);
  assert.match(loadReportSource, /get_saved_report',\s*\{\s*date:\s*targetDate,\s*locale:\s*targetLocale,\s*deviceId:\s*targetDeviceId\s*\}/);
  assert.match(loadReportSource, /cache\.setReport\(targetCacheKey,/);
  assert.doesNotMatch(loadReportSource, /date:\s*selectedDate/);
  assert.doesNotMatch(loadReportSource, /locale:\s*currentLocale/);
  assert.doesNotMatch(loadReportSource, /cache\.setReport\(currentReportCacheKey,/);
});

test('日报加载的异步结果和 finally 应仅由最新请求提交', async () => {
  const source = await readFile(reportUrl, 'utf8');
  const loadReportStart = source.indexOf('async function loadReport');
  const loadReportEnd = source.indexOf('\n  function selectDate', loadReportStart);
  const loadReportSource = source.slice(loadReportStart, loadReportEnd);

  const awaitCount = (loadReportSource.match(/await invoke(?:<[^>]+>)?\(/g) || []).length;
  const guardCount = (loadReportSource.match(/if \(requestId !== reportRequestId\) return;/g) || []).length;

  assert.equal(awaitCount, 5, 'loadReport 当前应包含五次受保护的 invoke await');
  assert.equal(guardCount, awaitCount, '每次 invoke await 后都必须校验请求编号');
  assert.match(
    loadReportSource,
    /finally\s*\{\s*if \(requestId === reportRequestId\)\s*\{[\s\S]*loading = false;[\s\S]*\}\s*\}/,
  );
});

test('手动生成日报应冻结目标并只允许当前请求提交界面状态', async () => {
  const source = await readFile(reportUrl, 'utf8');
  const generateStart = source.indexOf('async function generateReport');
  const generateEnd = source.indexOf('\n  async function persistReportPrompt', generateStart);
  const generateSource = source.slice(generateStart, generateEnd);

  assert.match(
    generateSource,
    /createReportRequestSnapshot\(\s*\+\+reportRequestId,\s*selectedDate,\s*currentLocale,\s*\$selectedDeviceId,?\s*\)/,
  );
  assert.match(
    generateSource,
    /const\s*\{\s*requestId,\s*targetDate,\s*targetLocale,\s*targetCacheKey,\s*targetDeviceId\s*\}/,
  );
  assert.match(
    generateSource,
    /if \(!reportGenerationOwnership\.claim\(requestId,\s*cacheData\?\.reportGenerating \?\? false\)\) return;/,
  );
  assert.match(
    generateSource,
    /await persistReportPrompt\(\);\s*if \(requestId !== reportRequestId\) return;/,
  );
  assert.match(
    generateSource,
    /await invoke\('generate_report', \{ date: targetDate, force, locale: targetLocale, deviceId: targetDeviceId \}\);\s*if \(requestId !== reportRequestId\) return;/,
  );
  assert.match(
    generateSource,
    /await invoke(?:<[^>]+>)?\('get_saved_report', \{ date: targetDate, locale: targetLocale, deviceId: targetDeviceId \}\);\s*if \(requestId !== reportRequestId\) return;/,
  );
  assert.match(generateSource, /cache\.setReport\(targetCacheKey, report\)/);
  assert.match(
    generateSource,
    /catch \(e\) \{\s*if \(requestId === reportRequestId\) \{\s*error = formatUserError/,
  );
  assert.match(
    generateSource,
    /finally \{\s*if \(reportGenerationOwnership\.release\(requestId\)\) \{\s*cache\.setReportGenerating\(false\);\s*\}\s*\}/,
  );
  assert.doesNotMatch(generateSource, /date:\s*selectedDate/);
  assert.doesNotMatch(generateSource, /locale:\s*currentLocale/);
  assert.doesNotMatch(generateSource, /cache\.setReport\(currentReportCacheKey,/);
});

test('日报自动补生成应复用生成所有者且不得清理手动生成', async () => {
  const source = await readFile(reportUrl, 'utf8');
  const loadReportStart = source.indexOf('async function loadReport');
  const loadReportEnd = source.indexOf('\n  function selectPreviousDay', loadReportStart);
  const loadReportSource = source.slice(loadReportStart, loadReportEnd);

  assert.match(source, /createReportGenerationOwnership/);
  assert.doesNotMatch(loadReportSource, /reportGenerationOwnership\.cancel/);
  assert.match(
    loadReportSource,
    /reportGenerationOwnership\.claim\(requestId,\s*cacheData\?\.reportGenerating \?\? false\)/,
  );
  assert.match(
    loadReportSource,
    /if \(reportGenerationOwnership\.release\(requestId\)\)\s*\{\s*cache\.setReportGenerating\(false\);\s*\}/,
  );
  assert.doesNotMatch(
    loadReportSource,
    /if \(requestId === reportRequestId\)\s*\{\s*cache\.setReportGenerating\(false\);/,
  );
});


test('日报请求快照应按设备隔离缓存并冻结设备选择', () => {
  const a = navigation.createReportRequestSnapshot(1, '2026-11-13', 'zh-CN', 'device-a');
  const b = navigation.createReportRequestSnapshot(2, '2026-11-13', 'zh-CN', 'device-b');
  assert.equal(a.targetDeviceId, 'device-a');
  assert.equal(b.targetDeviceId, 'device-b');
  assert.notEqual(a.targetCacheKey, b.targetCacheKey);
  assert.notEqual(a.targetCacheKey, navigation.createReportRequestSnapshot(3, '2026-11-13', 'zh-CN').targetCacheKey);
});
