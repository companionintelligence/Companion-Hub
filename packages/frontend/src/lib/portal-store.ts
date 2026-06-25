import type { AppCategory, AppInfoSimple } from '@/types/app.types';
import { APP_CATEGORIES } from '@ci-hub/common/schemas';
import { apiFetch } from '@/lib/api-fetch';
import { captureHubWarning } from '@/lib/sentry';

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

async function resolveCiCloudCatalogBaseUrl(): Promise<string> {
  const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
  if (baked) return baked.replace(/\/$/, '');

  const res = await apiFetch('/api/registration/device-id');
  if (!res.ok) {
    throw new Error(
      `Could not resolve CI Cloud URL for store listings (${res.status}). Set CI_CLOUD_URL on the Hub and restart, or update the Hub image.`,
    );
  }
  const data = (await res.json()) as { ci_cloud_url?: string | null };
  const fromApi = data.ci_cloud_url?.trim();
  if (!fromApi) {
    throw new Error('CI_CLOUD_URL is not set on this Hub. Add it to your env file and restart.');
  }
  return fromApi.replace(/\/$/, '');
}

async function fetchListingsFromCiCloud(params: PortalStoreListingsParams): Promise<HubStoreApp[]> {
  const base = await resolveCiCloudCatalogBaseUrl();
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set('category', params.category);
  if (params.tags) searchParams.set('tags', params.tags);
  if (params.sort) searchParams.set('sort', params.sort);
  if (params.q) searchParams.set('q', params.q);
  const qs = searchParams.toString();
  const res = await fetch(`${base}/api/store${qs ? `?${qs}` : ''}`, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`CI Cloud returned HTTP ${res.status} for the store catalog.`);
  }
  const json: unknown = await res.json();
  return normalizeStoreListingsPayload(json);
}

export async function fetchPortalStoreListings(params: PortalStoreListingsParams): Promise<HubStoreApp[]> {
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set('category', params.category);
  if (params.tags) searchParams.set('tags', params.tags);
  if (params.sort) searchParams.set('sort', params.sort);
  if (params.q) searchParams.set('q', params.q);
  const qs = searchParams.toString();
  const res = await apiFetch(`/api/store/listings${qs ? `?${qs}` : ''}`);
  if (res.ok) {
    const json: unknown = await res.json();
    return normalizeStoreListingsPayload(json);
  }

  if (res.status === 404) {
    console.warn('[store-listings] Hub returned 404 for /api/store/listings; trying CI Cloud directly.');
    captureHubWarning(
      'Hub store listings endpoint missing; falling back to CI Cloud catalog',
      {
        status: res.status,
        endpoint: '/api/store/listings',
      },
      { dedupeKey: 'portal-store-listings-hub-404-fallback' },
    );
    try {
      return await fetchListingsFromCiCloud(params);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `This Hub build does not expose /api/store/listings yet, and loading the catalog from CI Cloud failed: ${msg}. Update CI_HUB_IMAGE / rebuild the Hub container, or check network access to your CI Cloud URL.`,
      );
    }
  }

  let detail = '';
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const m = body?.message;
    detail = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? `: ${m}` : '';
  } catch {
    /* ignore */
  }
  throw new Error(`Failed to load store listings (${res.status})${detail}`);
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
