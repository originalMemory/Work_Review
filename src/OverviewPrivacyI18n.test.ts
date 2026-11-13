import test from 'node:test';
import assert from 'node:assert/strict';
import zhCN from './lib/i18n/locales/zh-CN.ts';
import zhTW from './lib/i18n/locales/zh-TW.ts';
import en from './lib/i18n/locales/en.ts';
import ar from './lib/i18n/locales/ar.ts';

const locales = { zhCN, zhTW, en, ar };

function assertNonEmptyKey(messages: unknown, path: string, localeName: string): void {
  const value = path.split('.').reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, messages);
  assert.equal(typeof value, 'string', `${localeName} 缺少 ${path}`);
  assert.ok(typeof value === 'string');
  assert.ok(value.trim().length > 0, `${localeName} 的 ${path} 不能为空`);
}

test('隐私设置四语言应提供本地存储边界和内容过滤数量摘要', () => {
  for (const [localeName, messages] of Object.entries(locales)) {
    assertNonEmptyKey(messages, 'settingsPrivacy.storageAndTransferDescription', localeName);
    assertNonEmptyKey(messages, 'settingsPrivacy.contentFilterSummary', localeName);
    assert.match(
      messages.settingsPrivacy.contentFilterSummary,
      /\{keywordCount\}[\s\S]*\{domainCount\}/,
      `${localeName} 的内容过滤摘要必须保留两个数量占位符`,
    );
  }
});

const overviewKeys = [
  'compositionFilter',
  'compositionDuration',
  'compositionShare',
  'compositionActiveRange',
  'compositionPrimaryApps',
  'compositionNoActiveRange',
  'domainSourcesUnknown',
  'domainListTitle',
  'domainDetailTitle',
  'domainLoadFailed',
];

test('概览四语言应提供分类构成和域名详情文案', () => {
  for (const [localeName, messages] of Object.entries(locales)) {
    for (const key of overviewKeys) {
      assertNonEmptyKey(messages, `overview.${key}`, localeName);
    }
  }
});
