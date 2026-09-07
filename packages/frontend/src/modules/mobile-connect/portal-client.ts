/**
 * Minimal client for the CI cloud control plane (the Portal) used by the
 * mobile Hub picker. Production is `hub.ci.computer`; the development Portal
 * is `hub.companionintelligence.com`. All requests go through the Tauri HTTP
 * plugin (`@tauri-apps/plugin-http`) rather than the webview `fetch`, so
 * cross-origin cookie/CORS limitations of a `tauri://localhost` origin don't apply.
 *
 * The Portal is better-auth + Hono on Cloudflare Workers. Email/password
 * yields a session (cookie / session token) for `GET /api/devices`. OIDC PKCE
 * yields an opaque access token that `/api/devices` rejects (401) — that
 * token is valid on `GET /api/users/me/apps?slug=hub` (`oauthBearerMiddleware`).
 */

const PRODUCTION_PORTAL_URL = 'https://hub.ci.computer';

function portalUrlFromEnv(): string {
  const baked = (import.meta.env.CI_CLOUD_URL as string | undefined)?.trim();
  if (baked) {
    const next = baked.replace(/\/+$/, '');
    // Internal/dev cloud host is not the user-facing Companion URL.
    if (next && !next.includes('companionintelligence.com')) return next;
  }
  return PRODUCTION_PORTAL_URL;
}

export const DEFAULT_PORTAL_URL = portalUrlFromEnv();

export interface PortalAuth {
  token: string | null;
  cookie: string | null;
  /** `oauth` = OIDC access token; `session` = email/password cookie/token. */
  kind?: 'session' | 'oauth';
}

export interface HubDevice {
  /** Device registration id (stable per appliance). */
  id: string;
  /** Human-friendly label for the list. */
  name: string;
  /** `active` | `pending` | `inactive`. */
  status: string;
  /** Fully-qualified appliance Hub URL, e.g. https://hub-cp-apple-acme.ci.computer */
  hubUrl: string | null;
  organizationId?: string;
}

async function nativeFetch(): Promise<typeof fetch> {
  try {
    const http = await import('@tauri-apps/plugin-http');
    if (typeof http.fetch === 'function') {
      return http.fetch as unknown as typeof fetch;
    }
  } catch {
    // ios:dev often has no Tauri HTTP IPC — fall through to window.fetch.
  }
  return globalThis.fetch.bind(globalThis);
}

function normalizePortalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PORTAL_URL;
}

const PORTAL_URL_STORAGE_KEY = 'ci-hub.portalUrl';
const PORTAL_AUTH_STORAGE_KEY = 'ci-hub.portalAuth';

/** Portal Hub URL for the next Safari OIDC hop. Independent of the chosen appliance. */
export function readPersistedPortalUrl(): string {
  try {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(PORTAL_URL_STORAGE_KEY);
    if (stored && !stored.includes('companionintelligence.com')) {
      return normalizePortalUrl(stored);
    }
    return DEFAULT_PORTAL_URL;
  } catch {
    return DEFAULT_PORTAL_URL;
  }
}

export function persistPortalUrl(url: string): string {
  const next = normalizePortalUrl(url);
  try {
    localStorage.setItem(PORTAL_URL_STORAGE_KEY, next);
  } catch {
    /* private mode / quota */
  }
  return next;
}

export function writePortalAuth(auth: PortalAuth): void {
  try {
    sessionStorage.setItem(PORTAL_AUTH_STORAGE_KEY, JSON.stringify(auth));
  } catch {
    /* ignore */
  }
}

export function readStoredPortalAuth(): PortalAuth | null {
  try {
    const raw = sessionStorage.getItem(PORTAL_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalAuth;
    if (!(parsed.token || parsed.cookie)) return null;
    return {
      token: parsed.token ?? null,
      cookie: parsed.cookie ?? null,
      kind: parsed.kind === 'oauth' ? 'oauth' : 'session',
    };
  } catch {
    return null;
  }
}

/** Keep just the better-auth session cookie pair from a Set-Cookie header. */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  // Set-Cookie may contain several cookies; grab the auth ones (prefix "ci").
  const pairs = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => (c.split(';')[0] ?? '').trim())
    .filter((c) => /session|token|^ci/i.test(c));
  return pairs.length ? pairs.join('; ') : null;
}

/** Authenticate to the Portal with email + password. Throws on failure. */
export async function signInToPortal(email: string, password: string, portalUrl = DEFAULT_PORTAL_URL): Promise<PortalAuth> {
  const portal = normalizePortalUrl(portalUrl);
  const doFetch = await nativeFetch();

  const res = await doFetch(`${portal}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    let message = `Sign-in failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }

  const cookie = extractSessionCookie(res.headers.get('set-cookie'));
  let token: string | null = null;
  try {
    const body = (await res.json()) as { token?: string; session?: { token?: string } };
    token = body?.token ?? body?.session?.token ?? null;
  } catch {
    /* token may only be in the cookie */
  }

  if (!token && !cookie) {
    throw new Error('Sign-in succeeded but no session was returned by the Portal.');
  }

  return { token, cookie, kind: 'session' };
}

/** Pull the Hub URL out of a device's app list (the privileged "hub" app). */
function hubUrlForDevice(device: { apps?: Array<{ slug?: string; name?: string; url?: string }> }): string | null {
  const apps = device.apps ?? [];
  const hub = apps.find((a) => a.slug === 'hub' || /hub/i.test(a.name ?? ''));
  return hub?.url ?? null;
}

async function listHubsWithOauthToken(auth: PortalAuth, portal: string, doFetch: typeof fetch): Promise<HubDevice[]> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  // Portal matches application.slug or application.name. The Hub appliance
  // is usually slug `hub`; try the first-party aliases if that is empty.
  const slugs = ['hub', 'ci-hub', 'OS Hub'];
  const seen = new Set<string>();
  const devices: HubDevice[] = [];

  for (const slug of slugs) {
    const res = await doFetch(`${portal}/api/users/me/apps?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Could not load your Hubs (${res.status}).`);
    }
    const body = (await res.json()) as {
      apps?: Array<{ slug?: string; url?: string; deviceName?: string; deviceSlug?: string }>;
    };
    for (const app of body.apps ?? []) {
      const key = app.url || app.deviceSlug || app.deviceName;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      devices.push({
        id: app.deviceSlug || app.url || key,
        name: app.deviceName || app.deviceSlug || key,
        status: 'active',
        hubUrl: app.url ?? null,
      });
    }
    if (devices.length > 0) break;
  }

  return devices;
}

/** List the Hub appliances the authenticated user owns. */
export async function listHubDevices(auth: PortalAuth, portalUrl = DEFAULT_PORTAL_URL): Promise<HubDevice[]> {
  const portal = normalizePortalUrl(portalUrl);
  const doFetch = await nativeFetch();

  if (auth.kind === 'oauth') {
    return listHubsWithOauthToken(auth, portal, doFetch);
  }

  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.Cookie = auth.cookie;

  const res = await doFetch(`${portal}/api/devices`, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`Could not load your Hubs (${res.status}).`);
  }

  const body = (await res.json()) as {
    devices?: Array<{
      id: string;
      name?: string;
      displayName?: string;
      slug?: string;
      status?: string;
      organizationId?: string;
      apps?: Array<{ slug?: string; name?: string; url?: string }>;
    }>;
  };

  return (body.devices ?? []).map((d) => ({
    id: d.id,
    name: d.displayName || d.name || d.slug || d.id,
    status: d.status ?? 'unknown',
    hubUrl: hubUrlForDevice(d),
    organizationId: d.organizationId,
  }));
}
