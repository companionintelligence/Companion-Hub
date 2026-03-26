import type { AltAlternative, AltEntry, AltProprietary, AltsCategory } from '@/modules/onboarding/helpers/types';

/**
 * CI Portal base URL (no trailing slash).
 * Set `CI_CLOUD_URL` in CI-Hub `.env` or at Docker build time; Vite injects it as `import.meta.env.CI_CLOUD_URL`.
 */
export function getPortalBaseUrl(): string {
  const raw = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
  if (!raw) {
    throw new Error('CI_CLOUD_URL is not set. Add it to your CI-Hub environment (see .env.example) so the Hub can reach the portal.');
  }
  return raw.replace(/\/$/, '');
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
  const base = getPortalBaseUrl();
  const url = `${base}/api/store/alternatives`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Failed to load alternatives (${res.status})`);
  }
  const json: unknown = await res.json();
  return normalizeAlternativesPayload(json);
}

export const portalAlternativesQueryKey = ['portal', 'store-alternatives'] as const;

export function portalAlternativesQueryOptions() {
  return {
    queryKey: portalAlternativesQueryKey,
    queryFn: fetchPortalAlternatives,
    staleTime: 5 * 60 * 1000,
  } as const;
}
