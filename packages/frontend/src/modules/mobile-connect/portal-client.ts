/**
 * Minimal client for the CI cloud control plane (the Portal, `hub.ci.computer`)
 * used by the mobile Hub picker. All requests go through the Tauri HTTP plugin
 * (`@tauri-apps/plugin-http`) rather than the webview `fetch`, so cross-origin
 * cookie/CORS limitations of a `tauri://localhost` origin don't apply.
 *
 * The Portal is better-auth + Hono on Cloudflare Workers. We support the
 * universal email/password path here; OAuth/passkey via the system browser is a
 * natural follow-up. Auth is presented to `/api/devices` as both a bearer token
 * and a cookie (whichever the deployment honours).
 */

export const DEFAULT_PORTAL_URL = 'https://hub.ci.computer';

export interface PortalAuth {
  token: string | null;
  cookie: string | null;
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
  const http = await import('@tauri-apps/plugin-http');
  return http.fetch as unknown as typeof fetch;
}

function normalizePortalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PORTAL_URL;
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

  return { token, cookie };
}

/** Pull the Hub URL out of a device's app list (the privileged "hub" app). */
function hubUrlForDevice(device: { apps?: Array<{ slug?: string; name?: string; url?: string }> }): string | null {
  const apps = device.apps ?? [];
  const hub = apps.find((a) => a.slug === 'hub' || /hub/i.test(a.name ?? ''));
  return hub?.url ?? null;
}

/** List the Hub appliances the authenticated user owns. */
export async function listHubDevices(auth: PortalAuth, portalUrl = DEFAULT_PORTAL_URL): Promise<HubDevice[]> {
  const portal = normalizePortalUrl(portalUrl);
  const doFetch = await nativeFetch();

  const headers: Record<string, string> = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.Cookie = auth.cookie;

  const res = await doFetch(`${portal}/api/devices`, { method: 'GET', headers });
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
