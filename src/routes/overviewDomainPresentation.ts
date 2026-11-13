const SEMANTIC_CATEGORY_COLORS: Readonly<Record<string, string>> = {
  '编码开发': '#3B82F6',
  '内容撰写': '#06B6D4',
  '资料阅读': '#10B981',
  '资料调研': '#14B8A6',
  '任务规划': '#8B5CF6',
  '设计创作': '#F59E0B',
  'AI 协作': '#6366F1',
  '即时聊天': '#A855F7',
  '会议沟通': '#0EA5E9',
  '视频内容': '#F43F5E',
  '音乐音频': '#D946EF',
  '休息娱乐': '#EF4444',
  '未知活动': '#94A3B8',
};

const CUSTOM_SEMANTIC_COLORS: readonly string[] = [
  '#3B82F6',
  '#8B5CF6',
  '#14B8A6',
  '#F59E0B',
  '#EC4899',
  '#0EA5E9',
  '#10B981',
  '#F97316',
];

export interface DomainBrowserSourceInput {
  readonly browser_name?: unknown;
  readonly duration?: unknown;
  readonly percentage?: unknown;
}

export interface BrowserDomainInput {
  readonly domain?: unknown;
  readonly duration?: unknown;
}

export interface BrowserUsageInput {
  readonly browser_name?: unknown;
  readonly domains?: readonly (BrowserDomainInput | null | undefined)[] | null;
}

export interface DomainPresentationInput {
  readonly domain?: unknown;
  readonly duration?: unknown;
  readonly page_count?: unknown;
  readonly urls?: readonly unknown[] | null;
  readonly browser_sources?: readonly (DomainBrowserSourceInput | null | undefined)[] | null;
}

export interface DomainBrowserSource {
  readonly browser_name: string;
  readonly duration: number;
  readonly percentage: number;
}

export interface DomainSourceTrackItem extends DomainBrowserSource {
  readonly widthPct: number;
}

export interface DomainPresentation {
  readonly browserSources: DomainBrowserSource[];
  readonly sourceTrack: DomainSourceTrackItem[];
  readonly sourceLabel: string;
  readonly pageCount: number;
}

interface PendingDomainBrowserSource {
  readonly browser_name: string;
  readonly duration: number;
  readonly percentage: number | null;
}

function stableHash(value: unknown): number {
  let hash = 0;
  for (const character of String(value || '')) {
    hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  }
  return Math.abs(hash);
}

function toNonNegativeNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function clampPercentage(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, numeric));
}

function normalizeExplicitSources(
  explicitSources:
    | readonly (DomainBrowserSourceInput | null | undefined)[]
    | null
    | undefined,
): DomainBrowserSource[] {
  const normalized: PendingDomainBrowserSource[] = [];
  for (const source of explicitSources || []) {
    const browserName = String(source?.browser_name || '').trim();
    if (!browserName) continue;
    normalized.push({
      browser_name: browserName,
      duration: toNonNegativeNumber(source?.duration),
      percentage: clampPercentage(source?.percentage),
    });
  }

  const totalDuration = normalized.reduce((sum, source) => sum + source.duration, 0);
  return normalized.map((source) => ({
    ...source,
    percentage: source.percentage
      ?? (totalDuration > 0 ? (source.duration / totalDuration) * 100 : 0),
  }));
}

export function collectDomainBrowserSources(
  domainName: unknown,
  browserUsage:
    | readonly (BrowserUsageInput | null | undefined)[]
    | null
    | undefined = [],
  explicitSources:
    | readonly (DomainBrowserSourceInput | null | undefined)[]
    | null
    | undefined = [],
): DomainBrowserSource[] {
  if (Array.isArray(explicitSources) && explicitSources.length > 0) {
    return normalizeExplicitSources(explicitSources);
  }

  const domainKey = String(domainName || '').trim();
  if (!domainKey) return [];

  const durationByBrowser = new Map<string, number>();
  for (const browser of browserUsage || []) {
    const browserName = String(browser?.browser_name || '').trim();
    if (!browserName) continue;
    const matchingDuration = (browser?.domains || [])
      .filter((domain) => domain?.domain === domainKey)
      .reduce((sum, domain) => sum + toNonNegativeNumber(domain?.duration), 0);
    if (matchingDuration <= 0) continue;
    durationByBrowser.set(browserName, (durationByBrowser.get(browserName) || 0) + matchingDuration);
  }

  const totalDuration = [...durationByBrowser.values()]
    .reduce((sum, duration) => sum + duration, 0);
  return [...durationByBrowser.entries()]
    .map(([browser_name, duration]) => ({
      browser_name,
      duration,
      percentage: totalDuration > 0 ? (duration / totalDuration) * 100 : 0,
    }))
    .sort(
      (left, right) =>
        right.duration - left.duration || left.browser_name.localeCompare(right.browser_name)
    );
}

export function buildDomainSourceTrack(
  browserSources:
    | readonly (DomainBrowserSourceInput | null | undefined)[]
    | null
    | undefined = [],
  domainDuration: unknown = 0,
): DomainSourceTrackItem[] {
  const normalized = normalizeExplicitSources(browserSources);
  const totalSourceDuration = normalized.reduce((sum, source) => sum + source.duration, 0);
  const referenceDuration = toNonNegativeNumber(domainDuration) || totalSourceDuration;

  return normalized.map((source) => {
    const percentage = clampPercentage(source.percentage)
      ?? (referenceDuration > 0 ? (source.duration / referenceDuration) * 100 : 0);
    return {
      browser_name: source.browser_name,
      duration: source.duration,
      percentage,
      widthPct: percentage,
    };
  });
}

export function buildDomainPresentation(
  domain: DomainPresentationInput | null = {},
  browserUsage:
    | readonly (BrowserUsageInput | null | undefined)[]
    | null
    | undefined = [],
): DomainPresentation {
  const browserSources = collectDomainBrowserSources(
    domain?.domain,
    browserUsage,
    domain?.browser_sources,
  );
  const sourceTrack = buildDomainSourceTrack(browserSources, domain?.duration);

  return {
    browserSources,
    sourceTrack,
    sourceLabel: browserSources
      .map((source) => `${source.browser_name} ${Math.round(source.percentage)}%`)
      .join(' · '),
    pageCount: Math.max(0, Number(domain?.page_count ?? domain?.urls?.length ?? 0) || 0),
  };
}

export function getSemanticCategoryColor(categoryKey: unknown): string {
  const normalizedKey = String(categoryKey || '').trim();
  if (!normalizedKey) return '#94A3B8';
  const semanticColor = SEMANTIC_CATEGORY_COLORS[normalizedKey];
  if (semanticColor) return semanticColor;
  return CUSTOM_SEMANTIC_COLORS[stableHash(normalizedKey) % CUSTOM_SEMANTIC_COLORS.length]!;
}
