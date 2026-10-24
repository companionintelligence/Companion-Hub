import { TUNNEL_MARKER_HEADERS } from './hub-pool';
import { isPrivateOrLocalIp, isTailnetIp, normalizeIpLiteral } from './ip-address';

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
 * - `tailnet-address`: only when asked for (`tailnetIsOutside`): the resolved address, or a forwarded
 *   hop, is a tailnet address.
 */
export type InternalOriginRefusal = 'public-address' | 'tunnel-marker' | 'forwarded-hop' | 'tailnet-address';

export interface InternalOriginOptions {
  /**
   * Count a caller whose resolved address, or any forwarded hop, is a tailnet address as OUTSIDE the
   * appliance. Default `false`: the tailnet is inside, as it has been since the pool shipped (a paired
   * Hub is "as internal as one from the Docker bridge", see `isPrivateOrLocalIp`). Only a route that
   * wants a credential from tailnet callers sets it (`InferenceAccessGuard` under
   * `HUB_INFERENCE_TAILNET_AUTH=require-key`); every other caller of this function keeps the default.
   */
  tailnetIsOutside?: boolean;
}

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
 * never "who sent it". With `tailnetIsOutside` a fourth check applies: a tailnet address, as the resolved
 * address or as any forwarded hop, is refused too (`tailnet-address`). `InferenceAccessGuard` uses it as the leg that needs no credential, and
 * refuses a request it cannot place inside unless that request carries an `inference` API key.
 * `InternalOriginGuard` is its guard form for routes that are app-only and take no credential at
 * all, such as the app credentials handout.
 */
export function internalOriginRefusal(request: OriginCheckedRequest, options: InternalOriginOptions = {}): InternalOriginRefusal | null {
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
  const hops = chain.split(',').map((hop) => normalizeIpLiteral(hop));
  for (const hopIp of hops) {
    if (hopIp && !isPrivateOrLocalIp(hopIp)) {
      return 'forwarded-hop';
    }
  }

  // Last, so every existing reason keeps its priority. A tailnet client reaches a Hub through
  // `tailscale serve` (or the sidecar), so the resolved address is the proxy's own private one and the
  // client is the tailnet hop in the forwarded chain; a client on the port directly is the address.
  if (options.tailnetIsOutside && (isTailnetIp(ip) || hops.some((hopIp) => isTailnetIp(hopIp)))) {
    return 'tailnet-address';
  }

  return null;
}
