import { get, writable } from 'svelte/store';
import zhCN from './locales/zh-CN.ts';
import en from './locales/en.ts';
import zhTW from './locales/zh-TW.ts';
import ar from './locales/ar.ts';

const LOCALE_STORAGE_KEY = 'work-review.locale';
const DEFAULT_LOCALE: Locale = 'zh-CN';

export const SUPPORTED_LOCALES = ['zh-CN', 'en', 'zh-TW', 'ar'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];

export type TranslationValue =
  | string
  | string[]
  | TranslationDictionary;

export interface TranslationDictionary {
  [key: string]: TranslationValue;
}

export type InterpolationParams = Readonly<Record<string, unknown>>;

export interface DurationFormatOptions {
  compact?: boolean;
}

interface LocaleMeta {
  short: string;
  label: string;
}

const LOCALE_CYCLE: readonly Locale[] = ['zh-CN', 'en', 'zh-TW', 'ar'];

const LOCALE_META = {
  'zh-CN': {
    short: 'ZH',
    label: '简体中文',
  },
  en: {
    short: 'EN',
    label: 'English',
  },
  'zh-TW': {
    short: 'TW',
    label: '繁體中文',
  },
  ar: {
    short: 'AR',
    label: 'العربية',
  },
} satisfies Record<Locale, LocaleMeta>;

const CATEGORY_LABELS: Record<string, Record<Locale, string>> = {
  development: {
    'zh-CN': '开发工具',
    en: 'Development',
    'zh-TW': '開發工具',
    ar: 'أدوات التطوير',
  },
  browser: {
    'zh-CN': '浏览器',
    en: 'Browser',
    'zh-TW': '瀏覽器',
    ar: 'المتصفح',
  },
  communication: {
    'zh-CN': '通讯协作',
    en: 'Communication',
    'zh-TW': '通訊協作',
    ar: 'تواصل وتعاون',
  },
  office: {
    'zh-CN': '办公软件',
    en: 'Office',
    'zh-TW': '辦公軟體',
    ar: 'برامج مكتبية',
  },
  design: {
    'zh-CN': '设计工具',
    en: 'Design',
    'zh-TW': '設計工具',
    ar: 'أدوات التصميم',
  },
  entertainment: {
    'zh-CN': '娱乐摸鱼',
    en: 'Leisure',
    'zh-TW': '娛樂摸魚',
    ar: 'ترفيه',
  },
  other: {
    'zh-CN': '其他',
    en: 'Other',
    'zh-TW': '其他',
    ar: 'أخرى',
  },
};

const SEMANTIC_LABELS: Record<string, Record<Locale, string>> = {
  '编码开发': {
    'zh-CN': '编码开发',
    en: 'Development',
    'zh-TW': '編碼開發',
    ar: 'برمجة وتطوير',
  },
  '内容撰写': {
    'zh-CN': '内容撰写',
    en: 'Writing',
    'zh-TW': '內容撰寫',
    ar: 'كتابة محتوى',
  },
  '资料阅读': {
    'zh-CN': '资料阅读',
    en: 'Reading',
    'zh-TW': '資料閱讀',
    ar: 'قراءة',
  },
  '资料调研': {
    'zh-CN': '资料调研',
    en: 'Research',
    'zh-TW': '資料調研',
    ar: 'بحث واستقصاء',
  },
  '任务规划': {
    'zh-CN': '任务规划',
    en: 'Planning',
    'zh-TW': '任務規劃',
    ar: 'تخطيط المهام',
  },
  '设计创作': {
    'zh-CN': '设计创作',
    en: 'Design',
    'zh-TW': '設計創作',
    ar: 'تصميم وإبداع',
  },
  'AI 协作': {
    'zh-CN': 'AI 协作',
    en: 'AI Collaboration',
    'zh-TW': 'AI 協作',
    ar: 'تعاون مع الذكاء الاصطناعي',
  },
  '即时聊天': {
    'zh-CN': '即时聊天',
    en: 'Chat',
    'zh-TW': '即時聊天',
    ar: 'محادثة فورية',
  },
  '会议沟通': {
    'zh-CN': '会议沟通',
    en: 'Meetings',
    'zh-TW': '會議溝通',
    ar: 'اجتماعات وتواصل',
  },
  '视频内容': {
    'zh-CN': '视频内容',
    en: 'Video',
    'zh-TW': '影片內容',
    ar: 'محتوى فيديو',
  },
  '音乐音频': {
    'zh-CN': '音乐音频',
    en: 'Audio',
    'zh-TW': '音樂音訊',
    ar: 'صوتيات وموسيقى',
  },
  '休息娱乐': {
    'zh-CN': '休息娱乐',
    en: 'Leisure',
    'zh-TW': '休息娛樂',
    ar: 'راحة وترفيه',
  },
  '未知活动': {
    'zh-CN': '未知活动',
    en: 'Unknown',
    'zh-TW': '未知活動',
    ar: 'نشاط غير معروف',
  },
};


const MESSAGES = {
  'zh-CN': zhCN,
  en,
  'zh-TW': zhTW,
  ar,
} satisfies Record<Locale, TranslationDictionary>;


export const locale = writable<Locale>(DEFAULT_LOCALE);

function isSupportedLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.some((localeCode) => localeCode === value);
}

function normalizeLocale(value?: string | null): Locale {
  if (!value) {
    return DEFAULT_LOCALE;
  }

  const normalized = value.trim();
  if (isSupportedLocale(normalized)) {
    return normalized;
  }

  if (normalized.toLowerCase().startsWith('zh-tw') || normalized.toLowerCase().startsWith('zh-hk')) {
    return 'zh-TW';
  }

  if (normalized.toLowerCase().startsWith('zh')) {
    return 'zh-CN';
  }

  if (normalized.toLowerCase().startsWith('en')) {
    return 'en';
  }

  if (normalized.toLowerCase().startsWith('ar')) {
    return 'ar';
  }

  return DEFAULT_LOCALE;
}

function getStoredLocale(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistLocale(nextLocale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
  } catch {
    // ignore persistence errors
  }
}

function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') {
    return DEFAULT_LOCALE;
  }

  for (const candidate of navigator.languages || [navigator.language]) {
    const normalized = normalizeLocale(candidate);
    if (isSupportedLocale(normalized)) {
      return normalized;
    }
  }

  return DEFAULT_LOCALE;
}

export function initializeLocale(preferredLocale?: string | null): Locale {
  const nextLocale = normalizeLocale(preferredLocale || getStoredLocale() || detectBrowserLocale());
  locale.set(nextLocale);
  persistLocale(nextLocale);
  return nextLocale;
}

export function setLocale(nextLocale?: string | null): Locale {
  const normalized = normalizeLocale(nextLocale);
  locale.set(normalized);
  persistLocale(normalized);
  return normalized;
}

export function cycleLocale(): Locale {
  const currentLocale = get(locale);
  const currentIndex = LOCALE_CYCLE.indexOf(currentLocale);
  const nextLocale = LOCALE_CYCLE[(currentIndex + 1 + LOCALE_CYCLE.length) % LOCALE_CYCLE.length];
  return setLocale(nextLocale);
}

function resolveKey(
  object: TranslationDictionary,
  key: string,
): TranslationValue | undefined {
  let current: TranslationValue | undefined = object;

  for (const segment of key.split('.')) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }

    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function resolveMessageValue(key: string): TranslationValue | undefined {
  const currentLocale = get(locale);
  return (
    resolveKey(MESSAGES[currentLocale], key) ??
    resolveKey(MESSAGES[DEFAULT_LOCALE], key)
  );
}

function interpolate(template: string, params: InterpolationParams): string {
  return Object.entries(params).reduce(
    (output, [paramKey, paramValue]) => output.replaceAll(`{${paramKey}}`, String(paramValue)),
    template,
  );
}

export function t(key: string, params: InterpolationParams = {}): string {
  const rawValue = resolveMessageValue(key) ?? key;

  if (typeof rawValue !== 'string') {
    return key;
  }

  return interpolate(rawValue, params);
}

export function tm(key: string): TranslationValue | undefined {
  return resolveMessageValue(key);
}

export function getLocaleShortLabel(
  localeCode: string | null = get(locale),
): string {
  return LOCALE_META[normalizeLocale(localeCode)].short;
}

export function getLocaleLabel(localeCode: string | null = get(locale)): string {
  return LOCALE_META[normalizeLocale(localeCode)].label;
}

export function applyLocaleToDocument(
  nextLocale: string | null = get(locale),
): void {
  if (typeof document === 'undefined') {
    return;
  }

  const normalized = normalizeLocale(nextLocale);
  document.documentElement.lang = normalized;
  document.documentElement.dir = normalized === 'ar' ? 'rtl' : 'ltr';
}

export function formatLocalizedDate(
  date: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(get(locale), options).format(date);
}

export function formatLocalizedTime(
  date: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(get(locale), options).format(date);
}

export function formatDurationLocalized(
  seconds: number | null | undefined,
  { compact = false }: DurationFormatOptions = {},
): string {
  const currentLocale = get(locale);
  const hourUnit = currentLocale === 'zh-TW' ? (compact ? '時' : '小時') : currentLocale === 'ar' ? (compact ? 'س' : ' ساعة ') : (compact ? '时' : '小时');
  const minuteUnit = currentLocale === 'zh-TW' ? (compact ? '分' : '分鐘') : currentLocale === 'ar' ? (compact ? 'د' : ' دقيقة ') : (compact ? '分' : '分钟');
  const secondUnit = currentLocale === 'zh-TW' ? '秒' : currentLocale === 'ar' ? 'ث' : '秒';

  if (!seconds || seconds <= 0) {
    if (currentLocale === 'en') {
      return compact ? '0m' : '0s';
    }
    if (currentLocale === 'ar') {
      return compact ? '0د' : '0 ثانية';
    }
    return `0${minuteUnit}`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (currentLocale === 'en') {
    if (hours > 0) {
      return compact ? (minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`) : (minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`);
    }
    if (minutes > 0) {
      return compact ? `${minutes}m` : `${minutes}m`;
    }
    return compact ? `${secs}s` : `${secs}s`;
  }
  
  if (currentLocale === 'ar') {
    if (hours > 0) {
      return compact ? (minutes > 0 ? `${hours}س ${minutes}د` : `${hours}س`) : (minutes > 0 ? `${hours} ساعة و ${minutes} دقيقة` : `${hours} ساعة`);
    }
    if (minutes > 0) {
      return compact ? `${minutes}د` : `${minutes} دقيقة`;
    }
    return compact ? `${secs}ث` : `${secs} ثانية`;
  }

  if (hours > 0) {
    return minutes > 0 ? `${hours}${hourUnit}${minutes}${minuteUnit}` : `${hours}${hourUnit}`;
  }

  if (minutes > 0) {
    return `${minutes}${minuteUnit}`;
  }

  return `${secs}${secondUnit}`;
}

export function translateCategoryLabel(categoryKey: string): string {
  const currentLocale = get(locale);
  return CATEGORY_LABELS[categoryKey]?.[currentLocale] || CATEGORY_LABELS[categoryKey]?.[DEFAULT_LOCALE] || categoryKey;
}

export function translateSemanticCategoryLabel(label: string): string {
  const currentLocale = get(locale);
  return SEMANTIC_LABELS[label]?.[currentLocale] || SEMANTIC_LABELS[label]?.[DEFAULT_LOCALE] || label;
}
