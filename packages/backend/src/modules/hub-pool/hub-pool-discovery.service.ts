import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException, Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { isPoolProbeTarget } from '@/common/helpers/ip-address';
import { formatProbeAuthority, parseProbeTarget, poolProbePortCandidates, type PoolProbeTarget } from '@/common/helpers/hub-pool-probe';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerService } from './hub-pool-peer.service';
import { MIN_PAIR_BY_ADDRESS_PROTOCOL } from './hub-pool-peer-auth';
import type { DiscoverablePoolPeer, PoolProbeResult } from './hub-pool.types';

/** Matches `DISCOVERY_PROBE_TIMEOUT_MS` in `hub-pool-peer.service.ts` — the same probe, over a different route. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Candidate discovery: the Tailscale Admin API directory, plus pairing with a Hub found at an
 * operator-typed address.
 *
 * The point of the address half is that pairing no longer *requires* a Tailscale OAuth client. Two
 * Hubs on one LAN and one tailnet can already reach each other perfectly; until now the only way to
 * enumerate them was a credential the operator had to go and create. Typing `192.168.1.42` once,
 * with the PIN from the other Hub's screen, replaces that.
 *
 * **What an address is, and is not.** It is a way to reach the pairing handshake, and nothing more.
 * The probe cannot name the node — `GET /identify` is unauthenticated and published through the
 * Cloudflare tunnel, so it answers `{ isCiHub, poolProtocol }` and deliberately not this Hub's
 * MagicDNS name. The name is disclosed in the reply to a PIN-authenticated `pair/request`, and from
 * that moment on the address is discarded: pairing callbacks, health polling and every proxied
 * request go to `https://<fqdn>`, with the same TLS check and the same credentials on the same
 * WireGuard transport. That is why `normalizePeerFqdn` can go on refusing IP literals for anything
 * that gets stored, and why an address never appears in {@link DiscoverablePoolPeer}.
 */
@Injectable()
export class HubPoolDiscoveryService {
  constructor(
    private readonly logger: LoggerService,
    private readonly peerService: HubPoolPeerService,
  ) {}

  /**
   * Probe one operator-typed address and report what is there.
   *
   * The answer is deliberately thin — reachable, is it a CI-Hub, what protocol — because that is
   * everything an unauthenticated `/identify` will say. It is a diagnostic that tells the operator
   * whether {@link pairAtAddress} is worth trying, not a directory lookup that names a node.
   *
   * SSRF containment: the host is resolved up front and EVERY resolved address must be a private or
   * CGNAT one ({@link isPoolProbeTarget}), so a name that resolves to a public address is refused
   * rather than fetched. There is a residual rebinding window between the check and the fetch; it is
   * not closed, because this route is operator-authenticated, carries no credential outbound, and
   * only a boolean and a small integer survive from the response. That is a stated limit, not an
   * oversight.
   */
  async probeAddress(rawAddress: string): Promise<PoolProbeResult> {
    const { target, address } = await this.resolveProbeTarget(rawAddress);

    const answer = await this.fetchIdentify(target);
    if (!answer) {
      return { address, isCiHub: false, poolProtocol: null, pairable: false, reason: 'unreachable' };
    }
    if (!answer.isCiHub) {
      return { address, isCiHub: false, poolProtocol: answer.poolProtocol, pairable: false, reason: 'not_a_hub' };
    }
    // A protocol-1 Hub ignores a PIN and answers `{ received: true }`, so it can never tell this
    // node its name — pairing with it has to go the tailnet-name route. Saying so here beats letting
    // the operator discover it from a failed pairing.
    if ((answer.poolProtocol ?? 1) < MIN_PAIR_BY_ADDRESS_PROTOCOL) {
      return { address, isCiHub: true, poolProtocol: answer.poolProtocol, pairable: false, reason: 'protocol_too_old' };
    }

    return { address, isCiHub: true, poolProtocol: answer.poolProtocol, pairable: true, reason: null };
  }

  /**
   * Pair with the Hub at an operator-typed address, using the PIN minted on its own screen.
   *
   * The address is re-resolved and re-probed here rather than trusted from an earlier probe: the
   * private-address check has to hold for the request that actually carries this node's pairing
   * token, and the port ladder has to be walked again anyway to know which authority answers.
   * `HubPoolPeerService` does the rest — it is the owner of every peer row and of the handshake.
   */
  async pairAtAddress(rawAddress: string, displayName: string | undefined, pin: string): Promise<HubPoolPeer> {
    const { target, address } = await this.resolveProbeTarget(rawAddress);

    const answer = await this.fetchIdentify(target);
    if (!answer?.isCiHub) {
      throw new BadRequestException(
        answer
          ? `Something answered at ${address}, but it is not a CI-Hub.`
          : `Nothing answered at ${address}. Check the Hub is running, and name its published port if it moved: <address>:<port>.`,
      );
    }

    return this.peerService.initiatePairingAtAddress(`${answer.https ? 'https' : 'http'}://${answer.authority}`, displayName, pin);
  }

  /**
   * Every candidate this node can offer to pair with **by name**.
   *
   * Tailscale Admin API discovery is the only source, and that is not an oversight: this list is
   * consumed by handing an entry's `nodeFqdn` to `POST peers/pair`, and a probed address has no name
   * to put there. Manually found Hubs are paired with through {@link pairAtAddress} instead. Adding
   * unnamed rows here would mean a second identity space alongside `node_fqdn` — and one keyed on
   * something an unauthenticated responder chose, which is precisely what the peer table refuses to
   * do anywhere else.
   *
   * Issues no I/O of its own beyond that directory call, so a Hub with no Tailscale credential and
   * no peers makes exactly zero background network calls for discovery.
   */
  async listDiscoverableNodes(): Promise<DiscoverablePoolPeer[]> {
    return this.peerService.listDiscoverableDevices();
  }

  /** Parse the operator's input and prove every address it resolves to is one this node may dial. */
  private async resolveProbeTarget(rawAddress: string): Promise<{ target: PoolProbeTarget; address: string }> {
    const target = parseProbeTarget(rawAddress);
    if (!target) {
      throw new BadRequestException('Enter an address like 192.168.1.42, 192.168.1.42:5002, or a hostname');
    }
    await this.assertProbeTargetIsPrivate(target.host);
    return { target, address: target.port === null ? target.host : formatProbeAuthority(target, target.port) };
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

  private async tryIdentify(authority: string, https: boolean): Promise<{ isCiHub: boolean; poolProtocol: number | null } | null> {
    const url = `${https ? 'https' : 'http'}://${authority}/api/inference/pool/identify`;
    try {
      // `NODE_TLS_REJECT_UNAUTHORIZED` is never touched: an appliance that cannot present a valid
      // certificate on its LAN address is still findable over plain HTTP, which is the honest
      // outcome — silently accepting an unverified certificate would be worse than not using TLS.
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!response.ok) return null;
      const body = (await response.json()) as { isCiHub?: unknown; poolProtocol?: unknown };
      return {
        isCiHub: body.isCiHub === true,
        // A protocol-1 Hub omits the field entirely; `null` is "it did not say", which the caller
        // reads as pre-2 rather than guessing a number for it.
        poolProtocol: typeof body.poolProtocol === 'number' && Number.isInteger(body.poolProtocol) ? body.poolProtocol : null,
      };
    } catch (error) {
      this.logger.debug(`[HubPool] manual probe of ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

interface IdentifyAnswer {
  isCiHub: boolean;
  poolProtocol: number | null;
  authority: string;
  https: boolean;
}
