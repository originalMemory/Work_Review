import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('时间线导出应只选择保存路径并导出活动元数据', async () => {
  const source = await readFile(new URL('./Timeline.svelte', import.meta.url), 'utf8');
  assert.match(source, /saveDialog\(/);
  assert.match(source, /invoke\('export_timeline_json'/);
  assert.doesNotMatch(source, /includeOcr|exportIncludeOcr/);
});
