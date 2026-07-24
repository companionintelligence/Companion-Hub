/**
 * Forwarded-host normalization, shared by `ForwardAuthSecretResolver` (host→app map keys) and
 * `AuthController` (edge-SSO ticket host binding). These two MUST agree: the consume side accepts
 * a ticket by comparing its bound host against the normalized forwarded host, and the resolver
 * looks the same value up in its map. When each owned a private copy, the agreement rested on a
 * comment — and any divergence would make every ticket silently fail its binding and loop the
 * visitor back to login with no error signal.
 */

/** The forwarded host as the client sent it (port and case preserved), taking the first value if
 *  the header was repeated. Use when rebuilding a URL the browser has to land back on. */
export function rawForwardedHost(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Lowercased, port-stripped host — the canonical key form.
 *
 * IPv6 is handled explicitly rather than by a bare `/:\d+$/`: that regex reads the tail of
 * `2001:db8::1` as a port and truncates it to `2001:db8:`, which would flow onward as a garbage
 * map key and quietly break the "a normalized host contains no colon" assumption that callers
 * embedding it in `:`-delimited cache keys rely on.
 */
export function normalizeForwardedHost(value: string | string[] | undefined): string {
  const host = rawForwardedHost(value).toLowerCase();
  if (!host) {
    return '';
  }
  // Bracketed literal: `[::1]:8080` → `[::1]`.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  // A bare IPv6 literal carries several colons and no port suffix — leave it intact.
  if ((host.match(/:/g)?.length ?? 0) > 1) {
    return host;
  }
  return host.replace(/:\d+$/, '');
}
