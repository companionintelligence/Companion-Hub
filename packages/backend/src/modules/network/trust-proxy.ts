import type { ProxyTrustService } from './proxy-trust.service';

/** A value Express accepts as its `trust proxy` setting. */
export type TrustProxySetting = number | string | ((address: string, hop: number) => boolean);

/**
 * The Express `trust proxy` setting for this process, which decides `req.ip`.
 *
 * Behind Traefik and the Cloudflare tunnel the socket is always a proxy, so without it
 * InternalNetworkGuard, AppContainerOriginGuard, the pairing-PIN limiter and every audit log see
 * Traefik for every remote visitor. With too much of it, anyone who can reach the Hub chooses the
 * address they appear as: an `X-Forwarded-For` naming an app container's address would pass
 * AppContainerOriginGuard for that app.
 *
 * By default the hops are RESOLVED, not configured: Express asks {@link ProxyTrustService} about each
 * hop, walking back from the socket, and stops at the first it does not vouch for. That is the two
 * edge hops (cloudflared and the Tailscale sidecar, by their fixed addresses) and Traefik's own
 * address, read from Docker. Nothing on the LAN, in an app container, or at a bridge gateway is ever
 * in that set, and until the first read nothing is, so a spoofed `X-Forwarded-For` from there names
 * nobody but the sender.
 *
 * HUB_TRUST_PROXY overrides it for an operator with their own proxy in front: a hop count ("1") or
 * a list of trusted addresses and subnets ("172.16.0.0/12"), passed to Express unchanged. A
 * too-broad value lets a spoofed `X-Forwarded-For` appear internal, so it is for known provenance
 * only. An invalid value ("true") makes Express throw at startup, which fails closed.
 */
export function resolveTrustProxySetting(env: NodeJS.ProcessEnv, proxyTrust: Pick<ProxyTrustService, 'isTrustedProxy'>): TrustProxySetting {
  const configured = env.HUB_TRUST_PROXY?.trim();
  if (configured) {
    return /^\d+$/.test(configured) ? Number(configured) : configured;
  }
  return (address: string) => proxyTrust.isTrustedProxy(address);
}

/**
 * Applies {@link resolveTrustProxySetting} to the Express instance. `trust proxy` is process-wide: it
 * also changes `req.protocol` and `req.hostname` for registration and SSO.
 */
export function configureTrustProxy(
  expressApp: { set(setting: string, value: unknown): unknown },
  env: NodeJS.ProcessEnv,
  proxyTrust: Pick<ProxyTrustService, 'isTrustedProxy'>,
): void {
  expressApp.set('trust proxy', resolveTrustProxySetting(env, proxyTrust));
}
