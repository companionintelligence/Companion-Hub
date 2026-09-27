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

/** How long to wait before re-subscribing to Traefik's container events after the stream ends. */
const EVENTS_RETRY_MS = 10_000;

interface Range {
  cidr: string;
  start: number;
  end: number;
}

/** One completed read of the hops, as handed to {@link ProxyTrustService.onResolved} listeners. */
export interface ProxyTrustSnapshot {
  /** {@link ProxyTrustService.trustedProxyCidrs} as of this read. */
  cidrs: string[];
  /**
   * Whether this read found Traefik's address. A read that did not (Traefik being recreated, Docker
   * not answering) is a partial answer, not news that the hops changed, so nothing should be
   * rewritten from it.
   */
  traefikResolved: boolean;
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
 *    and only while the edge network ({@link HUB_EDGE_NETWORK_NAME}) exists,
 *    the address lies inside its subnet, and Docker cannot hand it out (see
 *    `edgeHops`). Never the subnet itself: its gateway is the host's own
 *    address on the bridge, so anything the host sends or routes onto it
 *    arrives from there;
 *  - Traefik's current address on the Hub network, as a /32. Traefik is what
 *    the Hub and every app see as their peer, and its address on that network
 *    is assigned by Docker, so it is looked up rather than assumed.
 *
 * Re-read every minute, so a recreated Traefik is picked up without a restart.
 * Until the first read completes, nothing is trusted, which is the pre-change
 * behaviour. The apps' copy cannot follow that way: each read is handed to
 * {@link onResolved} listeners, and `TrustedProxyRefreshService` recreates the
 * running apps that consume HUB_TRUSTED_PROXY_CIDRS when theirs no longer
 * matches, since Docker gives a freed address to the next container that asks.
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
  private readonly listeners = new Set<(snapshot: ProxyTrustSnapshot) => void>();
  private events: NodeJS.ReadableStream | null = null;
  private eventsRetry: NodeJS.Timeout | null = null;
  private destroyed = false;

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
    this.watchTraefik();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventsRetry) {
      clearTimeout(this.eventsRetry);
      this.eventsRetry = null;
    }
    const events = this.events as (NodeJS.ReadableStream & { destroy?: () => void }) | null;
    this.events = null;
    events?.destroy?.();
  }

  /**
   * Re-reads the hops the moment Traefik starts or stops, rather than at the next minute.
   *
   * A stopped or removed Traefik releases its address on the Hub network, and Docker gives it to the
   * next container that asks. Until the next read that container would be trusted to name any
   * client it liked, to the Hub (`req.ip`, which AppContainerOriginGuard matches against app
   * containers) and, through `onResolved`, to the apps. The minute's poll stays as the fallback for
   * a stream that is down.
   */
  private watchTraefik(): void {
    if (this.destroyed || typeof this.docker.getEvents !== 'function') {
      return;
    }
    const retry = () => {
      this.events = null;
      if (!this.destroyed && !this.eventsRetry) {
        this.eventsRetry = setTimeout(() => {
          this.eventsRetry = null;
          this.watchTraefik();
        }, EVENTS_RETRY_MS);
        this.eventsRetry.unref();
      }
    };

    Promise.resolve()
      .then(() =>
        this.docker.getEvents({
          filters: { type: ['container'], container: [TRAEFIK_CONTAINER_NAME], event: ['start', 'die', 'destroy'] },
        } as Dockerode.GetEventsOptions),
      )
      .then((stream) => {
        if (!stream) {
          return;
        }
        if (this.destroyed) {
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          return;
        }
        this.events = stream;
        // Like the poll timer, the subscription alone never keeps the process alive.
        (stream as { socket?: { unref?: () => void } }).socket?.unref?.();
        stream.on('data', () => {
          // A read already under way may have started before this event, so read again after it.
          const inFlight = this.resolving;
          void (inFlight ? inFlight.then(() => this.refresh()) : this.refresh());
        });
        stream.on('error', retry);
        stream.on('end', retry);
      })
      .catch((error) => {
        this.logger.debug(`Traefik events not readable: ${error instanceof Error ? error.message : String(error)}`);
        retry();
      });
  }

  /**
   * Called after every read of the hops, changed or not, until the returned function is called.
   * A listener that throws is logged and does not stop the others.
   */
  onResolved(listener: (snapshot: ProxyTrustSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

    const snapshot: ProxyTrustSnapshot = { cidrs: this.trustedProxyCidrs(), traefikResolved: traefik !== null };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.warn(`Trusted proxy listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return this.trustedProxyCidrs();
  }

  /**
   * The edge hops that can currently be vouched for: each configured hop
   * address that lies inside the edge network's subnet, is not its gateway,
   * and lies outside the range Docker hands addresses out from.
   *
   * The configured addresses rather than whichever containers are attached
   * right now, so a cloudflared the Hub starts later (enabling the tunnel) is
   * trusted from its first request, not from the next refresh. What keeps
   * anything else off those addresses is the network's `ip_range`: Docker
   * allocates only from it, and the compose file's holds nothing but the
   * network address and the gateway, so a container that joins without a
   * fixed address (a `network_mode` naming the network, which the Hub also
   * refuses in app manifests) fails to start rather than taking a hop's
   * address. A network without that range — created before it was added, or
   * with an override that covers a hop — would hand the address to whatever
   * joins first, so its hops are not trusted.
   */
  private async edgeHops(): Promise<Range[]> {
    let configs: Array<{ Subnet?: string; Gateway?: string; IPRange?: string }>;
    try {
      const info = await this.docker.getNetwork(HUB_EDGE_NETWORK_NAME).inspect();
      configs = (info as { IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string; IPRange?: string }> } }).IPAM?.Config ?? [];
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
      // No range means Docker allocates from the whole subnet.
      const dynamic = (config.IPRange ? parseIpv4Cidr(config.IPRange) : null) ?? subnet;
      const hops: Range[] = [];
      for (const hop of resolveEdgeHops()) {
        const parsed = parseIpv4Cidr(`${hop.address}/32`);
        if (!parsed || parsed.start < subnet.start || parsed.start > subnet.end || parsed.start === gateway) {
          this.logger.warn(`Edge hop ${hop.name} at ${hop.address} is not a host address on ${subnet.normalized}; it is untrusted`);
          continue;
        }
        if (parsed.start >= dynamic.start && parsed.start <= dynamic.end) {
          this.logger.warn(
            `Edge hop ${hop.name} at ${hop.address} is inside ${HUB_EDGE_NETWORK_NAME}'s allocation range ${dynamic.normalized}, ` +
              'so Docker could give it to any container that joins; it is untrusted. Recreate the network from the current ' +
              'compose file (`up -d --force-recreate traefik cloudflared hub-tailscale` after it is recreated).',
          );
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
