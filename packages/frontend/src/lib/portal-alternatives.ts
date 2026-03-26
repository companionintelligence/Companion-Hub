import type { AltAlternative, AltEntry, AltProprietary, AltsCategory } from '@/modules/onboarding/helpers/types';

/**
 * Portal base URL (no trailing slash).
 * 1) `import.meta.env.CI_CLOUD_URL` from Vite (process env + `.env.*` at build / dev server start).
 * 2) Same-origin `GET /api/registration/device-id` → `ci_cloud_url` (runtime Hub config), so Docker images
 *    still work if the bundle was built without `CI_CLOUD_URL` baked in.
 */
async function resolvePortalBaseUrl(): Promise<string> {
  const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
  if (baked) return baked.replace(/\/$/, '');

  const res = await fetch('/api/registration/device-id', { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(
      `Could not resolve portal URL (GET /api/registration/device-id → ${res.status}). Set CI_CLOUD_URL in the Hub environment (e.g. .env.dev) and restart.`,
    );
  }
  const data = (await res.json()) as { ci_cloud_url?: string | null };
  const fromApi = data.ci_cloud_url?.trim();
  if (!fromApi) {
    throw new Error('CI_CLOUD_URL is not set on the Hub server. Add it to your env file (see .env.example) and restart the Hub.');
  }
  return fromApi.replace(/\/$/, '');
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
  const base = await resolvePortalBaseUrl();
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
