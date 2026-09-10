import type { Request } from 'express';
import axios from 'axios';
import {
  buildPortalAxiosConfig,
  readPortalInternalUrlOverride,
  resolveOutboundPortalBaseUrl,
  withPortalAxiosHeaders,
} from '@/common/helpers/portal-url';

export interface PortalSsoState {
  codeVerifier: string;
  redirectUrl: string | null;
  hubOrigin: string;
  desktop: boolean;
  /**
   * Which desktop build started this flow, carried across the browser round trip
   * so the callback can pick the right return scheme. Optional because states
   * issued before this field existed are still in flight; absent reads as
   * 'packaged', which is the safe default (see resolvePortalDesktopDeepLinkScheme).
   */
  desktopChannel?: DesktopChannel;
}

export interface PortalDesktopExchange {
  sessionId: string;
  redirectPath: string;
  userId?: number;
}

export function resolveSameOriginRedirectUrl(redirectUrl: string | null | undefined, hubOrigin: string): string | null {
  if (!redirectUrl) {
    return null;
  }

  try {
    const candidate = new URL(redirectUrl);
    const origin = new URL(hubOrigin);
    if (candidate.origin !== origin.origin) {
      return null;
    }
    return candidate.toString();
  } catch {
    return null;
  }
}

export function toDesktopRedirectPath(redirectUrl: string | null | undefined, hubOrigin: string): string {
  const safeRedirect = resolveSameOriginRedirectUrl(redirectUrl, hubOrigin);

  if (!safeRedirect) {
    return '/home';
  }

  const candidate = new URL(safeRedirect);
  return `${candidate.pathname}${candidate.search}${candidate.hash}` || '/home';
}

export type PortalSsoErrorCode =
  | 'callback_error'
  | 'state_expired'
  | 'account_mismatch'
  | 'not_configured'
  | 'not_org_member'
  | 'org_check_unavailable';

/** True when Hub OIDC was initiated from a local loopback origin (stack-dev / local desktop). */
export function isLoopbackHubOrigin(hubOrigin: string): boolean {
  try {
    const parsed = new URL(hubOrigin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export const PORTAL_DESKTOP_PRESENCE_CACHE_KEY = 'portal_sso_desktop_present';
export const PORTAL_DESKTOP_PRESENCE_TTL_SECONDS = 10 * 60;

/** The local Tauri window is alive — loopback browser SSO should hand off into it. */
export function shouldHandoffPortalLoginToDesktop(input: { desktop: boolean; hubOrigin: string; desktopAppPresent: boolean }): boolean {
  if (input.desktop) {
    return true;
  }
  return isLoopbackHubOrigin(input.hubOrigin) && input.desktopAppPresent;
}

/**
 * Which URL scheme the browser should hand the session back on.
 *
 * THE CLIENT DECLARES THIS. It used to be inferred as "loopback origin ⇒ dev
 * build", which is false in the one case that matters: the PACKAGED desktop app
 * also serves its UI from http://127.0.0.1:<apiPort> (desktop/src-tauri main.rs
 * get_hub_api_url_command, reached via bootstrap.js). So every production sign-in
 * was classified as dev and handed back `cihub-dev://auth?token=…`.
 *
 * cihub-dev is the scheme the DEV shell claims exclusively (scripts/launch-tauri-
 * desktop.ts publishes identifier computer.ci.app.hub.dev declaring only that
 * scheme) and that no installer registers — distribution/chocolatey registers
 * only `cihub`. So the return link either had no OS handler at all, or on a
 * machine with a dev build present was routed to the wrong binary.
 *
 * Defaulting to `cihub` is the safe direction: the packaged app declares BOTH
 * schemes (tauri.conf.json), so a dev shell that fails to pass the flag still
 * gets a link its own binary can handle.
 */
export function resolvePortalDesktopDeepLinkScheme(channel?: DesktopChannel | null): 'cihub' | 'cihub-dev' {
  return channel === 'dev' ? 'cihub-dev' : 'cihub';
}

/** Which desktop build asked for the handoff. Sent by the client, never inferred. */
export type DesktopChannel = 'dev' | 'packaged';

export function parseDesktopChannel(raw?: string | null): DesktopChannel {
  return raw === 'dev' ? 'dev' : 'packaged';
}

export function buildPortalDesktopDeepLink(token: string, channel?: DesktopChannel | null): string {
  const url = new URL(`${resolvePortalDesktopDeepLinkScheme(channel)}://auth`);
  url.searchParams.set('token', token);
  return url.toString();
}

export function buildPortalDesktopErrorDeepLink(errorCode: PortalSsoErrorCode, channel?: DesktopChannel | null): string {
  const url = new URL(`${resolvePortalDesktopDeepLinkScheme(channel)}://auth`);
  url.searchParams.set('error', errorCode);
  return url.toString();
}

export function resolveRequestOriginFallback(req: Request): string {
  try {
    return resolveHubRequestOrigin(req);
  } catch {
    return `${req.protocol}://${req.get('host') ?? 'localhost:5002'}`;
  }
}

export function buildPortalSsoErrorRedirectUrl(input: {
  hubOrigin?: string | null;
  desktop?: boolean;
  desktopChannel?: DesktopChannel | null;
  errorCode: PortalSsoErrorCode;
  fallbackOrigin: string;
}): string {
  if (input.desktop) {
    // The channel, not the origin — see resolvePortalDesktopDeepLinkScheme. An
    // error handed back on an unregistered scheme is as lost as a session is.
    return buildPortalDesktopErrorDeepLink(input.errorCode, input.desktopChannel);
  }

  const base = input.hubOrigin || input.fallbackOrigin;
  const url = new URL('/login', base);
  url.searchParams.set('portal_error', input.errorCode);
  return url.toString();
}

export function resolveHubRequestOrigin(req: Request): string {
  // First hop only, same as `resolveTrustedReturnOrigin` below: a REPEATED forwarded header reaches
  // Node as ONE comma-joined string (only `set-cookie` stays an array), so a request through a
  // second proxy yields `https, http://app.ci.lan, edge.example` — not a URL. Every caller feeds
  // this origin straight into `new URL()`, where that throws and surfaces as a 500.
  const proto = ((req.headers['x-forwarded-proto'] as string | undefined) || req.protocol || 'http').split(',')[0]?.trim() || 'http';
  const host = ((req.headers['x-forwarded-host'] as string | undefined) || req.get('host') || '').split(',')[0]?.trim();

  if (!host) {
    throw new Error('Missing host header');
  }

  return `${proto}://${host}`;
}

function isTrustedReturnHostname(hostname: string, trustedDomains: { domain?: string | null; localDomain?: string | null }): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  for (const candidate of [trustedDomains.domain, trustedDomains.localDomain]) {
    const domain = candidate?.trim().toLowerCase();
    if (domain && (hostname === domain || hostname.endsWith(`.${domain}`))) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a return origin to forward to Portal (e.g. for password-reset email links)
 * ONLY when the request host matches a trusted domain (configured DOMAIN / LOCAL_DOMAIN
 * or localhost). This prevents host-header injection where a forged Host /
 * X-Forwarded-Host could poison the reset link target (phishing / token theft).
 * Returns `undefined` for untrusted hosts so Portal falls back to its own default origin.
 */
export function resolveTrustedReturnOrigin(
  req: Request,
  trustedDomains: { domain?: string | null; localDomain?: string | null },
): string | undefined {
  const proto = ((req.headers['x-forwarded-proto'] as string | undefined) || req.protocol || 'http').split(',')[0]?.trim() || 'http';
  const rawHost = ((req.headers['x-forwarded-host'] as string | undefined) || req.get('host') || '').split(',')[0]?.trim();

  if (!rawHost) {
    return undefined;
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${rawHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (!isTrustedReturnHostname(hostname, trustedDomains)) {
    return undefined;
  }

  return `${proto}://${rawHost}`;
}

export function resolvePortalCallbackUrl(hubOrigin: string): string {
  return new URL('/api/auth/portal/callback', hubOrigin).toString();
}

/**
 * Portal / a proxy sometimes drops `/api/auth/portal/callback` and lands on Hub `/`
 * with the OAuth query still attached. Bounce those document requests onto the
 * real SSO routes so the browser does not sit on a Nest JSON 500.
 */
export function resolvePortalRootBounce(query: { code?: unknown; state?: unknown; desktop?: unknown }): string | null {
  const code = typeof query.code === 'string' ? query.code.trim() : '';
  const state = typeof query.state === 'string' ? query.state.trim() : '';
  if (code && state) {
    const url = new URL('/api/auth/portal/callback', 'http://hub.local');
    url.searchParams.set('code', code);
    url.searchParams.set('state', state);
    return `${url.pathname}${url.search}`;
  }
  if (query.desktop === '1' || query.desktop === 'true') {
    return '/api/auth/portal/start?desktop=1';
  }
  return null;
}

/**
 * HTML interstitial — some browsers will not follow a 302 to cihub-dev://.
 *
 * THE CONTENT COMES BEFORE THE SCRIPT, and that is the whole point.
 *
 * It used to be `<script>location.replace(...)</script>` first and the text
 * after. Navigating to an external scheme aborts the parse, so the paragraph and
 * its fallback link were never reached: the tab the user is left looking at is
 * blank white, with no title, no explanation, and — when the OS does not pick up
 * the deep link — no way forward at all. The fallback link only helps if it
 * renders, and a manual click carries the user gesture that some browsers want
 * before launching an app anyway.
 *
 * Still ONE automatic navigation. A meta refresh alongside `location.replace`
 * fires twice and hands the app the one-time token twice (first succeeds, second
 * 400s), so the manual link stays the only other route.
 *
 * Self-contained by necessity: this is served by the API before any session
 * exists, and on a Hub with no frontend bundle mounted there is nothing at
 * `/assets` to link to. No external CSS, fonts or images.
 */
export function buildPortalDesktopHandoffHtml(deepLink: string): string {
  const safeHref = deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // `<` cannot end the inline script early. The link is server-generated, so this
  // is belt-and-braces rather than a live hole.
  const scriptLiteral = JSON.stringify(deepLink).replace(/</g, '\\u003c');

  // Palette matches @companionintelligence/tokens (phthalo-mist), so the tab the
  // browser opens looks like the app it is handing back to.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing you in — Companion Hub</title>
<meta name="color-scheme" content="dark light">
<style>
:root {
  color-scheme: dark light;
  --bg: #041620;
  --card: #0c323c;
  --fg: #e8f2f4;
  --muted: #a3babf;
  --border: #073038;
  --accent: #c5e8dc;
  --accent-fg: #041620;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f3faf7;
    --card: #f0f9f5;
    --fg: #0a222e;
    --muted: #3a524b;
    --border: #dfece6;
    --accent: #0a6358;
    --accent-fg: #f0fdf4;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto 20px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 900ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
p { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
.btn {
  display: block;
  padding: 10px 16px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.hint { margin: 16px 0 0; font-size: 12px; }
</style>
</head>
<body>
<main class="card">
<div class="spinner" aria-hidden="true"></div>
<h1>Opening Companion Hub</h1>
<p>You are signed in. Handing you back to the app…</p>
<a class="btn" href="${safeHref}">Open Companion Hub</a>
<p class="hint">If nothing happens, your browser may have blocked the app link — use the button above. You can close this tab once the Hub is open.</p>
</main>
<script>location.replace(${scriptLiteral})</script>
</body>
</html>`;
}

export interface PortalTokenExchangeResult {
  ok: true;
  accessToken: string;
  email: string;
  emailVerified: boolean;
  subject: string | null;
  issuer: string;
}

export interface PortalTokenExchangeFailure {
  ok: false;
  reason: 'token_exchange_failed' | 'missing_access_token' | 'userinfo_failed' | 'missing_email' | 'email_unverified' | 'network_error';
  status?: number;
}

export type PortalOAuthExchangeResult = PortalTokenExchangeResult | PortalTokenExchangeFailure;

export async function fetchPortalSessionEmail(input: { publicPortalBaseUrl: string; cookieHeader?: string }): Promise<string | null> {
  const internalOverride = readPortalInternalUrlOverride();
  const portalBaseUrl = resolveOutboundPortalBaseUrl(input.publicPortalBaseUrl, internalOverride);
  const axiosConfig = buildPortalAxiosConfig(input.publicPortalBaseUrl, internalOverride);
  const sessionUrl = new URL('/api/auth/get-session', portalBaseUrl).toString();

  try {
    const res = await axios.get(sessionUrl, {
      ...withPortalAxiosHeaders(axiosConfig, input.cookieHeader ? { cookie: input.cookieHeader } : {}),
      validateStatus: () => true,
      timeout: 5_000,
    });

    if (res.status < 200 || res.status >= 300) {
      return null;
    }

    const email = (res.data as { user?: { email?: string } } | undefined)?.user?.email;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

export async function exchangePortalAuthorizationCode(input: {
  publicPortalBaseUrl: string;
  callbackUrl: string;
  code: string;
  codeVerifier: string;
}): Promise<PortalOAuthExchangeResult> {
  const internalOverride = readPortalInternalUrlOverride();
  const portalBaseUrl = resolveOutboundPortalBaseUrl(input.publicPortalBaseUrl, internalOverride);
  const axiosConfig = buildPortalAxiosConfig(input.publicPortalBaseUrl, internalOverride);

  const tokenUrl = new URL('/api/auth/oauth2/token', portalBaseUrl).toString();
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', 'ci-hub');
  body.set('redirect_uri', input.callbackUrl);
  body.set('code', input.code);
  body.set('code_verifier', input.codeVerifier);

  let tokenRes: { status: number; data: unknown };

  try {
    tokenRes = await axios.post(tokenUrl, body.toString(), {
      ...withPortalAxiosHeaders(axiosConfig, { 'content-type': 'application/x-www-form-urlencoded' }),
      validateStatus: () => true,
      timeout: 15_000,
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  if (tokenRes.status < 200 || tokenRes.status >= 300) {
    return { ok: false, reason: 'token_exchange_failed', status: tokenRes.status };
  }

  const tokenPayload = tokenRes.data as { access_token?: string; id_token?: string } | undefined;
  const accessToken = tokenPayload?.access_token;
  if (!accessToken) {
    return { ok: false, reason: 'missing_access_token', status: tokenRes.status };
  }

  const userinfoUrl = new URL('/api/auth/oauth2/userinfo', portalBaseUrl).toString();
  let userinfoRes: { status: number; data: unknown };

  try {
    userinfoRes = await axios.get(userinfoUrl, {
      ...withPortalAxiosHeaders(axiosConfig, { authorization: `Bearer ${accessToken}` }),
      validateStatus: () => true,
      timeout: 15_000,
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  if (userinfoRes.status < 200 || userinfoRes.status >= 300) {
    return { ok: false, reason: 'userinfo_failed', status: userinfoRes.status };
  }

  const claims = userinfoRes.data as { sub?: string; iss?: string; email?: string; email_verified?: boolean } | undefined;
  const email = claims?.email;
  if (!email) {
    return { ok: false, reason: 'missing_email', status: userinfoRes.status };
  }

  // The Hub decides who its operator is by comparing this address, so an unverified one would let
  // anybody claim a Hub by typing its operator's address into a signup form. The Portal issues the
  // claim whenever the `email` scope is requested, and this flow always requests it.
  if (claims?.email_verified !== true) {
    return { ok: false, reason: 'email_unverified', status: userinfoRes.status };
  }

  const idTokenClaims = decodeJwtPayload(tokenPayload?.id_token);
  const subject =
    (typeof claims?.sub === 'string' && claims.sub.trim()) || (typeof idTokenClaims?.sub === 'string' && idTokenClaims.sub.trim()) || null;
  const issuer =
    (typeof claims?.iss === 'string' && claims.iss.trim()) ||
    (typeof idTokenClaims?.iss === 'string' && idTokenClaims.iss.trim()) ||
    input.publicPortalBaseUrl.replace(/\/+$/, '');

  return { ok: true, accessToken, email, emailVerified: true, subject, issuer };
}

function decodeJwtPayload(token?: string): { sub?: string; iss?: string } | null {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json) as { sub?: string; iss?: string };
  } catch {
    return null;
  }
}
