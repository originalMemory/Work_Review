import { writable, type Readable, type Writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { translateCategoryLabel, translateSemanticCategoryLabel } from '$lib/i18n/index.ts';

/** Rust `CategoryInfo` 的前端序列化结构。 */
export interface CategoryInfo {
  key: string;
  name: string;
  color: string;
  icon: string;
  is_system: boolean;
}

export interface CategoryMeta {
  color: string;
  icon: string;
  name: string;
  isSystem: boolean;
}

export interface CategoryStore extends Readable<CategoryInfo[]> {
  set: Writable<CategoryInfo[]>['set'];
  update: Writable<CategoryInfo[]>['update'];
  refresh: () => Promise<void>;
  getCategoryMeta: (key: string) => CategoryMeta;
  getAllCategories: () => CategoryInfo[];
}

/** Rust `SemanticCategoryInfo` 的前端序列化结构。 */
export interface SemanticCategoryInfo {
  key: string;
  name: string;
  is_system: boolean;
}

export interface SemanticCategoryStore extends Readable<SemanticCategoryInfo[]> {
  set: Writable<SemanticCategoryInfo[]>['set'];
  refresh: () => Promise<void>;
  getSemanticCategoryDisplayName: (key: string) => string;
  getAllSemanticCategories: () => SemanticCategoryInfo[];
}

function createCategoryStore(): CategoryStore {
  const { subscribe, set, update } = writable<CategoryInfo[]>([]);

  async function refresh(): Promise<void> {
    try {
      const categories = await invoke<CategoryInfo[]>('get_categories');
      set(categories);
    } catch (e) {
      console.error('获取分类列表失败:', e);
    }
  }

  function getCategoryMeta(key: string): CategoryMeta {
    let result: CategoryMeta = { color: 'gray', icon: '📁', name: key, isSystem: false };
    let cats: CategoryInfo[] = [];
    const unsub = subscribe(v => { cats = v; });
    unsub();

    const found = cats.find(c => c.key === key);
    if (found) {
      const translatedCategoryName = translateCategoryLabel(found.key);
      const isKnownSystemCategory = found.is_system || translatedCategoryName !== found.key;
      result = {
        color: found.color,
        icon: found.icon,
        name: isKnownSystemCategory ? translatedCategoryName : (found.name || translatedCategoryName),
        isSystem: isKnownSystemCategory,
      };
    } else {
      result.name = translateCategoryLabel(key);
    }
    return result;
  }

  function getAllCategories(): CategoryInfo[] {
    let cats: CategoryInfo[] = [];
    const unsub = subscribe(v => { cats = v; });
    unsub();
    return cats;
  }

  return { subscribe, set, update, refresh, getCategoryMeta, getAllCategories };
}

export const categoryStore: CategoryStore = createCategoryStore();

function createSemanticCategoryStore(): SemanticCategoryStore {
  const { subscribe, set } = writable<SemanticCategoryInfo[]>([]);

  async function refresh(): Promise<void> {
    try {
      const categories = await invoke<SemanticCategoryInfo[]>('get_semantic_categories');
      set(categories);
    } catch (e) {
      console.error('获取语义分类列表失败:', e);
    }
  }

  function getSemanticCategoryDisplayName(key: string): string {
    let cats: SemanticCategoryInfo[] = [];
    const unsub = subscribe(v => { cats = v; });
    unsub();

    const found = cats.find(c => c.key === key);
    if (found) {
      const translatedSemanticCategoryName = translateSemanticCategoryLabel(found.key);
      const isKnownSemanticCategory = found.is_system || translatedSemanticCategoryName !== found.key;
      return isKnownSemanticCategory ? translatedSemanticCategoryName : (found.name || translatedSemanticCategoryName);
    }
    return translateSemanticCategoryLabel(key) || key;
  }

  function getAllSemanticCategories(): SemanticCategoryInfo[] {
    let cats: SemanticCategoryInfo[] = [];
    const unsub = subscribe(v => { cats = v; });
    unsub();
    return cats;
  }

  return { subscribe, set, refresh, getSemanticCategoryDisplayName, getAllSemanticCategories };
}

export const semanticCategoryStore: SemanticCategoryStore = createSemanticCategoryStore();

export function hexToRGBA(hex: string | null | undefined, alpha: number): string {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return `rgba(100, 116, 139, ${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 把当前分类提到选择器最前，其余保持原有顺序。 */
export function splitCategoriesForPicker(
  categories: readonly CategoryInfo[],
  currentKey: string | null | undefined,
): { current: CategoryInfo | null; others: CategoryInfo[] } {
  const key = currentKey || 'other';
  let current: CategoryInfo | null = null;
  const others: CategoryInfo[] = [];
  for (const category of categories) {
    if (current === null && category.key === key) {
      current = category;
      continue;
    }
    others.push(category);
  }
  return { current, others };
}
