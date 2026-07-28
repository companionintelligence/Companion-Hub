/**
 * Which 401s are allowed to sign the client out.
 *
 * Two transports reach the Hub API — the generated SDK client (via its response
 * interceptor in `root.tsx`) and the hand-rolled `apiFetch` helper — and each used to
 * keep its own copy of this list. One list, consulted by both, is what stops an
 * exemption from silently applying to one transport and not the other.
 */
const SESSION_EXPIRY_EXEMPT_PATHS = [
  // Auth ceremonies where a 401 IS the answer, not a signal that the session died.
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session/refresh',
  // A best-effort bridge on the way to an external open (`openExternalWithHubSession`),
  // documented as fail-open. Signing out here tears the page down mid-click — and
  // because `openExternal` first awaits a DNS pre-warm, that navigation also aborts the
  // pending open, leaving the user with neither the browser tab nor the flow. A session
  // that is genuinely gone still surfaces on the next polled request.
  '/api/auth/browser-handoff/mint',
];

/**
 * Reduce a request target to its pathname so the match can't be fooled by a query
 * string (`/api/apps?next=/api/auth/login`) and works for both the bare paths `apiFetch`
 * takes and the absolute URLs a `Response` carries.
 */
function toPathname(requestUrl: string): string {
  try {
    return new URL(requestUrl, 'http://hub.invalid').pathname;
  } catch {
    return requestUrl;
  }
}

/** True when a 401 for this request must NOT trigger the global session-expired logout. */
export function isSessionExpiryExempt(requestUrl: string): boolean {
  const pathname = toPathname(requestUrl);
  // Whole path segments only. A bare `startsWith` would also exempt a future
  // `/api/auth/login-attempts` or `/api/auth/logout-all`, silently swallowing the
  // sign-out for a route nobody meant to put on this list.
  return SESSION_EXPIRY_EXEMPT_PATHS.some((exempt) => pathname === exempt || pathname.startsWith(`${exempt}/`));
}
