/** First Hub-allocated app /24 (10.128.10.0/24). 10.128.0.0–10.128.9.0 are reserved for hub infrastructure. */
export const HUB_APP_ALLOCATION_START_CIDR = '10.128.10.0/24';

/** Last Hub-allocated app /24 (10.254.254.0/24). */
export const HUB_APP_ALLOCATION_END_CIDR = '10.254.254.0/24';

/**
 * Superset CIDR for diagnostics: detects foreign Docker networks that collide with Hub's
 * 10.128+ address space (10.128.0.0–10.255.255.255). Wider than the /24 slots Hub actually
 * allocates between {@link HUB_APP_ALLOCATION_START_CIDR} and {@link HUB_APP_ALLOCATION_END_CIDR}.
 */
export const HUB_APP_POOL_CIDR = '10.128.0.0/9';

/**
 * The edge network: the one bridge shared by Traefik and the two things that
 * proxy public traffic into it, cloudflared (Cloudflare tunnel) and the
 * Tailscale sidecar. Declared in docker-compose.prod.yml with a FIXED subnet
 * and fixed addresses, which is what lets Traefik trust the forwarded client
 * address from exactly those two hops and nothing else (`forwardedHeaders.
 * trustedIPs` in assets/traefik/traefik.yml). Apps never join it.
 *
 * Inside the 10.128.0.0–10.128.9.0 range {@link HUB_APP_POOL_CIDR} reserves
 * for Hub infrastructure, so the app allocator never hands it out.
 */
export const HUB_EDGE_NETWORK_NAME = 'ci-hub_edge';

/** The compose default for HUB_EDGE_SUBNET; .2 Traefik, .3 cloudflared, .4 Tailscale. */
export const DEFAULT_HUB_EDGE_SUBNET = '10.128.0.0/29';

/** Container name of the Traefik instance the prod compose runs. */
export const TRAEFIK_CONTAINER_NAME = 'traefik';
