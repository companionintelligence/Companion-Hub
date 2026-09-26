import { parseIpv4Cidr } from './cidr-overlap';
import { DEFAULT_HUB_EDGE_CLOUDFLARED_IP, DEFAULT_HUB_EDGE_TAILSCALE_IP } from './network-constants';

/**
 * A proxy on the edge network that may vouch for a client's address, at the
 * fixed address docker-compose.prod.yml gives it. `name` is the compose
 * container name, and also the tag on its line in assets/traefik/traefik.yml.
 */
export interface EdgeHop {
  name: 'cloudflared' | 'hub-tailscale';
  address: string;
}

/**
 * The edge hops: cloudflared and the Tailscale sidecar, and NOT the edge
 * network's subnet.
 *
 * The subnet also holds the bridge's own gateway (.1), and that address is not
 * a hop. `ci-hub_edge` sorts first among Traefik's networks, so Docker makes it
 * Traefik's gateway network and programs Traefik's published ports there:
 * every connection that reaches Traefik through the host — docker-proxy for a
 * loopback client, masquerade for another container dialling the host's
 * address — arrives from that gateway. Measured on the fleet's Docker 29.8
 * (2026-09-26): a probe container on an unrelated bridge, the host loopback,
 * and a container on the listener's other network all reached a published
 * port as the gateway of the listener's first-by-name network. Trusting the
 * subnet therefore let any installed app send Traefik a forged
 * X-Forwarded-For through `host.docker.internal:80` and be believed.
 *
 * Read from HUB_EDGE_CLOUDFLARED_IP / HUB_EDGE_TAILSCALE_IP, the same values
 * the compose file pins the two containers to, so the trusted list and the
 * addresses cannot disagree. Anything that is not exactly an IPv4 address is
 * refused in favour of the default rather than written into a trusted list.
 */
export function resolveEdgeHops(env: NodeJS.ProcessEnv = process.env): EdgeHop[] {
  return [
    { name: 'cloudflared', address: resolveEdgeHopAddress(env.HUB_EDGE_CLOUDFLARED_IP, DEFAULT_HUB_EDGE_CLOUDFLARED_IP) },
    { name: 'hub-tailscale', address: resolveEdgeHopAddress(env.HUB_EDGE_TAILSCALE_IP, DEFAULT_HUB_EDGE_TAILSCALE_IP) },
  ];
}

/** `configured` when it is exactly an IPv4 address, otherwise `fallback`. */
export function resolveEdgeHopAddress(configured: string | undefined, fallback: string): string {
  const candidate = configured?.trim();
  if (candidate && /^(\d{1,3}\.){3}\d{1,3}$/.test(candidate) && parseIpv4Cidr(`${candidate}/32`)) {
    return candidate;
  }
  return fallback;
}

/**
 * Point each tagged `trustedIPs` entry in traefik.yml at its hop's resolved
 * address. The asset ships the compose defaults as real values rather than
 * placeholders, because the CLI (scripts/init-traefik.ts) and the desktop app
 * seed traefik.yml from it with only the ACME email filled in, before the Hub
 * ever runs, and Traefik will not start on a list entry that is not an
 * address. A stack on the defaults is therefore right from its first start;
 * only an override needs this.
 */
export function fillEdgeHopAddresses(content: string, hops: EdgeHop[] = resolveEdgeHops()): string {
  let next = content;
  for (const hop of hops) {
    next = next.replace(new RegExp(`^(\\s*-\\s*)\\S+(\\s+#\\s*edge hop: ${hop.name}\\b.*)$`, 'gm'), `$1${hop.address}/32$2`);
  }
  return next;
}
