import type { Request } from 'express';
import axios from 'axios';
import { describeNetworkError } from '@/common/helpers/network-error';
import { internalOriginRefusal } from '@/common/helpers/request-origin';
import {
  buildPortalAxiosConfig,
  readPortalInternalUrlOverride,
  resolveOutboundPortalBaseUrl,
  withPortalAxiosHeaders,
} from '@/common/helpers/portal-url';
import { HUB_FAVICON_LINK_TAG } from './hub-favicon';

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

/**
 * Whether a request was sent straight to this Hub on a loopback address, the way the desktop app's
 * window reaches it (its UI is served from http://127.0.0.1:<apiPort>).
 *
 * The host name alone proves nothing: the tunnel passes a visitor's own X-Forwarded-Host through,
 * so a request from the internet can name `localhost`. `internalOriginRefusal` rules out anything
 * the tunnel or a public hop carried here.
 */
export function isDirectLoopbackRequest(req: Request): boolean {
  if (internalOriginRefusal(req) !== null) {
    return false;
  }

  try {
    return isLoopbackHubOrigin(resolveHubRequestOrigin(req));
  } catch {
    return false;
  }
}

/**
 * How long the desktop handoff token stays spendable.
 *
 * Short on purpose — it is a bearer credential sitting in a URL the OS hands
 * between processes. The handoff page counts on this number to know when to
 * stop waiting, so the two must not drift apart.
 */
export const PORTAL_DESKTOP_HANDOFF_TTL_SECONDS = 60;

/**
 * How long the "the app took it" marker outlives the token it replaces.
 *
 * Longer than the token, because it exists to answer a question after the fact:
 * a browser tab left open on the handoff page must still be able to learn that
 * the sign-in completed, minutes later, without the answer decaying into
 * "expired" and telling the user the opposite of what happened.
 */
export const PORTAL_DESKTOP_CLAIMED_TTL_SECONDS = 15 * 60;

/** Cache key holding an unspent one-time desktop handoff token. */
export function portalDesktopPendingKey(token: string): string {
  return `portal_sso_desktop:${token}`;
}

/** Cache key marking a handoff token the desktop app has spent. */
export function portalDesktopClaimedKey(token: string): string {
  return `portal_sso_desktop_done:${token}`;
}

/**
 * What the browser tab left behind should say.
 *
 * `'pending'` the app has not taken the login yet · `'claimed'` it has ·
 * `'expired'` the token died unspent.
 *
 * ⚠ CLAIMED IS CHECKED FIRST, and the exchange writes the marker BEFORE it
 * deletes the token. Deleting first would open a window — however short — in
 * which neither key exists, and a poll landing inside it would report `expired`
 * for a sign-in that had just succeeded. Order here and order there are one
 * decision; changing either alone reintroduces the race.
 */
export type PortalDesktopHandoffState = 'pending' | 'claimed' | 'expired';

export function resolvePortalDesktopHandoffState(input: { claimed: boolean; pending: boolean }): PortalDesktopHandoffState {
  if (input.claimed) {
    return 'claimed';
  }

  return input.pending ? 'pending' : 'expired';
}

export const PORTAL_DESKTOP_PRESENCE_CACHE_KEY = 'portal_sso_desktop_present';
export const PORTAL_DESKTOP_PRESENCE_TTL_SECONDS = 10 * 60;

/** The desktop app on this machine is waiting for a sign-in, so a loopback browser sign-in hands off into it. */
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
 * 400s), so the manual link stays the only other route. For the same reason the
 * poll below only ever rewrites text — it must never navigate.
 *
 * ⚠ THE POLL IS ARMED BEFORE THE NAVIGATION, not after. Handing the URL to the
 * OS ends the script's run, so anything scheduled after `location.replace` never
 * gets scheduled at all; a `setTimeout` registered before it survives, because
 * an external-scheme navigation leaves the document loaded.
 *
 * THE NAVIGATION WAITS ONE TASK. WebKit (Safari's engine) loads the tab icon
 * only once the page has finished loading, and with a navigation started while
 * the page was still parsing it never did: the tab stayed iconless even when the
 * browser handed the app scheme to the OS and kept the page. A zero-delay
 * timeout runs after the load completes; Chrome and Firefox open the app the same.
 *
 * `continueHref` is why this page is no longer a dead end. The session cookie is
 * already on this browser before this HTML is written — see the callback — so
 * carrying on here is a plain same-origin link, not a second sign-in, and it
 * costs the desktop app nothing: the one-time token is a separate value only the
 * app can spend.
 *
 * There is deliberately NO auto-close. A tab the OS opened cannot close itself
 * ("Scripts may close only the windows that were opened by them"), with or
 * without extra history entries, so a countdown promising to would simply lie.
 * The page says the tab can be closed and leaves that to the person.
 *
 * Self-contained by necessity: this is served by the API before any session
 * exists, and on a Hub with no frontend bundle mounted there is nothing at
 * `/assets` to link to. No external CSS, fonts or images; the one link is the
 * tab icon, which the API serves itself (see hub-favicon.ts).
 */
export function buildPortalDesktopHandoffHtml(input: {
  deepLink: string;
  /** Same-origin path to carry on in this browser — `toDesktopRedirectPath`. */
  continueHref: string;
  /** Same-origin path this page polls to learn whether the app took the login. */
  statusHref: string;
}): string {
  const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const safeHref = escapeAttr(input.deepLink);
  const safeContinue = escapeAttr(input.continueHref);
  // `<` cannot end the inline script early. These are server-generated, so this
  // is belt-and-braces rather than a live hole.
  const scriptLiteral = JSON.stringify(input.deepLink).replace(/</g, '\\u003c');
  const statusLiteral = JSON.stringify(input.statusHref).replace(/</g, '\\u003c');
  // Past the token's own lifetime, so the server gets to say `expired` itself
  // before the client gives up guessing. Only a backstop for a poll that cannot
  // reach the Hub at all.
  const giveUpAfterMs = (PORTAL_DESKTOP_HANDOFF_TTL_SECONDS + 15) * 1000;

  // Palette matches @companionintelligence/tokens (phthalo-mist), so the tab the
  // browser opens looks like the app it is handing back to.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing you in — Companion Hub</title>
${HUB_FAVICON_LINK_TAG}
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
/* .btn sets display:block, which would beat the hidden attribute's UA rule. */
[hidden] { display: none !important; }
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
.tick {
  width: 34px;
  height: 34px;
  margin: 0 auto 20px;
  color: var(--accent);
}
.tick svg { width: 100%; height: 100%; display: block; }
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
.btn.secondary {
  margin-top: 10px;
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
}
.hint { margin: 16px 0 0; font-size: 12px; }
</style>
</head>
<body>
<main class="card">
<div class="spinner" id="handoff-spinner" aria-hidden="true"></div>
<div class="tick" id="handoff-tick" hidden aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
<div aria-live="polite">
<h1 id="handoff-title">Opening Companion Hub</h1>
<p id="handoff-lede">You are signed in. Handing you back to the app…</p>
</div>
<a class="btn" id="handoff-open" href="${safeHref}">Open Companion Hub</a>
<a class="btn secondary" id="handoff-continue" href="${safeContinue}">Continue in this browser</a>
<p class="hint" id="handoff-hint">If nothing happens, your browser may have blocked the app link — use the button above. You can close this tab once the Hub is open.</p>
</main>
<script>
(function () {
  var statusHref = ${statusLiteral};
  var deadline = Date.now() + ${giveUpAfterMs};

  function el(id) { return document.getElementById(id); }

  function settle(state) {
    var claimed = state === 'claimed';
    var spinner = el('handoff-spinner');
    var tick = el('handoff-tick');
    var open = el('handoff-open');
    var hint = el('handoff-hint');

    if (spinner) { spinner.hidden = true; }
    if (tick) { tick.hidden = !claimed; }
    // The token is spent or dead either way, so the app link can only fail now.
    if (open) { open.hidden = true; }
    if (hint) { hint.hidden = true; }

    el('handoff-title').textContent = claimed
      ? 'Companion Hub is signed in'
      : "Companion Hub didn't open";
    el('handoff-lede').textContent = claimed
      ? 'You can close this tab.'
      : 'The app link went unused. You are still signed in here.';
  }

  function poll() {
    if (Date.now() > deadline) { settle('expired'); return; }

    fetch(statusHref, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var state = body && body.state;
        if (state === 'claimed' || state === 'expired') { settle(state); return; }
        setTimeout(poll, 1500);
      })
      .catch(function () { setTimeout(poll, 1500); });
  }

  setTimeout(poll, 1500);
  // A task later, not mid-parse: see "THE NAVIGATION WAITS ONE TASK" above.
  setTimeout(function () { location.replace(${scriptLiteral}); }, 0);
})();
</script>
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
  /** For `network_error`: why the request got no answer, such as `getaddrinfo ENOTFOUND <host>`. */
  detail?: string;
}

export type PortalOAuthExchangeResult = PortalTokenExchangeResult | PortalTokenExchangeFailure;

export async function probePortalReachable(publicPortalBaseUrl: string): Promise<boolean> {
  const internalOverride = readPortalInternalUrlOverride();
  const portalBaseUrl = resolveOutboundPortalBaseUrl(publicPortalBaseUrl, internalOverride);
  const axiosConfig = buildPortalAxiosConfig(publicPortalBaseUrl, internalOverride);
  const discoveryUrl = new URL('/api/auth/.well-known/openid-configuration', portalBaseUrl).toString();

  try {
    const res = await axios.get(discoveryUrl, {
      ...withPortalAxiosHeaders(axiosConfig, {}),
      validateStatus: () => true,
      timeout: 4_000,
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

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
  } catch (error) {
    return { ok: false, reason: 'network_error', detail: describeNetworkError(error) };
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
  } catch (error) {
    return { ok: false, reason: 'network_error', detail: describeNetworkError(error) };
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
