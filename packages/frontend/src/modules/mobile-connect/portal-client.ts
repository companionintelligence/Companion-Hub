/**
 * Minimal client for the CI cloud control plane (the Portal) used by the
 * mobile Hub picker. Cloud connect always starts on production (`hub.ci.computer`).
 * `CI_CLOUD_URL` / `CI_HUB_ENVIRONMENT` belong to the Hub appliance, not the
 * phone — a `cihub up dev` frontend must not silently aim TestFlight / Play /
 * Simulator Sign in at the internal Portal. Advanced can override the Companion
 * URL, to that internal host too. Only a `hub.companionintelligence.com` left
 * behind by an older build is ignored, so old installs migrate to production.
 *
 * All requests go through the Tauri HTTP plugin (`@tauri-apps/plugin-http`)
 * rather than the webview `fetch`, so cross-origin cookie/CORS limitations of a
 * `tauri://localhost` origin don't apply.
 *
 * The Portal is better-auth + Hono on Cloudflare Workers. OIDC PKCE yields an
 * opaque access token that `GET /api/devices` rejects (401) — that token is
 * valid on `GET /api/users/me/apps?slug=hub` (`oauthBearerMiddleware`). The
 * app no longer signs in with email/password itself; `kind: 'session'` is what
 * that path produced, and `/api/devices` is where it listed Hubs.
 */

/** Phone cloud-connect Companion URL. Not derived from Hub appliance env. */
export const DEFAULT_PORTAL_URL = 'https://hub.ci.computer';

export interface PortalAuth {
  token: string | null;
  cookie: string | null;
  /**
   * `oauth` = OIDC access token; `session` = email/password cookie/token; `code` = a finished cloud-connect
   * sign-in whose code is not spent yet ({@link signInCode}).
   */
  kind?: 'session' | 'oauth' | 'code';
  /**
   * The cloud-connect sign-in's code and PKCE verifier, kept unspent until a Hub is picked: the Hubs are
   * listed with it (`POST /api/users/me/apps/by-code`), then it is exchanged once with that Hub's
   * `resource`, so Portal addresses the id_token to that Hub and no other Hub can spend it.
   */
  signInCode?: { code: string; verifier: string } | null;
  /**
   * Portal id_token from cloud connect. The Hub the person picks can turn this
   * into a local session, so they are not asked to sign in a second time.
   */
  idToken?: string | null;
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
  /** What Portal addresses an id_token to this Hub with (`urn:ci:device:<id>`), as it lists the Hub. */
  resource?: string | null;
  organizationId?: string;
  /** Optional LAN IP address advertised by device or local network discovery. */
  lanIp?: string | null;
  /** Optional direct LAN base URL (e.g. http://192.168.1.50:5002). */
  lanUrl?: string | null;
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

/**
 * Written by builds that saved whatever the Advanced form held, the internal
 * host included, so a stored internal host here is a leftover, not a choice.
 */
const LEGACY_PORTAL_URL_STORAGE_KEY = 'ci-hub.portalUrl';
/** Only ever written by an explicit Save URL, so whatever it holds is honoured, internal host or not. */
const PORTAL_URL_STORAGE_KEY = 'ci-hub.portalUrl.v2';
const PORTAL_AUTH_STORAGE_KEY = 'ci-hub.portalAuth';

/** Portal Hub URL for the next browser OIDC hop. Independent of the chosen appliance. */
export function readPersistedPortalUrl(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PORTAL_URL;

    const chosen = localStorage.getItem(PORTAL_URL_STORAGE_KEY);
    if (chosen) return normalizePortalUrl(chosen);

    const legacy = localStorage.getItem(LEGACY_PORTAL_URL_STORAGE_KEY);
    if (legacy && !legacy.toLowerCase().includes('companionintelligence.com')) {
      return normalizePortalUrl(legacy);
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
    localStorage.removeItem(LEGACY_PORTAL_URL_STORAGE_KEY);
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

/** Forget the Portal sign-in. The next visit to `/connect` starts at Log in. */
export function clearPortalAuth(): void {
  try {
    sessionStorage.removeItem(PORTAL_AUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function readStoredPortalAuth(): PortalAuth | null {
  try {
    const raw = sessionStorage.getItem(PORTAL_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalAuth;
    const signInCode = parsed.signInCode;
    if (
      parsed.kind === 'code' &&
      typeof signInCode?.code === 'string' &&
      typeof signInCode.verifier === 'string' &&
      signInCode.code &&
      signInCode.verifier
    ) {
      return { token: null, cookie: null, kind: 'code', signInCode: { code: signInCode.code, verifier: signInCode.verifier } };
    }
    if (!(parsed.token || parsed.cookie)) return null;
    const idToken = typeof parsed.idToken === 'string' && parsed.idToken.trim() ? parsed.idToken : null;
    return {
      token: parsed.token ?? null,
      cookie: parsed.cookie ?? null,
      kind: parsed.kind === 'oauth' ? 'oauth' : 'session',
      ...(idToken ? { idToken } : {}),
    };
  } catch {
    return null;
  }
}

/** Pull the Hub URL out of a device's app list (the privileged "hub" app). */
function hubUrlForDevice(device: { apps?: Array<{ slug?: string; name?: string; url?: string }> }): string | null {
  const apps = device.apps ?? [];
  const hub = apps.find((a) => a.slug === 'hub' || /hub/i.test(a.name ?? ''));
  return hub?.url ?? null;
}

/**
 * The person's Hubs from Portal's app list, asked once per name Portal may list the Hub under. `ask`
 * fetches one slug's list: with an access token (`GET /me/apps`) or with the unspent sign-in code
 * (`POST /me/apps/by-code`, paired Hubs only).
 */
async function listHubsFromApps(ask: (slug: string) => Promise<Response>): Promise<HubDevice[]> {
  // Portal matches application.slug or application.name. The Hub appliance
  // is usually slug `hub`; try the first-party aliases if that is empty.
  const slugs = ['hub', 'ci-hub', 'OS Hub'];
  const seen = new Set<string>();
  const devices: HubDevice[] = [];

  for (const slug of slugs) {
    const res = await ask(slug);
    if (!res.ok) {
      throw new Error(`Could not load your Hubs (${res.status}).`);
    }
    const body = (await res.json()) as {
      apps?: Array<{ slug?: string; url?: string; deviceName?: string; deviceSlug?: string; resource?: string }>;
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
        resource: typeof app.resource === 'string' && app.resource.startsWith('urn:ci:device:') ? app.resource : null,
      });
    }
    if (devices.length > 0) break;
  }

  return devices;
}

async function listHubsWithOauthToken(auth: PortalAuth, portal: string, doFetch: typeof fetch): Promise<HubDevice[]> {
  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  return listHubsFromApps((slug) =>
    doFetch(`${portal}/api/users/me/apps?slug=${encodeURIComponent(slug)}`, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) }),
  );
}

/** The Hubs listed with the unspent sign-in code: it stays unspent, for the Hub the person picks. */
async function listHubsWithSignInCode(signInCode: { code: string; verifier: string }, portal: string, doFetch: typeof fetch): Promise<HubDevice[]> {
  return listHubsFromApps((slug) =>
    doFetch(`${portal}/api/users/me/apps/by-code?slug=${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code: signInCode.code, code_verifier: signInCode.verifier }),
      signal: AbortSignal.timeout(15_000),
    }),
  );
}

/** List the Hub appliances the authenticated user owns. */
export async function listHubDevices(auth: PortalAuth, portalUrl = DEFAULT_PORTAL_URL): Promise<HubDevice[]> {
  const portal = normalizePortalUrl(portalUrl);
  const doFetch = await nativeFetch();

  if (auth.kind === 'code' && auth.signInCode) {
    return listHubsWithSignInCode(auth.signInCode, portal, doFetch);
  }
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

/**
 * Spend the cloud-connect id_token on the Hub the person just picked.
 * Null means this Hub cannot take it (older build, unverified email, network),
 * and the caller should fall back to the Hub's own sign-in sheet.
 */
export async function establishHubSessionFromPortal(
  hubBaseUrl: string,
  idToken: string,
): Promise<{ sessionId: string; redirectPath: string } | null> {
  const base = hubBaseUrl.trim().replace(/\/+$/, '');
  if (!base || !idToken) return null;
  const doFetch = await nativeFetch();
  let res: Response;
  try {
    res = await doFetch(`${base}/api/auth/portal/mobile-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json()) as { sessionId?: unknown; redirectPath?: unknown };
  if (typeof data.sessionId !== 'string' || !data.sessionId) return null;
  return {
    sessionId: data.sessionId,
    redirectPath: typeof data.redirectPath === 'string' && data.redirectPath.startsWith('/') ? data.redirectPath : '/home',
  };
}
