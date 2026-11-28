import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The credential a Hub session is presented with: `<session id>.<signature>`, sent in the
 * `X-CI-Hub-Session` header and nowhere a browser sends on its own.
 *
 * ⚠ THE BARE SESSION ID IS NOT A CREDENTIAL ANY MORE. The Hub used to accept it from a cookie, the
 * header or `?session_id=`, and a cookie reaches more than the Hub: browsers scope cookies by host,
 * not by port, so an app the operator opened at `<same host>:<its port>` received `ci-hub-sid` and
 * could replay it as a full operator session (2026-11-17 audit). The cookie, and anything copied from
 * it, now authenticates nothing. The signature needs a key derived from `JWT_SECRET`, which never
 * leaves the Hub, so an app holding the id cannot produce the token.
 *
 * The browser keeps the token in the Hub page's own storage, which is scoped to scheme, host AND
 * port, so a page on another port cannot read it either. Desktop and phone already sent the header.
 */

/** Separates the session id (a UUID, never containing it) from the signature. */
const SEPARATOR = '.';

/** Domain-separated from every other use of `JWT_SECRET` (CLI JWTs, queue signing). */
const KEY_LABEL = 'ci-hub/session-token/v1';

const keyCache = new Map<string, Buffer>();

function sessionTokenKey(jwtSecret: string): Buffer {
  let key = keyCache.get(jwtSecret);
  if (!key) {
    key = createHmac('sha256', jwtSecret).update(KEY_LABEL).digest();
    keyCache.clear();
    keyCache.set(jwtSecret, key);
  }
  return key;
}

function signatureFor(sessionId: string, jwtSecret: string): string {
  return createHmac('sha256', sessionTokenKey(jwtSecret)).update(sessionId).digest('base64url');
}

/** The token a client presents for `sessionId`. Throws without a secret: a token signed with nothing proves nothing. */
export function mintSessionToken(sessionId: string, jwtSecret: string | undefined): string {
  if (!jwtSecret) {
    throw new Error('Cannot mint a Hub session token without JWT_SECRET');
  }
  return `${sessionId}${SEPARATOR}${signatureFor(sessionId, jwtSecret)}`;
}

/** The session id a token names, or null when it is not a token this Hub signed (a bare id included). */
export function openSessionToken(token: unknown, jwtSecret: string | undefined): string | null {
  if (typeof token !== 'string' || !jwtSecret) {
    return null;
  }
  const at = token.lastIndexOf(SEPARATOR);
  if (at <= 0 || at === token.length - 1) {
    return null;
  }
  const sessionId = token.slice(0, at);
  const presented = Buffer.from(token.slice(at + 1));
  const expected = Buffer.from(signatureFor(sessionId, jwtSecret));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }
  return sessionId;
}

/**
 * The fragment key a redirect-based sign-in (Portal, browser handoff) hands the token to the Hub page
 * under. A fragment never reaches a server, and the page removes it on load (`root.tsx`).
 */
export const SESSION_TOKEN_FRAGMENT_KEY = 'ci_hub_session';

/**
 * The fragment key for the value that ties a hand-off to this browser, beside the token.
 *
 * A Hub page used to adopt any token it found in its fragment, so a link to a Hub page carrying
 * someone ELSE's token signed the visitor in as them, silently: whatever they then did or entered
 * went to that account. So every redirect that hands over a token also sets
 * {@link sessionHandoffCookie} in the same response, holding this value, and the page adopts the
 * token only when its fragment's value matches that cookie (frontend `session-fragment.ts`). A
 * planted link never passed through this browser's own redirect, so no cookie of the browser's
 * matches it. The redirects themselves only run for a sign-in this browser started (Portal's
 * binding cookie, the hand-off's same-origin confirmation), so they cannot be replayed to plant one.
 */
export const SESSION_HANDOFF_NONCE_KEY = 'ci_hub_nonce';

/** How long a hand-off cookie lasts: long enough to click "carry on in the browser" on the desktop hand-off page. */
export const SESSION_HANDOFF_COOKIE_TTL_SECONDS = 10 * 60;

/**
 * Name, Path and Secure of the hand-off cookie for a request that is (`secure`) or is not https.
 *
 * `__Host-` over https: the browser then refuses one set by any other host, so an app on a sibling
 * address (`<app>.<domain>` beside `hub.<domain>`) cannot plant a matching value with
 * `Domain=<domain>`. Readable by the page's script (not httpOnly): the page is what compares it.
 */
export function sessionHandoffCookie(secure: boolean): { name: string; path: string; secure: boolean } {
  return { name: secure ? '__Host-ci-hub-handoff' : 'ci-hub-handoff', path: '/', secure };
}

/** A fresh hand-off value: 144 random bits, URL-safe. */
export function mintSessionHandoffNonce(): string {
  return randomBytes(18).toString('base64url');
}

/** The Hub page that finishes an app sign-in (edge SSO) with the page's own token. */
export const EDGE_SSO_PAGE_PATH = '/sso';

/**
 * Hub API routes that answer a navigation by handing it straight to a Hub page on the same origin,
 * so a fragment carried through them still lands on the Hub page (`GET /edge-sso` → `/sso`,
 * `GET /memory-connect/start` → `/memory-connect/continue`).
 */
const BOUNCES_TO_A_HUB_PAGE = new Set(['/api/auth/edge-sso', '/api/memory-connect/start']);

/**
 * `url` (a path, or an absolute URL) as a URL on `hubOrigin` with the token in its fragment.
 *
 * ⚠ ONLY EVER A HUB PAGE. Whatever page the browser ends on can read its fragment, and a browser
 * carries a fragment across every redirect that names none of its own. So a URL on any other origin
 * (an app's host), or a target under `/api/` that redirects onward (Portal sign-in, an app), lands
 * on `/home` instead; only the routes that bounce to a Hub page ({@link BOUNCES_TO_A_HUB_PAGE}) are
 * kept. A caller with an app to reach sends the browser through {@link EDGE_SSO_PAGE_PATH}.
 */
export function withSessionTokenFragment(url: string, token: string, hubOrigin: string, nonce: string): string {
  const hub = new URL(hubOrigin);
  let target: URL;
  try {
    target = new URL(url, hub);
  } catch {
    target = new URL('/home', hub);
  }
  const isApi = target.pathname === '/api' || target.pathname.startsWith('/api/');
  if (target.origin !== hub.origin || (isApi && !BOUNCES_TO_A_HUB_PAGE.has(target.pathname))) {
    target = new URL('/home', hub);
  }
  target.hash = `${SESSION_TOKEN_FRAGMENT_KEY}=${encodeURIComponent(token)}&${SESSION_HANDOFF_NONCE_KEY}=${encodeURIComponent(nonce)}`;
  return target.toString();
}
