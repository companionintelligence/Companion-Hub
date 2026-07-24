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
export function isSafeRedirect(url: string, location: { origin: string; host: string; protocol: string } = window.location): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, location.origin);
  } catch {
    return false;
  }

  if (parsed.origin === location.origin) {
    return true;
  }

  // The historical LAN shape: the Hub sits at the domain root and apps are subdomains beneath it.
  // The scheme must still match — the backend refuses to hand out a downgraded target, and this
  // is the same decision on the client side.
  return parsed.protocol === location.protocol && parsed.host.endsWith(`.${location.host}`);
}

/**
 * Navigate to `url` when it is a safe target, reporting whether it did. Callers use the return
 * value to decide whether to fall back to their own default destination.
 */
export function followSafeRedirect(url: string | null | undefined): boolean {
  if (!url || !isSafeRedirect(url)) {
    return false;
  }
  window.location.href = url;
  return true;
}
