import type { AltAlternative, AltEntry, AltProprietary, AltsCategory } from '@/modules/onboarding/helpers/types';
import { apiFetch } from '@/lib/api-fetch';

/**
 * Public CI Cloud catalog (no trailing slash). Used when the Hub image predates `GET /api/store/alternatives`.
 */
async function resolveCiCloudCatalogBaseUrl(): Promise<string> {
  const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
  if (baked) return baked.replace(/\/$/, '');

  const res = await apiFetch('/api/registration/device-id');
  if (!res.ok) {
    throw new Error(
      `Could not resolve CI Cloud URL for alternatives (${res.status}). Set CI_CLOUD_URL on the Hub and restart, or update the Hub image.`,
    );
  }
  const data = (await res.json()) as { ci_cloud_url?: string | null };
  const fromApi = data.ci_cloud_url?.trim();
  if (!fromApi) {
    throw new Error('CI_CLOUD_URL is not set on this Hub. Add it to your env file and restart.');
  }
  return fromApi.replace(/\/$/, '');
}

async function fetchAlternativesFromCiCloud(): Promise<AltsCategory> {
  const base = await resolveCiCloudCatalogBaseUrl();
  const res = await fetch(`${base}/api/store/alternatives`, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`CI Cloud returned HTTP ${res.status} for the alternatives catalog.`);
  }
  const json: unknown = await res.json();
  return normalizeAlternativesPayload(json);
}

function normalizeProprietary(p: Partial<AltProprietary> & { name: string }): AltProprietary {
  return {
    name: p.name,
    icon: typeof p.icon === 'string' ? p.icon : '',
    url: p.url ?? null,
  };
}

function normalizeAlternative(a: Partial<AltAlternative> & { name: string }): AltAlternative {
  return {
    name: a.name,
    icon: typeof a.icon === 'string' ? a.icon : '',
    url: typeof a.url === 'string' ? a.url : '',
    ...(a.appSlug ? { appSlug: a.appSlug } : {}),
  };
}

/** Normalizes portal JSON to onboarding/store types (required string fields). */
export function normalizeAlternativesPayload(raw: unknown): AltsCategory {
  if (raw === null || typeof raw !== 'object') return {};
  const out: AltsCategory = {};
  for (const [category, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list: AltEntry[] = [];
    for (const row of entries) {
      if (!row || typeof row !== 'object') continue;
      const proprietaryRaw = (row as { proprietary?: unknown }).proprietary;
      const alternativesRaw = (row as { alternatives?: unknown }).alternatives;
      if (!Array.isArray(proprietaryRaw) || !Array.isArray(alternativesRaw)) continue;
      const proprietary: AltProprietary[] = [];
      for (const p of proprietaryRaw) {
        if (p && typeof p === 'object' && typeof (p as { name?: string }).name === 'string') {
          proprietary.push(normalizeProprietary(p as AltProprietary));
        }
      }
      const alternatives: AltAlternative[] = [];
      for (const a of alternativesRaw) {
        if (a && typeof a === 'object' && typeof (a as { name?: string }).name === 'string') {
          alternatives.push(normalizeAlternative(a as AltAlternative));
        }
      }
      if (proprietary.length > 0 && alternatives.length > 0) {
        list.push({ proprietary, alternatives });
      }
    }
    if (list.length > 0) out[category] = list;
  }
  return out;
}

export async function fetchPortalAlternatives(): Promise<AltsCategory> {
  const res = await apiFetch('/api/store/alternatives');
  if (res.ok) {
    const json: unknown = await res.json();
    return normalizeAlternativesPayload(json);
  }

  /** Desktop releases pull `ghcr.io/.../ci-hub:*` by default; older tags have no proxy route. */
  if (res.status === 404) {
    console.warn('[alternatives] Hub returned 404 for /api/store/alternatives (older image or missing route); trying CI Cloud directly.');
    try {
      return await fetchAlternativesFromCiCloud();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `This Hub build does not expose /api/store/alternatives yet, and loading the catalog from CI Cloud failed: ${msg}. Update CI_HUB_IMAGE / rebuild the Hub container, or check network access to your CI Cloud URL.`,
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
  throw new Error(`Failed to load alternatives (${res.status})${detail}`);
}

export const portalAlternativesQueryKey = ['portal', 'store-alternatives'] as const;

export function portalAlternativesQueryOptions() {
  return {
    queryKey: portalAlternativesQueryKey,
    queryFn: fetchPortalAlternatives,
    staleTime: 5 * 60 * 1000,
  } as const;
}
