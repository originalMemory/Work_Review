import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('前端应向日报生成与工作助手透传当前 locale，并让日期输入跟随语言切换', async () => {
  const [appSource, reportSource, askSource, timelineSource, summarySource] = await Promise.all([
    readFile(new URL('./App.svelte', import.meta.url), 'utf8'),
    readFile(new URL('./routes/report/Report.svelte', import.meta.url), 'utf8'),
    readFile(new URL('./routes/ask/Ask.svelte', import.meta.url), 'utf8'),
    readFile(new URL('./routes/timeline/Timeline.svelte', import.meta.url), 'utf8'),
    readFile(new URL('./routes/timeline/Summary.svelte', import.meta.url), 'utf8'),
  ]);

  assert.match(appSource, /invoke\('generate_report', \{ date: today, force: false, locale: currentLocale \}\)/);
  assert.match(reportSource, /invoke\('generate_report', \{[\s\S]*date: selectedDate,[\s\S]*force,[\s\S]*locale: currentLocale,[\s\S]*deviceId: \$selectedDeviceId \?\? null,[\s\S]*\}\)/);
  assert.match(reportSource, /invoke\('get_saved_report', \{[\s\S]*date: selectedDate,[\s\S]*locale: currentLocale,[\s\S]*deviceId: \$selectedDeviceId \?\? null,[\s\S]*\}\)/);
  assert.match(
    reportSource,
    /if \(!savedReport && previousReport\?\.date === selectedDate && previousReport\?\.content\)[\s\S]*invoke\('generate_report', \{[\s\S]*date: selectedDate,[\s\S]*force: false,[\s\S]*locale: currentLocale,[\s\S]*deviceId: \$selectedDeviceId \?\? null,[\s\S]*\}\)/,
  );
  assert.match(askSource, /invoke\('chat_work_assistant', \{[\s\S]*locale: currentLocale,[\s\S]*\}\)/);

  assert.match(reportSource, /LocalizedDatePicker/);
  assert.match(timelineSource, /LocalizedDatePicker/);
  assert.match(summarySource, /LocalizedDatePicker/);
  assert.match(reportSource, /localeCode=\{currentLocale\}/);
  assert.match(timelineSource, /localeCode=\{currentLocale\}/);
  assert.match(summarySource, /localeCode=\{currentLocale\}/);
});

test('助手页展示层不应继续依赖写死中文的工作智能工具函数', async () => {
  const [askSource, i18nSource] = await Promise.all([
    readFile(new URL('./routes/ask/Ask.svelte', import.meta.url), 'utf8'),
    readFile(new URL('./lib/i18n/index.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(askSource, /from '\.\.\/\.\.\/lib\/utils\/workIntelligence\.js'/);
  assert.match(askSource, /formatDurationLocalized/);
  assert.match(i18nSource, /export function formatDurationLocalized/);
  assert.doesNotMatch(askSource, /toLocaleString\('zh-CN'/);
});

test('后端日报模板与助手提示词应支持按 locale 输出', async () => {
  const [commandsSource, summarySource, localSource] = await Promise.all([
    readFile(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8'),
    readFile(new URL('../crates/core/src/analysis/summary.rs', import.meta.url), 'utf8'),
    readFile(new URL('../crates/core/src/analysis/local.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(commandsSource, /pub async fn chat_work_assistant\([\s\S]*locale: Option<String>/);
  assert.match(commandsSource, /pub async fn generate_report\([\s\S]*locale: Option<String>/);
  assert.match(commandsSource, /build_assistant_system_prompt/);
  assert.match(summarySource, /locale:/);
  assert.match(summarySource, /AppLocale|ReportLocale|report_locale/);
  assert.match(localSource, /locale:/);
});
