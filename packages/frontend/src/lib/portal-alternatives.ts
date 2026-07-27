import type { AltAlternative, AltEntry, AltProprietary, AltsCategory } from '@/modules/onboarding/helpers/types';
import { getStoreAlternatives } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

/** Direct Portal fetch — dev-only when VITE_DEV_DIRECT_PORTAL=true. */
async function fetchAlternativesDirectFromPortal(portalUrl: string): Promise<AltsCategory> {
  const base = portalUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/store/alternatives`, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Portal returned HTTP ${res.status} for the alternatives catalog.`);
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
function normalizeAlternativesPayload(raw: unknown): AltsCategory {
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

async function fetchPortalAlternatives(): Promise<AltsCategory> {
  const result = await sdkResult(getStoreAlternatives());
  if (result.ok) {
    return normalizeAlternativesPayload(result.data);
  }

  const devDirect = import.meta.env.DEV && import.meta.env.VITE_DEV_DIRECT_PORTAL === 'true';
  if (devDirect) {
    const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
    if (baked) {
      return fetchAlternativesDirectFromPortal(baked);
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
  throw new Error(`Failed to load alternatives (${result.status})${detail}`);
}

const portalAlternativesQueryKey = ['portal', 'store-alternatives'] as const;

export function portalAlternativesQueryOptions() {
  return {
    queryKey: portalAlternativesQueryKey,
    queryFn: fetchPortalAlternatives,
    staleTime: 5 * 60 * 1000,
  } as const;
}
