import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException, forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { normalizePeerFqdn } from '@/common/helpers/hub-pool';
import { isPoolProbeTarget } from '@/common/helpers/ip-address';
import {
  MAX_MANUAL_POOL_CANDIDATES,
  POOL_PROBE_MISS_THRESHOLD,
  formatProbeAuthority,
  parseProbeTarget,
  poolProbePortCandidates,
  type PoolProbeTarget,
} from '@/common/helpers/hub-pool-probe';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import { HubPoolPeerService } from './hub-pool-peer.service';
import type { DiscoverablePoolPeer, PoolProbeResult } from './hub-pool.types';

/** Matches `DISCOVERY_PROBE_TIMEOUT_MS` in `hub-pool-peer.service.ts` — the same probe, over a different route. */
const PROBE_TIMEOUT_MS = 5_000;

/** Longest `nodeFqdn`/`hostname` string kept from a probe answer, so a hostile responder cannot author an unbounded row. */
const MAX_REMOTE_STRING_LENGTH = 253;

/** A manually probed node, remembered between discovery refreshes so the operator types an address once. */
interface ManualCandidate {
  /** Normalized peer FQDN. Also the merge key — a name the tailnet control plane attests, unlike anything the box told us about itself. */
  nodeFqdn: string;
  hostname: string;
  /** `host:port` that answered, so a refresh re-probes the address the operator gave rather than re-resolving. */
  authority: string;
  /** Whether {@link authority} answered over TLS. Remembered so a refresh does not re-walk the scheme fallback. */
  https: boolean;
  /** Consecutive refreshes with no answer. Evicted at {@link POOL_PROBE_MISS_THRESHOLD}. */
  misses: number;
  lastSeenAt: string;
}

/**
 * Candidate discovery: the Tailscale Admin API directory, plus manually entered addresses, merged
 * into one list.
 *
 * The point of the manual half is that pairing no longer *requires* a Tailscale OAuth client. Two
 * Hubs on one LAN and one tailnet can already reach each other perfectly; until now the only way to
 * enumerate them was a credential the operator had to go and create. Typing `192.168.1.42` once
 * replaces that.
 *
 * What it explicitly does NOT do is make the address a peer. The probe learns the node's tailnet
 * FQDN and then throws the address away: pairing, health polling and every proxied request still go
 * to `https://<fqdn>`, with the same TLS check and the same bearer tokens on the same WireGuard
 * transport. An address is a *directory lookup*, never a transport — which is why
 * `normalizePeerFqdn` can go on refusing IP literals for anything that gets stored.
 */
@Injectable()
export class HubPoolDiscoveryService {
  /** Keyed by normalized `nodeFqdn`. In memory only: this is a convenience list, not pairing state, and a restart costs one retype. */
  private readonly manualCandidates = new Map<string, ManualCandidate>();

  constructor(
    private readonly logger: LoggerService,
    private readonly repo: HubPoolPeerRepository,
    private readonly peerService: HubPoolPeerService,
    private readonly tailscaleService: TailscaleService,
    @Optional()
    @Inject(forwardRef(() => PortalClientService))
    private readonly portalClient?: PortalClientService,
  ) {}

  /**
   * Probe one operator-typed address and report what is there.
   *
   * SSRF containment: the host is resolved up front and EVERY resolved address must be a private or
   * CGNAT one ({@link isPoolProbeTarget}), so a name that resolves to a public address is refused
   * rather than fetched. There is a residual rebinding window between the check and the fetch; it is
   * not closed, because this route is operator-authenticated, carries no credential outbound, and
   * only two strings survive from the response. That is a stated limit, not an oversight.
   */
  async probeAddress(rawAddress: string): Promise<PoolProbeResult> {
    const target = parseProbeTarget(rawAddress);
    if (!target) {
      throw new BadRequestException('Enter an address like 192.168.1.42, 192.168.1.42:5002, or a hostname');
    }

    const address = target.port === null ? target.host : formatProbeAuthority(target, target.port);
    await this.assertProbeTargetIsPrivate(target.host);

    const answer = await this.fetchIdentify(target);
    if (!answer) {
      return {
        address,
        isCiHub: false,
        nodeFqdn: null,
        hostname: null,
        alreadyPaired: false,
        pairable: false,
        reason: 'unreachable',
      };
    }

    if (!answer.isCiHub) {
      return {
        address,
        isCiHub: false,
        nodeFqdn: null,
        hostname: null,
        alreadyPaired: false,
        pairable: false,
        reason: 'not_a_hub',
      };
    }

    if (!answer.nodeFqdn) {
      return {
        address,
        isCiHub: true,
        nodeFqdn: null,
        hostname: null,
        alreadyPaired: false,
        pairable: false,
        reason: 'no_tailnet_fqdn',
      };
    }

    const nodeFqdn = normalizePeerFqdn(answer.nodeFqdn);
    if (!nodeFqdn) {
      return {
        address,
        isCiHub: true,
        nodeFqdn: null,
        hostname: null,
        alreadyPaired: false,
        pairable: false,
        reason: 'no_tailnet_fqdn',
      };
    }

    const selfStatus = await this.tailscaleService.getStatusCached();
    if (selfStatus.nodeFqdn && normalizePeerFqdn(selfStatus.nodeFqdn) === nodeFqdn) {
      return {
        address,
        isCiHub: true,
        nodeFqdn,
        hostname: selfStatus.hostname ?? nodeFqdn,
        alreadyPaired: false,
        pairable: false,
        reason: 'self',
      };
    }

    const existing = await this.repo.findByNodeFqdn(nodeFqdn);
    if (existing) {
      return {
        address,
        isCiHub: true,
        nodeFqdn,
        hostname: existing.displayName ?? nodeFqdn,
        alreadyPaired: true,
        pairable: false,
        reason: 'already_paired',
      };
    }

    const hostname = nodeFqdn.split('.')[0] as string;
    this.rememberCandidate({
      nodeFqdn,
      hostname,
      authority: answer.authority,
      https: answer.https,
      misses: 0,
      lastSeenAt: new Date().toISOString(),
    });

    return { address, isCiHub: true, nodeFqdn, hostname, alreadyPaired: false, pairable: true, reason: null };
  }

  /**
   * Every candidate this node can offer to pair with, from all sources, deduplicated.
   *
   * Also the refresh tick for manual candidates — deliberately here and not on
   * `HubPoolPeerService`'s health timer, so a single-node Hub with no peers and no candidates issues
   * exactly zero background network calls, and `getPoolStatus` keeps the "never triggers discovery
   * I/O" promise its doc comment makes.
   */
  async listDiscoverableNodes(): Promise<DiscoverablePoolPeer[]> {
    const [tailscale, portal, manual] = await Promise.all([
      this.listTailscaleCandidates(),
      this.listPortalCandidates(),
      this.refreshManualCandidates(),
    ]);
    return mergePoolCandidates([...tailscale, ...portal], manual);
  }

  private async listTailscaleCandidates(): Promise<DiscoverablePoolPeer[]> {
    // Unchanged, and it must stay that way: Admin API discovery is what lets a pool span networks,
    // which is the whole advantage over a LAN-only design. Manual entry is an addition to it.
    const devices = await this.peerService.listDiscoverableDevices();
    return devices.map((device) => ({ ...device, source: 'tailscale' as const }));
  }

  /**
   * Discovery candidates from the CI Portal dispatch API: Hub devices registered to the same user or
   * organization across the public internet.
   */
  private async listPortalCandidates(): Promise<DiscoverablePoolPeer[]> {
    if (!this.portalClient) return [];
    try {
      const devices = await this.portalClient.fetchDispatchDevices();
      if (!devices || devices.length === 0) return [];

      const selfStatus = await this.tailscaleService.getStatusCached();
      const existingPeers = await this.repo.listAll();
      const known = new Set(existingPeers.map((p) => p.nodeFqdn));

      const candidates: DiscoverablePoolPeer[] = [];
      await Promise.all(
        devices.map(async (device) => {
          const targetHost = device.tailscaleDns || device.lanIp;
          if (!targetHost || targetHost === selfStatus.nodeFqdn || known.has(targetHost)) return;

          const answer = await this.tryIdentify(targetHost, true);
          if (answer?.isCiHub) {
            candidates.push({
              tailscaleDeviceId: device.id,
              nodeFqdn: answer.nodeFqdn || targetHost,
              hostname: device.name || targetHost,
              source: 'portal',
            });
          }
        }),
      );
      return candidates;
    } catch (err) {
      this.logger.debug(`[HubPool] listPortalCandidates error: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Re-probe each remembered candidate, evicting one that has gone unanswered three refreshes
   * running.
   *
   * Three, not one: a candidate must not vanish because a laptop was asleep for a single refresh.
   * The same convention `refreshPeerHealth` uses for a paired peer — and the eviction here is only
   * ever of an *unpaired* candidate. A paired peer's liveness stays entirely
   * `refreshPeerHealth`'s business; letting a failed LAN probe unpair a healthy node would be a
   * regression on a deployed subsystem.
   */
  private async refreshManualCandidates(): Promise<DiscoverablePoolPeer[]> {
    if (this.manualCandidates.size === 0) {
      return [];
    }

    const paired = new Set((await this.repo.listAll()).map((peer) => peer.nodeFqdn));
    const entries = [...this.manualCandidates.values()];

    await Promise.all(
      entries.map(async (candidate) => {
        if (paired.has(candidate.nodeFqdn)) {
          this.manualCandidates.delete(candidate.nodeFqdn);
          return;
        }
        const alive = await this.reprobeCandidate(candidate);
        if (alive) {
          candidate.misses = 0;
          candidate.lastSeenAt = new Date().toISOString();
          return;
        }
        candidate.misses += 1;
        if (candidate.misses >= POOL_PROBE_MISS_THRESHOLD) {
          this.logger.info(
            `[HubPool] dropping manual pool candidate ${candidate.nodeFqdn}: unanswered on ${candidate.authority} for ${POOL_PROBE_MISS_THRESHOLD} refreshes`,
          );
          this.manualCandidates.delete(candidate.nodeFqdn);
        }
      }),
    );

    return [...this.manualCandidates.values()].map((candidate) => ({
      // No Tailscale device id exists for a LAN find. Empty rather than nullable: widening the field
      // is a type error on the CLI's `sanitizeForBox(value: string)` and — since the settings list
      // keys on it — a duplicate React key the moment there are two of these. The `source` badge is
      // what tells the two apart.
      tailscaleDeviceId: '',
      nodeFqdn: candidate.nodeFqdn,
      hostname: candidate.hostname,
      source: 'lan-probe' as const,
    }));
  }

  private rememberCandidate(candidate: ManualCandidate): void {
    // Re-probing a known node refreshes it rather than counting against the cap.
    if (!this.manualCandidates.has(candidate.nodeFqdn) && this.manualCandidates.size >= MAX_MANUAL_POOL_CANDIDATES) {
      this.logger.warn(
        `[HubPool] not remembering manual pool candidate ${candidate.nodeFqdn}: already holding ${MAX_MANUAL_POOL_CANDIDATES}. Pair or dismiss one first.`,
      );
      return;
    }
    this.manualCandidates.set(candidate.nodeFqdn, candidate);
  }

  /** Every address the host resolves to must be private or CGNAT — one public answer refuses the whole probe. */
  private async assertProbeTargetIsPrivate(host: string): Promise<void> {
    let addresses: string[];
    if (isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
      } catch (error) {
        throw new BadRequestException(`Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (addresses.length === 0 || !addresses.every((address) => isPoolProbeTarget(address))) {
      throw new BadRequestException('Pool peers are reached over a private network — enter a LAN or tailnet address');
    }
  }

  /** Walks the port candidates, plain HTTP first (the published API port is plain on the LAN), then HTTPS with normal certificate validation. */
  private async fetchIdentify(target: PoolProbeTarget): Promise<IdentifyAnswer | null> {
    for (const port of poolProbePortCandidates(target.port)) {
      const authority = formatProbeAuthority(target, port);
      for (const https of [false, true]) {
        const answer = await this.tryIdentify(authority, https);
        if (answer) {
          return { ...answer, authority, https };
        }
      }
    }
    return null;
  }

  private async reprobeCandidate(candidate: ManualCandidate): Promise<boolean> {
    const answer = await this.tryIdentify(candidate.authority, candidate.https);
    return answer?.isCiHub === true;
  }

  private async tryIdentify(authority: string, https: boolean): Promise<{ isCiHub: boolean; nodeFqdn: string | null } | null> {
    const url = `${https ? 'https' : 'http'}://${authority}/api/inference/pool/identify`;
    try {
      // `NODE_TLS_REJECT_UNAUTHORIZED` is never touched: an appliance that cannot present a valid
      // certificate on its LAN address is still findable over plain HTTP, which is the honest
      // outcome — silently accepting an unverified certificate would be worse than not using TLS.
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const body = (await response.json()) as { isCiHub?: unknown; nodeFqdn?: unknown };
      return {
        isCiHub: body.isCiHub === true,
        nodeFqdn: typeof body.nodeFqdn === 'string' ? body.nodeFqdn : null,
      };
    } catch (error) {
      this.logger.debug(`[HubPool] manual probe of ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

interface IdentifyAnswer {
  isCiHub: boolean;
  nodeFqdn: string | null;
  authority: string;
  https: boolean;
}

function truncate(value: string): string {
  return value.slice(0, MAX_REMOTE_STRING_LENGTH);
}

/**
 * Fold both candidate sources into one list, so a node reachable both ways is offered once.
 *
 * **The merge key is the normalized `nodeFqdn`, and only that.** Not a UUID the far side told us
 * about: `/identify` is unauthenticated, so anything reachable on the network can claim any UUID it
 * likes, and keying on one would hand a hostile box a peer-suppression primitive (claim a real
 * node's UUID, and that node stops appearing in the operator's list). The FQDN is a name the tailnet
 * control plane also attests, and the Tailscale entry's copy of it wins on a merge because it is the
 * name the authenticated transport will actually dial.
 *
 * The *authenticated* UUID — `hub_pool_peer.peer_node_uuid`, learned from a guarded
 * `/capabilities` response — is a different value with a different trust story, and the two must
 * never meet. That is why {@link DiscoverablePoolPeer.claimedNodeUuid} is typed apart from it.
 *
 * Pure and exported so the dedupe rules are testable with no I/O.
 */
export function mergePoolCandidates(tailscale: DiscoverablePoolPeer[], manual: DiscoverablePoolPeer[]): DiscoverablePoolPeer[] {
  const merged = new Map<string, DiscoverablePoolPeer>();

  for (const candidate of [...tailscale, ...manual]) {
    const key = normalizePeerFqdn(candidate.nodeFqdn) ?? candidate.nodeFqdn.trim().toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    // Tailscale entries are inserted first, so an existing entry always wins on identity. Only the
    // Tailscale device id is worth back-filling, and only when the winner lacks one.
    if (!existing.tailscaleDeviceId && candidate.tailscaleDeviceId) {
      merged.set(key, { ...existing, tailscaleDeviceId: candidate.tailscaleDeviceId });
    }
  }

  return [...merged.values()];
}
