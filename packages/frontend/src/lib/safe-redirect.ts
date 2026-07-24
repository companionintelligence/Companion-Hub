/**
 * Post-login redirect targets: where the browser may be sent after authenticating.
 *
 * Lives in `lib/` beside the other auth/session helpers rather than in the login route module —
 * it is load-bearing open-redirect protection, and a second consumer importing it from a route
 * module would drag that route's whole bundle along, which is how such a check ends up
 * copy-pasted and drifting.
 *
 * The target is RESOLVED against the current origin and then judged by the resulting origin,
 * instead of pattern-matching the raw string. Prefix tests do not survive contact with WHATWG URL
 * parsing: `/\evil.com` starts with `/` and not `//`, yet parses to `https://evil.com/` (browsers
 * treat `\` as `/`), so a `startsWith` guard hands an attacker a post-login open redirect. Letting
 * the parser resolve first means anything that escapes the origin is judged as what it actually
 * is.
 */
export function resolveSafeRedirect(url: string, location: { origin: string; host: string; protocol: string } = window.location): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, location.origin);
  } catch {
    return null;
  }

  const safe =
    parsed.origin === location.origin ||
    // The historical LAN shape: the Hub sits at the domain root and apps are subdomains beneath
    // it. The scheme must still match — the backend refuses to hand out a downgraded target, and
    // this is the same decision on the client side.
    (parsed.protocol === location.protocol && parsed.host.endsWith(`.${location.host}`));

  return safe ? parsed.toString() : null;
}

/** Whether `url` is a target the browser may be sent to after authenticating. */
export function isSafeRedirect(url: string, location: { origin: string; host: string; protocol: string } = window.location): boolean {
  return resolveSafeRedirect(url, location) !== null;
}

/**
 * Navigate to `url` when it is a safe target, reporting whether it did. Callers use the return
 * value to decide whether to fall back to their own default destination.
 *
 * Navigates to the RESOLVED url, not the raw string, so the address judged safe is the address
 * the browser actually goes to. Assigning the raw value re-resolves it against the current PATH
 * rather than the origin, so a path-relative `home` validated as `/home` would land on
 * `/apps/foo/home` when the login page is nested. Same-origin either way — but "checked one URL,
 * navigated to another" is exactly the gap this module exists to close.
 */
export function followSafeRedirect(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }
  const target = resolveSafeRedirect(url);
  if (!target) {
    return false;
  }
  window.location.href = target;
  return true;
}
