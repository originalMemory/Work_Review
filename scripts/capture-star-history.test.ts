import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDailySeries, fmtNumber, niceTicks, renderSvg } from './capture-star-history.ts';

const STAR_DATES = [
  '2026-03-10T15:28:53Z',
  '2026-03-10T20:11:09Z', // 同日第二颗
  '2026-04-01T03:42:00Z',
  '2026-05-15T12:00:00Z',
  '2026-05-15T18:30:00Z', // 同日第二颗
  '2026-08-04T08:57:54Z',
];

test('buildDailySeries 应把同日多星聚合成单点累计值', () => {
  const series = buildDailySeries(STAR_DATES);
  assert.equal(series.length, 4);
  assert.deepEqual(
    series.map((p) => ({ date: p.date, total: p.total })),
    [
      { date: '2026-03-10', total: 2 },
      { date: '2026-04-01', total: 3 },
      { date: '2026-05-15', total: 5 },
      { date: '2026-08-04', total: 6 },
    ],
  );
});

test('niceTicks 应产出 1/2/5 量级刻度且顶部高于最大值', () => {
  assert.deepEqual(niceTicks(1686, 5), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(niceTicks(6, 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(100, 5), [0, 20, 40, 60, 80, 100, 120]);
  assert.deepEqual(niceTicks(0), [0]);
  // 顶部刻度必须严格高于最大值,避免曲线最高点贴边。
  for (const max of [1, 5, 99, 1686, 9999]) {
    const ticks = niceTicks(max, 5);
    assert.ok(ticks[ticks.length - 1] > max, `max=${max} 顶部刻度应高于最大值`);
  }
});

test('fmtNumber 应在整千时省略小数', () => {
  assert.equal(fmtNumber(0), '0');
  assert.equal(fmtNumber(500), '500');
  assert.equal(fmtNumber(999), '999');
  assert.equal(fmtNumber(1000), '1k');
  assert.equal(fmtNumber(1500), '1.5k');
  assert.equal(fmtNumber(1686), '1.7k');
  assert.equal(fmtNumber(2000), '2k');
});

test('renderSvg 在单颗星场景不产生 NaN 且输出合法 SVG', () => {
  const single = [{ date: '2026-03-10', total: 1 }];
  const svg = renderSvg(single, 'light');
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.ok(!svg.includes('NaN'), 'SVG 中不应出现 NaN');
  assert.ok(!svg.includes('Infinity'), 'SVG 中不应出现 Infinity');
  assert.ok(!svg.includes('d=""'), '不应出现空 path');
});

test('renderSvg 应同时支持 light 与 dark 主题且包含关键元素', () => {
  const series = buildDailySeries(STAR_DATES);
  for (const theme of ['light', 'dark'] as const) {
    const svg = renderSvg(series, theme);
    assert.match(svg, /^<svg/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.ok(svg.includes('<title>Star History</title>'), `${theme} 缺少无障碍标题`);
    assert.ok(svg.includes('star-line-'), `${theme} 缺少渐变线条定义`);
    assert.ok(svg.includes('star-area-'), `${theme} 缺少渐变填充定义`);
    assert.ok(svg.includes('Mar 10'), `${theme} 缺少首日 X 轴刻度`);
    assert.ok(svg.includes('<path'), `${theme} 缺少曲线 path`);
    assert.ok(!svg.includes('NaN'), `${theme} 出现 NaN`);
  }
});
