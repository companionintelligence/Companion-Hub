import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { APP_CATEGORIES } from '@ci-hub/common/schemas';
import { getStoreListings } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

const APP_CATEGORY_SET = new Set<string>(APP_CATEGORIES);

function toAppCategories(raw: string[]): AppCategory[] {
  const categories = raw.filter((c): c is AppCategory => APP_CATEGORY_SET.has(c));
  return categories.length > 0 ? categories : ['utilities'];
}

export type PortalStoreApp = {
  id: string;
  title?: string;
  name?: string;
  short_desc?: string;
  shortDescription?: string | null;
  description?: string;
  icon?: string | null;
  tags?: string[];
  categories?: string[];
};

export type PortalStoreListingsParams = {
  category?: string;
  tags?: string;
  sort?: 'newest' | 'trending';
  q?: string;
};

export const CI_MARKETPLACE_STORE_ID = 'ci-marketplace';

/** Portal-sourced listing shape used by AppCard and featured store sections. */
export type HubStoreApp = Pick<AppInfoSimple, 'urn' | 'name' | 'short_desc' | 'categories'> & {
  iconUrl?: string | null;
};

function hubAppSlug(app: HubStoreApp): string {
  const slug = app.urn.split(':')[0];
  if (!slug) throw new Error(`Invalid portal store app URN: ${app.urn}`);
  return slug;
}

export function mapPortalStoreAppToHub(app: PortalStoreApp, storeId = CI_MARKETPLACE_STORE_ID): HubStoreApp {
  const id = app.id;
  const name = app.name ?? app.title ?? id;
  const short_desc = app.short_desc ?? app.shortDescription ?? app.description ?? '';
  const categories = toAppCategories(app.categories?.length ? app.categories : (app.tags ?? []));
  return {
    urn: `${id}:${storeId}`,
    name,
    short_desc,
    categories,
    iconUrl: app.icon ?? null,
  };
}

function normalizeStoreListingsPayload(raw: unknown): HubStoreApp[] {
  if (!Array.isArray(raw)) return [];
  const out: HubStoreApp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const app = item as PortalStoreApp;
    if (typeof app.id !== 'string') continue;
    out.push(mapPortalStoreAppToHub(app));
  }
  return out;
}

/** Direct Portal fetch — dev-only escape hatch when Hub proxy is unavailable locally. */
async function fetchListingsDirectFromPortal(params: PortalStoreListingsParams, portalUrl: string): Promise<HubStoreApp[]> {
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set('category', params.category);
  if (params.tags) searchParams.set('tags', params.tags);
  if (params.sort) searchParams.set('sort', params.sort);
  if (params.q) searchParams.set('q', params.q);
  const qs = searchParams.toString();
  const base = portalUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/store${qs ? `?${qs}` : ''}`, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Portal returned HTTP ${res.status} for the store catalog.`);
  }
  const json: unknown = await res.json();
  return normalizeStoreListingsPayload(json);
}

export async function fetchPortalStoreListings(params: PortalStoreListingsParams): Promise<HubStoreApp[]> {
  const result = await sdkResult(
    getStoreListings({
      query: {
        category: params.category ?? '',
        tags: params.tags ?? '',
        sort: params.sort ?? '',
        q: params.q ?? '',
      },
    } as Parameters<typeof getStoreListings>[0]),
  );
  if (result.ok) {
    return normalizeStoreListingsPayload(result.data);
  }

  const devDirect = import.meta.env.DEV && import.meta.env.VITE_DEV_DIRECT_PORTAL === 'true';
  if (devDirect) {
    const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
    if (baked) {
      return fetchListingsDirectFromPortal(params, baked);
    }
  }

  let detail = '';
  try {
    const body = result.data as { message?: string | string[]; messageKey?: string } | undefined;
    if (body?.messageKey) {
      detail = `: ${body.messageKey}`;
    } else {
      const m = body?.message;
      detail = Array.isArray(m) ? `: ${m.join(' ')}` : typeof m === 'string' ? `: ${m}` : '';
    }
  } catch {
    /* ignore */
  }
  throw new Error(`Failed to load store listings (${result.status})${detail}`);
}

export function portalStoreListingsQueryKey(params: PortalStoreListingsParams, storeId = CI_MARKETPLACE_STORE_ID) {
  return ['portal', 'store-listings', storeId, params] as const;
}

export function portalStoreListingsQueryOptions(params: PortalStoreListingsParams, storeId = CI_MARKETPLACE_STORE_ID) {
  return {
    queryKey: portalStoreListingsQueryKey(params, storeId),
    queryFn: async () => {
      const apps = await fetchPortalStoreListings(params);
      if (storeId === CI_MARKETPLACE_STORE_ID) return apps;
      return apps.map((app) =>
        mapPortalStoreAppToHub(
          { id: hubAppSlug(app), name: app.name, short_desc: app.short_desc, categories: app.categories, icon: app.iconUrl },
          storeId,
        ),
      );
    },
    staleTime: 5 * 60 * 1000,
  } as const;
}
