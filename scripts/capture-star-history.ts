// 生成本仓库的 Star History 静态 SVG(light/dark 双主题)。
//
// 用法:  node --import tsx scripts/capture-star-history.ts
//        或:  npm run star-history
// 可选:  STAR_HISTORY_REPO=owner/name node --import tsx scripts/capture-star-history.ts
//
// 背景:GitHub 限制了第三方对 star 数据的访问,star-history.com 的动态 SVG
// 接口与网页对公开仓库已失效(返回 timeout,网页弹"Add GitHub Access Token")。
// 本脚本改用仓库所有者本地 `gh` 凭证拉取 stargazers 时间戳,在本地渲染 SVG,
// token 不离开本机(符合项目 G5/G7 安全与合规要求)。
//
// 产出:
//   docs/star-history.svg       (light)
//   docs/star-history-dark.svg  (dark)
// 三个 README 用 <picture> + prefers-color-scheme 引用,保留可点击跳转外链。

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
const DEFAULT_REPO = 'wm94i/Work-Review';
const REPO = process.env.STAR_HISTORY_REPO || DEFAULT_REPO;

const WIDTH = 920;
const HEIGHT = 420;
const PADDING = { top: 24, right: 28, bottom: 48, left: 56 };

const THEMES = {
  light: {
    background: '#ffffff',
    text: '#1f2328',
    mutedText: '#94a3b8',
    grid: '#f1f5f9',
    axis: '#e2e8f0',
    lineFrom: '#06b6d4',
    lineTo: '#8b5cf6',
    areaFrom: 'rgba(139, 92, 246, 0.18)',
    areaTo: 'rgba(6, 182, 212, 0.02)',
    dot: '#8b5cf6',
  },
  dark: {
    background: '#0d1117',
    text: '#e6edf3',
    mutedText: '#64748b',
    grid: '#1e293b',
    axis: '#334155',
    lineFrom: '#22d3ee',
    lineTo: '#a78bfa',
    areaFrom: 'rgba(167, 139, 250, 0.20)',
    areaTo: 'rgba(34, 211, 238, 0.02)',
    dot: '#a78bfa',
  },
};

type ThemeName = keyof typeof THEMES;

export type StarHistoryPoint = {
  date: string;
  total: number;
};

type PlotPoint = StarHistoryPoint & {
  x: number;
  y: number;
};

function getErrorCode(error: Error): string | undefined {
  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** 调用 `gh api` 分页拉取所有 stargazer 的 starred_at 时间戳。 */
function fetchStarDates(repo: string): string[] {
  const result = spawnSync(
    'gh',
    ['api', `repos/${repo}/stargazers`, '--paginate', '-H', 'Accept: application/vnd.github.star+json', '--jq', '.[].starred_at'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) {
    if (getErrorCode(result.error) === 'ENOENT') {
      throw new Error('未找到 gh CLI。请先安装并 `gh auth login`,或设置 STAR_HISTORY_REPO。');
    }
    if (getErrorCode(result.error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(`${repo} 的 stargazer 数据量超出缓冲区上限。请增大脚本 maxBuffer 或改用流式拉取。`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`gh api 拉取 stargazers 失败 (exit ${result.status}): ${stderr}`);
  }
  const dates = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  if (dates.length === 0) {
    throw new Error(`未获取到 ${repo} 的 stargazer 数据。请确认已通过 \`gh auth login\` 登录且对该仓库可读。`);
  }
  return dates;
}

/** 把 starred_at 序列聚合成 [{date, total}] 日级累计曲线。 */
export function buildDailySeries(starDates: readonly string[]): StarHistoryPoint[] {
  const counts = new Map<string, number>();
  for (const iso of starDates) {
    const day = iso.slice(0, 10);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  const days = [...counts.keys()].sort();
  const series: StarHistoryPoint[] = [];
  let total = 0;
  for (const day of days) {
    total += counts.get(day) ?? 0;
    series.push({ date: day, total });
  }
  return series;
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function fmtNumber(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

/** 生成 "nice" 的 Y 轴刻度(1/2/5 量级,顶部略高于最大值,刻度可读)。 */
export function niceTicks(maxValue: number, count = 5): number[] {
  if (maxValue <= 0) return [0];
  const raw = maxValue / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((multiplier) => multiplier * magnitude).find((value) => value >= raw)
      ?? raw
  );
  const ticks: number[] = [];
  for (let v = 0; v <= maxValue; v += step) {
    ticks.push(v);
  }
  // 顶部刻度应略高于最大值,避免曲线顶点贴边或溢出。
  const topTick = ticks.at(-1) ?? 0;
  if (topTick < maxValue + step * 0.001) {
    ticks.push(topTick + step);
  }
  return ticks;
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  };
  return value.replace(/[<>&"']/g, (character) => entities[character] ?? character);
}

/** 生成 Catmull-Rom 转 Bezier 的平滑路径(开曲线,端点不外推)。 */
function smoothPath(points: readonly PlotPoint[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  const tension = 0.18;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export function renderSvg(series: readonly StarHistoryPoint[], themeName: ThemeName): string {
  const t = THEMES[themeName];
  const plotW = WIDTH - PADDING.left - PADDING.right;
  const plotH = HEIGHT - PADDING.top - PADDING.bottom;

  const firstSeriesPoint = series[0];
  const lastSeriesPoint = series.at(-1);
  if (!firstSeriesPoint || !lastSeriesPoint) {
    throw new Error('Star History 至少需要一个数据点');
  }

  const firstDay = Date.parse(`${firstSeriesPoint.date}T00:00:00Z`);
  const lastDay = Date.parse(`${lastSeriesPoint.date}T00:00:00Z`);
  const spanDays = Math.max(1, Math.round((lastDay - firstDay) / 86_400_000));
  const maxTotal = lastSeriesPoint.total;

  const xScale = (dayMs: number) => PADDING.left + ((dayMs - firstDay) / 86_400_000 / spanDays) * plotW;
  const yTicks = niceTicks(maxTotal, 5);
  // Y 轴上界取顶部刻度而非原始最大值:曲线最高点不贴顶,所有刻度都落在图内。
  const yMax = Math.max(1, yTicks.at(-1) ?? 1);
  const yScale = (total: number) => PADDING.top + plotH - (total / yMax) * plotH;

  const points: PlotPoint[] = series.map((point) => ({
    x: xScale(Date.parse(`${point.date}T00:00:00Z`)),
    y: yScale(point.total),
    total: point.total,
    date: point.date,
  }));

  const linePath = smoothPath(points);
  const baseline = (PADDING.top + plotH).toFixed(2);
  // 单点场景无法构成面积,跳过 area 填充,仅靠 endpoint 圆点表达。
  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  if (!firstPoint || !lastPoint) {
    throw new Error('Star History 至少需要一个绘图点');
  }
  const areaPath = points.length < 2
    ? ''
    : `${linePath} L ${lastPoint.x.toFixed(2)} ${baseline} L ${firstPoint.x.toFixed(2)} ${baseline} Z`;

  const xTickCount = Math.max(2, Math.min(6, series.length));
  const xTickIndices = Array.from({ length: xTickCount }, (_, i) =>
    Math.round((i / (xTickCount - 1)) * (series.length - 1)));

  const yTickLines = yTicks.map((value) => {
    const y = yScale(value);
    return `<line x1="${PADDING.left}" y1="${y.toFixed(2)}" x2="${(WIDTH - PADDING.right).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${t.grid}" stroke-width="1" stroke-dasharray="2 4"/>`
      + `<text x="${PADDING.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="${t.mutedText}" font-size="11">${fmtNumber(value)}</text>`;
  }).join('\n    ');

  const xTickLabels = xTickIndices.map((idx) => {
    const p = points[idx];
    return `<text x="${p.x.toFixed(2)}" y="${(HEIGHT - PADDING.bottom + 22).toFixed(2)}" text-anchor="middle" fill="${t.mutedText}" font-size="12">${fmtDate(p.date)}</text>`;
  }).join('\n    ');

  const endpoint = `
    <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="4" fill="${t.dot}"/>
    <circle cx="${lastPoint.x.toFixed(2)}" cy="${lastPoint.y.toFixed(2)}" r="8" fill="${t.dot}" opacity="0.15"/>`;

  const plotBottom = (PADDING.top + plotH).toFixed(2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif" role="img" aria-label="Star History for ${escapeXml(REPO)}">
  <title>Star History</title>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${t.background}"/>
  <defs>
    <linearGradient id="star-line-${themeName}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${t.lineFrom}"/>
      <stop offset="100%" stop-color="${t.lineTo}"/>
    </linearGradient>
    <linearGradient id="star-area-${themeName}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${t.areaFrom}"/>
      <stop offset="100%" stop-color="${t.areaTo}"/>
    </linearGradient>
  </defs>
  ${yTickLines}
  ${areaPath ? `<path d="${areaPath}" fill="url(#star-area-${themeName})"/>` : ''}
  ${linePath ? `<path d="${linePath}" fill="none" stroke="url(#star-line-${themeName})" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
  ${endpoint}
  ${xTickLabels}
</svg>
`;
}

function main() {
  console.log(`拉取 ${REPO} 的 stargazers 数据...`);
  const starDates = fetchStarDates(REPO);
  console.log(`  获取到 ${starDates.length} 颗 star (${starDates[0].slice(0, 10)} → ${starDates[starDates.length - 1].slice(0, 10)})`);

  const series = buildDailySeries(starDates);
  mkdirSync(OUT_DIR, { recursive: true });

  const lightSvg = renderSvg(series, 'light');
  const darkSvg = renderSvg(series, 'dark');
  const lightPath = path.join(OUT_DIR, 'star-history.svg');
  const darkPath = path.join(OUT_DIR, 'star-history-dark.svg');
  writeFileSync(lightPath, lightSvg, 'utf8');
  writeFileSync(darkPath, darkSvg, 'utf8');
  console.log(`已生成 ${path.relative(process.cwd(), lightPath)} (${(lightSvg.length / 1024).toFixed(1)} KB)`);
  console.log(`已生成 ${path.relative(process.cwd(), darkPath)} (${(darkSvg.length / 1024).toFixed(1)} KB)`);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
