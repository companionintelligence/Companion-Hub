import { TUNNEL_MARKER_HEADERS } from './hub-pool';
import { isPrivateOrLocalIp, normalizeIpLiteral } from './ip-address';

/**
 * The slice of an Express request the origin check reads. Structural, so a test can pass a plain
 * object and a guard can pass the real thing; nothing here is ever written.
 */
export interface OriginCheckedRequest {
  ip?: string;
  socket?: { remoteAddress?: string | undefined };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Why a request is NOT from inside the appliance, or `null` when it is.
 *
 * - `public-address`: the address Express resolved for the caller is not loopback, RFC1918, CGNAT
 *   or ULA — the check `InternalNetworkGuard` makes.
 * - `tunnel-marker`: a header only Cloudflare's edge adds (`cf-ray` and friends) is present.
 * - `forwarded-hop`: a hop in `x-forwarded-for` that parses as an address is public.
 */
export type InternalOriginRefusal = 'public-address' | 'tunnel-marker' | 'forwarded-hop';

/**
 * Prove a request originated inside the appliance, or say why it did not.
 *
 * `request.ip` alone does not prove it: behind Traefik or the Cloudflare tunnel it is the proxy's
 * own private address unless `HUB_TRUST_PROXY` is set (see main.ts), so a check on it alone passes
 * public tunnel traffic by default — and the Hub API is unconditionally published through that
 * tunnel. Apps reach the inference routes container-to-container at
 * `http://<hub>:<API_PORT>/api/inference/...` (see `InferenceEndpointService`), which traverses no
 * proxy at all, so a request carrying proxy provenance is by definition not one of them, whatever
 * `request.ip` says. Three checks, all of which must pass:
 *
 * 1. The resolved address is private (`isPrivateOrLocalIp`; `socket.remoteAddress` when Express
 *    has not set `ip`).
 * 2. None of `TUNNEL_MARKER_HEADERS` is present. A caller cannot strip a header the edge adds.
 * 3. Every non-empty hop of `x-forwarded-for` is a private address. The chain is caller-controlled,
 *    so this can only ever refuse — an internal caller could forge a clean one, but an internal
 *    caller is already admitted. A hop that is not an address at all (`unknown`, an obfuscated
 *    identifier) is refused like a public one: it says a proxy this Hub cannot place sat in the
 *    path, and the safe reading of an address that cannot be read is "not inside".
 *
 * This is an origin check, not caller authentication: it answers "did this arrive from inside",
 * never "who sent it". `InferenceAccessGuard` uses it as the leg that needs no credential, and
 * refuses a request it cannot place inside unless that request carries an `inference` API key.
 */
export function internalOriginRefusal(request: OriginCheckedRequest): InternalOriginRefusal | null {
  const ip = normalizeIpLiteral(request.ip ?? request.socket?.remoteAddress);
  if (!ip || !isPrivateOrLocalIp(ip)) {
    return 'public-address';
  }

  const headers = request.headers ?? {};
  for (const header of TUNNEL_MARKER_HEADERS) {
    if (headers[header]) {
      return 'tunnel-marker';
    }
  }

  const forwardedFor = headers['x-forwarded-for'];
  const chain = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  for (const hop of chain.split(',')) {
    const hopIp = normalizeIpLiteral(hop);
    if (hopIp && !isPrivateOrLocalIp(hopIp)) {
      return 'forwarded-hop';
    }
  }

  return null;
}
