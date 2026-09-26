import { hubNetworkName } from '@/common/constants';
import { normalizeIpLiteral } from '@/common/helpers/ip-address';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { DOCKERODE } from '../docker/constants';
import { parseIpv4Cidr } from './cidr-overlap';
import { resolveEdgeHops } from './edge-hops';
import { HUB_EDGE_NETWORK_NAME, TRAEFIK_CONTAINER_NAME } from './network-constants';

/** How often the resolved hops are re-read from Docker. */
const REFRESH_INTERVAL_MS = 60_000;

interface Range {
  cidr: string;
  start: number;
  end: number;
}

/**
 * The reverse-proxy hops this appliance can vouch for.
 *
 * A request for an app's public hostname crosses cloudflared and then Traefik
 * before it reaches the app (and the Hub, as Traefik's forward-auth call). Each
 * hop appends itself to X-Forwarded-For; whoever reads the client address has to
 * know which trailing entries are proxies and walk back past them. Trusting
 * too little leaves every remote visitor looking like Traefik (one address for
 * the whole world, which made the apps' per-address login throttles a lockout
 * anyone could trigger). Trusting too much — a whole Docker subnet — lets any
 * container on it choose the address it appears as.
 *
 * So the trusted set is exactly two things:
 *
 *  - the edge hops, cloudflared and the Tailscale sidecar, each as a /32 at the
 *    fixed address the compose file pins it to ({@link resolveEdgeHops}) —
 *    and only while the edge network ({@link HUB_EDGE_NETWORK_NAME}) exists
 *    and the address lies inside its subnet. Never the subnet itself: its
 *    gateway is the address every connection that reaches Traefik through the
 *    host arrives from, so trusting it would believe whatever an app sent to
 *    `host.docker.internal:80`;
 *  - Traefik's current address on the Hub network, as a /32. Traefik is what
 *    the Hub and every app see as their peer, and its address on that network
 *    is assigned by Docker, so it is looked up rather than assumed.
 *
 * Re-read every minute, so a recreated Traefik is picked up without a restart.
 * Until the first read completes, nothing is trusted, which is the pre-change
 * behaviour.
 *
 * Not every public path runs through Traefik. Portal routes the Hub's OWN
 * hostname to `host.docker.internal:{port}`, and `tailscale serve` targets the
 * Hub's port or an app container directly; those reach their target through
 * the host or from a bridge address that is in neither set, so their
 * forwarded headers are ignored and the peer is named as it was before.
 * A narrower answer, never a spoofable one.
 *
 * Two consumers: `main.ts` hands Express a `trust proxy` function backed by
 * {@link isTrustedProxy}, and `AppHelpers.generateEnvFile` passes
 * {@link trustedProxyCidrs} to each app as HUB_TRUSTED_PROXY_CIDRS.
 */
@Injectable()
export class ProxyTrustService implements OnModuleInit, OnModuleDestroy {
  private ranges: Range[] = [];
  private timer: NodeJS.Timeout | null = null;
  private resolving: Promise<string[]> | null = null;

  constructor(
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The hops as CIDR strings, in a stable order; empty when nothing is trusted. */
  trustedProxyCidrs(): string[] {
    return this.ranges.map((range) => range.cidr);
  }

  /** Whether `ip` is one of the trusted hops. IPv4 only; anything else is untrusted. */
  isTrustedProxy(ip: string | undefined | null): boolean {
    const normalized = normalizeIpLiteral(ip);
    if (!normalized) {
      return false;
    }
    const parsed = parseIpv4Cidr(`${normalized}/32`);
    if (!parsed) {
      return false;
    }
    return this.ranges.some((range) => parsed.start >= range.start && parsed.start <= range.end);
  }

  /**
   * Re-read the hops from Docker. Concurrent callers share one in-flight read.
   * A lookup that fails drops what it would have vouched for until the next
   * read: not seeing Docker can narrow trust, never widen it.
   */
  async refresh(): Promise<string[]> {
    if (!this.resolving) {
      this.resolving = this.resolve().finally(() => {
        this.resolving = null;
      });
    }
    return this.resolving;
  }

  private async resolve(): Promise<string[]> {
    const next: Range[] = [];

    next.push(...(await this.edgeHops()));

    const traefik = await this.traefikAddress();
    if (traefik) {
      next.push(traefik);
    }

    const before = this.trustedProxyCidrs().join(',');
    this.ranges = next;
    const after = this.trustedProxyCidrs().join(',');
    if (before !== after) {
      this.logger.info(`Trusted proxy hops: ${after || '(none)'}`);
    }

    return this.trustedProxyCidrs();
  }

  /**
   * The edge hops that can currently be vouched for: each configured hop
   * address that lies inside the edge network's subnet and is not its gateway.
   * The configured addresses rather than whichever containers are attached
   * right now, so a cloudflared the Hub starts later (enabling the tunnel) is
   * trusted from its first request, not from the next refresh; nothing else
   * can hold those addresses, because apps never join the edge network.
   */
  private async edgeHops(): Promise<Range[]> {
    let configs: Array<{ Subnet?: string; Gateway?: string }>;
    try {
      const info = await this.docker.getNetwork(HUB_EDGE_NETWORK_NAME).inspect();
      configs = (info as { IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> } }).IPAM?.Config ?? [];
    } catch (error) {
      // Absent on a stack that predates the edge network, or one running
      // without the prod compose. Not an error: it just means no tunnel hop
      // can be vouched for.
      this.logger.debug(`Edge network ${HUB_EDGE_NETWORK_NAME} not readable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    for (const config of configs) {
      const subnet = config.Subnet ? parseIpv4Cidr(config.Subnet) : null;
      if (!subnet) {
        continue;
      }
      // Docker's default gateway is the subnet's first host; the inspect
      // normally names it, and a named one wins.
      const gateway = (config.Gateway ? parseIpv4Cidr(`${config.Gateway}/32`)?.start : undefined) ?? subnet.start + 1;
      const hops: Range[] = [];
      for (const hop of resolveEdgeHops()) {
        const parsed = parseIpv4Cidr(`${hop.address}/32`);
        if (!parsed || parsed.start < subnet.start || parsed.start > subnet.end || parsed.start === gateway) {
          this.logger.warn(`Edge hop ${hop.name} at ${hop.address} is not a host address on ${subnet.normalized}; it is untrusted`);
          continue;
        }
        hops.push({ cidr: parsed.normalized, start: parsed.start, end: parsed.end });
      }
      return hops;
    }

    this.logger.warn(`Edge network ${HUB_EDGE_NETWORK_NAME} has no IPv4 subnet; its hops are untrusted`);
    return [];
  }

  private async traefikAddress(): Promise<Range | null> {
    try {
      const info = await this.docker.getContainer(TRAEFIK_CONTAINER_NAME).inspect();
      const networks = (info as { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }).NetworkSettings?.Networks ?? {};
      const address = networks[hubNetworkName()]?.IPAddress;
      const parsed = address ? parseIpv4Cidr(`${address}/32`) : null;
      if (!parsed) {
        this.logger.warn(`Traefik has no address on ${hubNetworkName()}; its hop is untrusted`);
        return null;
      }
      return { cidr: parsed.normalized, start: parsed.start, end: parsed.end };
    } catch (error) {
      this.logger.debug(`Traefik container not readable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
