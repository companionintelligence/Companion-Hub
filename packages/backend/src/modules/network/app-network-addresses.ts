import { parseIpv4Cidr } from './cidr-overlap';

/**
 * Where Traefik sits on an app's own network: the subnet's last host address (`.254` of the /24 the
 * Hub allocates).
 *
 * Each app is on a network of its own, which Traefik joins to reach it. An app that reads the client
 * address Traefik forwards trusts only Traefik's hop (`HUB_TRUSTED_PROXY_CIDRS`), so that hop has to be
 * an address the Hub knows when it writes the app's env, before the network exists. A fixed address
 * is that. Docker hands out an app network's addresses from the bottom up, so its own containers do
 * not reach the top of a /24; if one ever holds it, Traefik joins at an address Docker picks, the app
 * then trusts no Traefik hop, and its log says so (`DockerService`).
 *
 * The network's `ip_range` is not narrowed to keep the address free: an existing network cannot take
 * a new range while the Hub and Traefik are on it, and `compose up` fails trying.
 *
 * Null for anything but an IPv4 subnet of /30 or wider, which has no spare host address.
 */
export function traefikAddressOnAppSubnet(subnet: string | null | undefined): string | null {
  if (!subnet) {
    return null;
  }
  const parsed = parseIpv4Cidr(subnet);
  if (!parsed || parsed.end - parsed.start < 3) {
    return null;
  }
  return ipv4ToString(parsed.end - 1);
}

function ipv4ToString(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

/**
 * Where link networks are carved from: 10.128.1.0–10.128.9.255, the part of the range reserved for Hub
 * infrastructure (`HUB_APP_POOL_CIDR`'s first ten /24s) that the edge (10.128.0.0/29) and the Hub's
 * internal network (10.128.0.8/29) leave free. The app allocator starts at 10.128.10.0/24, so the two never meet.
 *
 * Not Docker's default pools: those hand each network a /16 or /20 and hold about thirty in all, and
 * every Memory consumer is a link.
 */
const APP_LINK_RANGE_START = '10.128.1.0/24';
const APP_LINK_RANGE_END = '10.128.9.255/32';
/** A /27: 29 addresses for one app's containers and the one service it reaches. 72 links fit. */
const APP_LINK_PREFIX = 27;

/** The first link subnet that overlaps none of `occupied` (every IPv4 subnet Docker has now), or null. */
export function nextAppLinkSubnet(occupied: readonly string[]): string | null {
  const start = parseIpv4Cidr(APP_LINK_RANGE_START)?.start;
  const end = parseIpv4Cidr(APP_LINK_RANGE_END)?.end;
  if (start === undefined || end === undefined) {
    return null;
  }
  const taken = occupied.map((cidr) => parseIpv4Cidr(cidr)).filter((range): range is NonNullable<typeof range> => range !== null);
  const size = 2 ** (32 - APP_LINK_PREFIX);
  for (let candidate = start; candidate + size - 1 <= end; candidate += size) {
    const last = candidate + size - 1;
    if (!taken.some((range) => range.start <= last && candidate <= range.end)) {
      return `${ipv4ToString(candidate)}/${APP_LINK_PREFIX}`;
    }
  }
  return null;
}
