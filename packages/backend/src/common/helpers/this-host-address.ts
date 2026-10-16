import fs from 'node:fs';
import { isIPv4 } from 'node:net';
import { detectHubContainer } from '@/modules/inference/backends/host-url.util';
import { normalizeIpLiteral } from './ip-address';

/** How long a read of the default gateway is kept. It changes only when Docker reconnects the container's networks. */
const DEFAULT_GATEWAY_KEPT_MS = 30_000;

/** What {@link createThisHostAddressCheck} reads about the machine it runs on. */
export interface ThisHostAddressSources {
  inContainer: () => boolean;
  /** The text of `/proc/net/route`. May throw. */
  readIpv4Routes: () => string;
}

/**
 * The IPv4 default gateway in the text of `/proc/net/route`, or `null` when there is none. With more
 * than one default route, the one with the lowest metric wins, as the kernel picks it.
 *
 * The kernel prints each address as hex in its own byte order, which is little-endian on both
 * platforms the Hub image is built for (amd64 and arm64).
 */
export function parseIpv4DefaultGateway(routes: string): string | null {
  let best: { address: string; metric: number } | null = null;

  for (const line of routes.split('\n').slice(1)) {
    const [, destination, gateway = '', flags = '', , , metric = '', mask] = line.trim().split(/\s+/);
    // RTF_UP (0x1) and RTF_GATEWAY (0x2): a default route that is up and goes through a router.
    if (destination !== '00000000' || mask !== '00000000' || (Number.parseInt(flags, 16) & 0x3) !== 0x3) {
      continue;
    }

    const raw = /^[0-9a-f]{8}$/i.test(gateway) ? Number.parseInt(gateway, 16) : 0;
    const rank = Number.parseInt(metric, 10);
    if (raw === 0 || Number.isNaN(rank) || (best && best.metric <= rank)) {
      continue;
    }

    best = { address: [raw & 0xff, (raw >>> 8) & 0xff, (raw >>> 16) & 0xff, raw >>> 24].join('.'), metric: rank };
  }

  return best?.address ?? null;
}

/**
 * Build the check {@link isThisHostAddress} makes, over sources a test can replace.
 *
 * A route table that can't be read, or has no default route, admits loopback only. Whether the Hub
 * runs in a container is read once, since it can't change while the process runs. `now` is monotonic
 * so that a clock stepped back by NTP can't keep a stale gateway.
 */
export function createThisHostAddressCheck(
  sources: ThisHostAddressSources,
  now: () => number = () => performance.now(),
): (address: string | undefined) => boolean {
  let kept: { gateway: string | null; until: number } | null = null;
  let inContainer: boolean | undefined;

  const defaultGateway = (): string | null => {
    if (!kept || kept.until <= now()) {
      let gateway: string | null = null;
      try {
        gateway = parseIpv4DefaultGateway(sources.readIpv4Routes());
      } catch {
        gateway = null;
      }
      kept = { gateway, until: now() + DEFAULT_GATEWAY_KEPT_MS };
    }

    return kept.gateway;
  };

  return (address) => {
    const ip = normalizeIpLiteral(address);
    if (!ip) {
      return false;
    }

    if (ip === '::1' || (isIPv4(ip) && ip.startsWith('127.'))) {
      return true;
    }

    inContainer ??= sources.inContainer();
    return inContainer && ip === defaultGateway();
  };
}

/**
 * Whether a socket's peer address is loopback or, when the Hub runs in a container, the container's
 * IPv4 default gateway. Those are the addresses the host's own connections to the Hub arrive from.
 *
 * Why the gateway: Docker programs a container's published ports on its gateway network. A
 * connection that reaches them through the host arrives from that network's gateway (see
 * `network/edge-hops.ts`). docker-proxy relaying a client on the host's loopback is one, such as
 * the headless setup service calling `http://127.0.0.1:5002`.
 *
 * This places a connection by its address. It isn't authentication, so a route that relies on it
 * keeps its other checks. Outside a container the default gateway is the LAN's router, so only
 * loopback counts there. It reads the IPv4 route table, since the Hub's networks are IPv4.
 */
export const isThisHostAddress = createThisHostAddressCheck({
  inContainer: detectHubContainer,
  readIpv4Routes: () => fs.readFileSync('/proc/net/route', 'utf8'),
});
