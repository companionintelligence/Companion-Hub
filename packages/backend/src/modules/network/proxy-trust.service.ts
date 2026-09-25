import { hubNetworkName } from '@/common/constants';
import { normalizeIpLiteral } from '@/common/helpers/ip-address';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { DOCKERODE } from '../docker/constants';
import { parseIpv4Cidr } from './cidr-overlap';
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
 * A request from the public internet crosses cloudflared (or the Tailscale
 * sidecar) and then Traefik before it reaches the Hub or an app. Each hop
 * appends itself to X-Forwarded-For; whoever reads the client address has to
 * know which trailing entries are proxies and walk back past them. Trusting
 * too little leaves every remote visitor looking like Traefik (one address for
 * the whole world, which made the apps' per-address login throttles a lockout
 * anyone could trigger). Trusting too much — a whole Docker subnet — lets any
 * container on it choose the address it appears as.
 *
 * So the trusted set is exactly two things, both read from Docker rather than
 * configured by hand:
 *
 *  - the edge network's subnet ({@link HUB_EDGE_NETWORK_NAME}), which holds
 *    only cloudflared and the Tailscale sidecar, at fixed addresses;
 *  - Traefik's current address on the Hub network, as a /32. Traefik is what
 *    the Hub and every app see as their peer, and its address on that network
 *    is assigned by Docker, so it is looked up rather than assumed.
 *
 * Re-read every minute, so a recreated Traefik is picked up without a restart.
 * Until the first read completes, nothing is trusted, which is the pre-change
 * behaviour.
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
   * A lookup failure leaves the previous answer in place: a Docker hiccup
   * must not turn trust off and on.
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

    const edge = await this.edgeSubnet();
    if (edge) {
      next.push(edge);
    }

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

  private async edgeSubnet(): Promise<Range | null> {
    try {
      const info = await this.docker.getNetwork(HUB_EDGE_NETWORK_NAME).inspect();
      const configs = (info as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM?.Config ?? [];
      for (const config of configs) {
        const parsed = config.Subnet ? parseIpv4Cidr(config.Subnet) : null;
        if (parsed) {
          return { cidr: parsed.normalized, start: parsed.start, end: parsed.end };
        }
      }
      this.logger.warn(`Edge network ${HUB_EDGE_NETWORK_NAME} has no IPv4 subnet; its hops are untrusted`);
      return null;
    } catch (error) {
      // Absent on a stack that predates the edge network, or one running
      // without the prod compose. Not an error: it just means no tunnel hop
      // can be vouched for.
      this.logger.debug(`Edge network ${HUB_EDGE_NETWORK_NAME} not readable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
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
