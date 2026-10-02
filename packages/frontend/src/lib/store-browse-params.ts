import type { StoreCategoryFilter } from '@/stores/app-store';

export type StoreBrowseParams = {
  q?: string;
  category?: StoreCategoryFilter;
  store?: string;
};

const ALTERNATIVES_PARAM = 'alternatives';

export function categoryFromUrlParam(value: string | null): StoreCategoryFilter | undefined {
  if (!value) return undefined;
  if (value === 'featured') return 'featured';
  if (value === ALTERNATIVES_PARAM) return '__alternatives__';
  return value as StoreCategoryFilter;
}

export function categoryToUrlParam(category: StoreCategoryFilter | undefined): string | undefined {
  if (!category) return undefined;
  if (category === '__alternatives__') return ALTERNATIVES_PARAM;
  return category;
}

export function parseStoreBrowseParams(searchParams: URLSearchParams): StoreBrowseParams {
  const q = searchParams.get('q')?.trim();
  const categoryRaw = searchParams.get('category');
  const store = searchParams.get('store')?.trim();

  return {
    ...(q ? { q } : {}),
    ...(categoryRaw ? { category: categoryFromUrlParam(categoryRaw) } : {}),
    ...(store ? { store } : {}),
  };
}

export function applyStoreBrowseParams(searchParams: URLSearchParams, params: StoreBrowseParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);

  if (params.q?.trim()) {
    next.set('q', params.q);
  } else {
    next.delete('q');
  }

  const categoryParam = categoryToUrlParam(params.category);
  if (categoryParam) {
    next.set('category', categoryParam);
  } else {
    next.delete('category');
  }

  if (params.store?.trim()) {
    next.set('store', params.store);
  } else {
    next.delete('store');
  }

  return next;
}

export function buildStoreIndexPath(params: StoreBrowseParams): string {
  const qs = applyStoreBrowseParams(new URLSearchParams(), params).toString();
  return qs ? `/store?${qs}` : '/store';
}

export function storeBrowseQueryString(params: StoreBrowseParams): string {
  return applyStoreBrowseParams(new URLSearchParams(), params).toString();
}

/**
 * A cold link names its store before Zustand does. Keep that name until the
 * store list can confirm it. An unknown name falls back to the store already
 * selected, which is what clears a bad `?store=`.
 */
export function storeParamToWrite(
  urlStore: string | undefined,
  storeId: string | undefined,
  knownSlugs: readonly string[] | undefined,
): string | undefined {
  if (urlStore && (knownSlugs === undefined || knownSlugs.includes(urlStore))) {
    return urlStore;
  }
  return storeId;
}

/** Featured is curated; non-empty search should browse the full catalog. */
export function shouldLeaveFeaturedForSearch(category: StoreCategoryFilter | undefined, query: string): boolean {
  return category === 'featured' && query.trim().length > 0;
}
