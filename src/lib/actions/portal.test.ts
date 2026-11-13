import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

test('固定定位浮层应通过 portalToBody 移挂 body，规避 backdrop-filter 包含块劫持', async () => {
  const overlayHosts = [
    { file: 'routes/timeline/Timeline.svelte', min: 3 },
    { file: 'routes/Overview.svelte', min: 1 },
    { file: 'routes/timeline/HourlySummaryDrawer.svelte', min: 1 },
    { file: 'routes/report/Report.svelte', min: 3 },
  ];

  for (const { file, min } of overlayHosts) {
    const source = await readFile(`${srcRoot}${file}`, 'utf8');
    const count = (source.match(/use:portalToBody/g) ?? []).length;
    assert.ok(
      count >= min,
      `${file} 应有至少 ${min} 处 use:portalToBody（实际 ${count}）`,
    );
  }
});

test('portalToBody 应把节点挂到 document.body 并在销毁时摘除', async () => {
  const source = await readFile(`${srcRoot}lib/actions/portal.ts`, 'utf8');
  assert.match(source, /document\.body\.appendChild\(node\)/);
  assert.match(source, /removeChild\(node\)/);
});
