import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import {
  bearerUpgradeGraceMs,
  CAPABILITIES_FRESHNESS_POLLS,
  clampContainerRollup,
  clampPromptCeiling,
  describeHubPoolDisabled,
  effectivePeerPressureBand,
  isCapabilitiesSnapshotFresh,
  isMdnsPeerName,
  MDNS_PEER_NAME_PAIRING_REFUSAL,
  normalizePeerFqdn,
  POOL_CONTAINER_SAMPLER,
  resolveHubPoolDirections,
  resolveHubPoolEnabled,
  resolvePoolMaxPromptTokens,
  type HubPoolDirectionalState,
  type HubPoolEnabledState,
  type HubPoolInboundRefusal,
  type PoolContainerRollup,
  type PoolContainerSampler,
} from '@/common/helpers/hub-pool';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
import { clampOllamaSlots } from '@/common/helpers/inference-ollama-slots';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService, type TailscaleDevice } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import { HubPoolIdentityService } from './hub-pool-identity.service';
import { HubPoolPairingPinService, type PinAttemptSource } from './hub-pool-pairing-pin.service';
import {
  buildSignedPoolHeaders,
  MIN_PAIR_BY_ADDRESS_PROTOCOL,
  POOL_PEER_HEADER,
  POOL_REFUSAL_HEADER,
  POOL_SIGNATURE_HEADER,
  publicKeyFingerprint,
} from './hub-pool-peer-auth';
import { classifyProbeFailure, PoolProbeHttpError, type PoolPeerProbeFailure, probeBackoffMs, probeFailureAction } from './hub-pool-probe-failure';
import { HubPoolPressureService } from './hub-pool-pressure.service';
import { HubPoolThroughputService, readAdvertisedThroughput } from './hub-pool-throughput.service';
import {
  resolveStatusPins,
  toPublicPeer,
  type DiscoverablePoolPeer,
  type PoolPairingAnswer,
  type PoolPeerCapabilities,
  type PoolStatus,
  type PoolIdentitySummary,
  type PoolStatusLocalNode,
  type PoolStatusPeer,
  type PoolStatusPeerThroughput,
  type PoolStatusReason,
} from './hub-pool.types';
import { parseDbTimestampMs } from '@/common/helpers/db-timestamp';

/**
 * The reason a peer gave for declining a pairing request, when it gave one.
 *
 * Nest serializes an `HttpException` as `{ message, statusCode }`; `error` is the fallback shape.
 * Bounded, because this string is authored by the far end and ends up in an operator-facing message.
 */
async function peerRefusalDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const detail = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null;
    return detail ? detail.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Consecutive failed capability probes before a connected peer is marked unreachable (matches the 3-strikes convention in registration.service.ts). */
const UNREACHABLE_THRESHOLD = 3;
const DISCOVERY_PROBE_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Budget for a peer's capabilities probe.
 *
 * Raised from 8s because 8s was under the observed cold cost of the very thing it fetches: on a
 * loaded appliance the first `pool/status` after cache expiry took 10.0s to rebuild the backend
 * inventory (0.004s warm). Three of those in a row is all it takes to mark a healthy node
 * unreachable, which is exactly what happened to a live pair. {@link OWN_INVENTORY_TTL_MS} now
 * keeps a served snapshot warm so this ceiling is only reached on a genuinely cold node, and the
 * structural fix — splitting liveness off the inventory route entirely — is still worth doing.
 */
const CAPABILITIES_PROBE_TIMEOUT_MS = 15_000;
/**
 * Ceiling on inbound `pending` rows. They are created by unauthenticated callers and outlive the
 * request, so without a cap the table is an anonymous write primitive; with one, the worst an
 * attacker achieves is filling the operator's approval list until the sweep below drains it.
 */
const MAX_PENDING_INBOUND_REQUESTS = 20;
/** How long an unanswered inbound request survives. Long enough for an operator to notice it the next day, short enough that a squatted FQDN unblocks itself. */
const PENDING_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long this node's own model inventory is reused before it is rebuilt.
 *
 * `getOwnCapabilities` fans out to twelve uncached backend health checks (`getStatus` and
 * `listModels` each probe all six), so it must not run once per caller: it is hit by every peer's
 * 30s health probe *and* by the operator status endpoint, which the UI polls. Only the inventory is
 * cached — `inFlightRequests` and `updatedAt` are stamped live on every read, since a stale load
 * figure is the one thing that would actually mis-route work.
 *
 * This TTL used to be described as "deliberately shorter than the default poll interval so a peer
 * probe still gets a freshly built inventory". That trade was backwards, and it is reversed here on
 * evidence. Being 20s under a 30s poll meant the cache was ALWAYS expired when a peer arrived, so
 * every probe paid the full cold rebuild — 10.0s on a loaded appliance — and three consecutive
 * overruns mark a healthy node unreachable. A model list up to a poll old costs nothing; being
 * evicted from the pool costs everything. So the TTL is now the point at which a refresh is
 * TRIGGERED, not the point at which callers start blocking: see the stale-while-revalidate read in
 * `getOwnInventory`.
 */
const OWN_INVENTORY_TTL_MS = 20_000;
/**
 * Hard ceiling on serving a stale inventory. Past this a caller blocks on a rebuild rather than
 * being handed an ancient snapshot, so a node whose refresh keeps failing degrades into slow probes
 * instead of silently advertising models it may no longer hold.
 */
const OWN_INVENTORY_MAX_STALE_MS = 120_000;

/** The expensive-to-build half of {@link PoolPeerCapabilities} — everything that isn't a live counter. */
type OwnInventory = Pick<PoolPeerCapabilities, 'hardwareTier' | 'backends'>;

/**
 * Pairing lifecycle + health polling for sibling Hub nodes ("peers") reachable
 * over Tailscale. See `hub_pool_peer` in schema.ts for the token model.
 */
@Injectable()
export class HubPoolPeerService implements OnModuleInit, OnModuleDestroy {
  private timerHandle: NodeJS.Timeout | null = null;
  private stopped = false;
  private ownInventoryCache: { value: OwnInventory; expiresAt: number } | null = null;
  private ownInventoryInFlight: Promise<OwnInventory> | null = null;
  private containerSampler: PoolContainerSampler | null = null;
  private containerSamplerWarned = false;
  /**
   * Each failing peer's current run of probe failures, keyed by row id.
   *
   * In memory on purpose. The only consumers are this process's poll and its `/pool/status`, and a
   * restart costs one probe to rebuild it. Persisting it would need a migration for a value whose
   * whole meaning is "what the last few probes saw".
   */
  private readonly probeFailures = new Map<string, PoolPeerProbeFailure>();

  constructor(
    private readonly logger: LoggerService,
    private readonly repo: HubPoolPeerRepository,
    private readonly tailscaleService: TailscaleService,
    private readonly tailscaleAdminApi: TailscaleAdminApiService,
    private readonly encryption: EncryptionService,
    @Inject(forwardRef(() => InferenceRouterService))
    private readonly inferenceRouter: InferenceRouterService,
    private readonly loadService: HubPoolLoadService,
    private readonly configuration: ConfigurationService,
    private readonly identity: HubPoolIdentityService,
    private readonly pairingPins: HubPoolPairingPinService,
    private readonly pressureService: HubPoolPressureService,
    /**
     * Only ever used to reach {@link POOL_CONTAINER_SAMPLER}, which `AppsModule` provides. Injecting
     * `AppRuntimeMonitorService` directly would need a `HubPoolModule -> AppsModule` import, closing
     * a second Nest cycle and dragging the whole apps graph in here; the lazy non-strict lookup is
     * the shape this repo already uses for exactly that problem.
     *
     * `@Optional()` so every direct-construction test harness keeps compiling and constructing this
     * service can never depend on module resolution order — an unresolvable sampler degrades to "no
     * sample", which is an omitted key.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
    /**
     * Where the proxy keeps what it has timed. `@Optional()` for the positional harnesses; without it
     * this node advertises no throughput and status reports none, which is what an unmeasured node is.
     */
    @Optional() private readonly throughput?: HubPoolThroughputService,
  ) {}

  onModuleInit(): void {
    this.scheduleNextTick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * Self-rescheduling rather than a `setInterval`, so the interval is re-read from settings on every
   * tick: retuning `poolHealthPollSeconds` takes effect on the next poll instead of the next
   * restart, with no separate "the setting changed, re-arm the timer" path to keep correct. Chaining
   * after the work also means a slow round of probes can never stack overlapping ticks.
   */
  private scheduleNextTick(): void {
    this.timerHandle = setTimeout(() => {
      void (async () => {
        try {
          this.pairingPins.sweep();
          await Promise.all([this.refreshPeerHealth(), this.sweepExpiredPendingRequests()]);
        } catch (error) {
          this.logger.warn(`[HubPool] health tick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!this.stopped) {
          this.scheduleNextTick();
        }
      })();
    }, this.healthPollIntervalMs());
  }

  private healthPollIntervalMs(): number {
    return this.configuration.getHubPoolPreferences().poolHealthPollSeconds * 1000;
  }

  /** Effective master kill-switch state: the `.env` override, then the persisted setting. */
  enabledState(): HubPoolEnabledState {
    return resolveHubPoolEnabled(this.configuration.getHubPoolPreferences().poolEnabled);
  }

  /**
   * Effective state of each half of pooling. Read per call, never cached — a settings PATCH must
   * take effect on the next request, and `resolveHubPoolDirections` is the single place the
   * precedence between the master, the two env vars and the two persisted flags is decided.
   */
  directions(): HubPoolDirectionalState {
    return resolveHubPoolDirections(this.configuration.getHubPoolPreferences());
  }

  async listPeers(): Promise<HubPoolPeer[]> {
    return this.repo.listAll();
  }

  async getPeerById(id: string): Promise<HubPoolPeer | undefined> {
    return this.repo.findById(id);
  }

  /**
   * Every `connected` peer row, kill switches NOT applied.
   *
   * Deliberately unfiltered, and this is load-bearing. Its only two callers ask different
   * questions: `PoolProxyService.buildCandidateList` asks "where may this request go right now",
   * and `hasConnectedPeers()` asks "does this Hub have peers at all" — an answer
   * `inference-env-resolver.ts` bakes into an app's `CI_LLM_BASE_URL` at INSTALL time. Filtering
   * the outbound switch or a per-peer disable in here would make every app created during a
   * temporary routing decision point permanently at a direct backend URL, surviving the switch
   * being turned back on. The routing filter therefore lives on the request path, in
   * `PoolProxyService`; see its `usablePeers()`.
   */
  async listConnectedPeers(): Promise<HubPoolPeer[]> {
    return this.repo.listByStatus('connected');
  }

  async hasConnectedPeers(): Promise<boolean> {
    if (!this.enabledState().enabled) {
      return false;
    }
    return (await this.listConnectedPeers()).length > 0;
  }

  /**
   * Why this node is refusing to serve `peer`'s work right now, or `null` when it will serve.
   *
   * Only the two finer switches land here. The master switch is handled before this, and answers
   * 503 on the capability probe so peers mark this node unreachable — that is "I have left the
   * pool". These two mean "still here, still using you, just not serving", which must leave the
   * peer's health poll succeeding and its `lastSeenAt` fresh.
   */
  inboundRefusal(peer: HubPoolPeer): HubPoolInboundRefusal | null {
    // `=== false`, not truthiness: the column is NOT NULL DEFAULT true, so only an explicit
    // operator decision may refuse a peer — never a row that somehow reaches us without the field.
    if (peer.enabled === false) {
      return 'peer_disabled';
    }
    return this.directions().inbound.enabled ? null : 'inbound_disabled';
  }

  /**
   * Operator switch: take one peer in or out of routing, in both directions at once.
   *
   * Symmetric by decision — one checkbox, one meaning. A 2×N space of per-peer directional
   * switches is not something an operator can hold in their head, and the two global axes already
   * express the only asymmetry anyone has asked for ("I will give but not take").
   *
   * Pairing, both directional tokens and the health poll are untouched, so this is instantly
   * reversible and needs no re-approval. It is therefore NOT a revocation: an operator who wants
   * the token gone must still Unpair, and the UI copy has to keep the two apart.
   */
  async setPeerEnabled(id: string, enabled: boolean): Promise<HubPoolPeer> {
    const updated = await this.repo.update(id, { enabled });
    if (!updated) {
      throw new NotFoundException('No pool peer with that id');
    }
    this.logger.info(`[HubPool] peer ${updated.nodeFqdn} ${enabled ? 'enabled' : 'disabled'} for pooling by the operator`);
    return updated;
  }

  /** Raw bearer token this Hub presents when calling `peer` — decrypted on demand, never cached. */
  async getPresentToken(peer: HubPoolPeer): Promise<string> {
    if (!peer.presentTokenEncrypted) {
      throw new Error(`No outbound pairing token stored for peer ${peer.nodeFqdn}`);
    }
    return this.encryption.decrypt(peer.presentTokenEncrypted, peer.nodeFqdn);
  }

  /**
   * THE only place either peer credential is attached to an outbound request.
   *
   * Consolidating this is the highest-leverage part of the change: the credential used to be built
   * at five separate call sites, and the guard's rule about which one is acceptable would have had
   * to be restated — and kept in step — at every one of them. One helper means the client rule and
   * the guard rule cannot drift apart.
   *
   * The choice, in order:
   *   - Signed, whenever this node can sign and has the peer's key pinned. The normal case.
   *   - Bearer, while `bearerGraceUntil` is live. Set only by the side that learned the peer's key
   *     from a request it RECEIVED, which is the side that cannot know whether its own reply — the
   *     one carrying this node's key — actually arrived. Presenting a signature the peer cannot
   *     verify would strand the pairing; presenting the bearer costs one more poll.
   *   - Bearer, when there is no identity to sign with (no key yet). This is the branch that keeps
   *     a mixed-version fleet routing. It is NOT a way out for a private key this node can no
   *     longer decrypt: `getPresentToken` decrypts with the same key, so a regenerated `.env` needs
   *     `rotateIdentity` and fresh pairings — see docs/hub-pool.md "Failure modes".
   *
   * `poolRequireSignedPeers` removes the bearer branch entirely, on this side as well as the guard's.
   */
  async peerAuthHeaders(
    peer: HubPoolPeer,
    method: string,
    path: string,
    body?: unknown,
    options: { preferSigned?: boolean } = {},
  ): Promise<Record<string, string>> {
    const selfStatus = await this.tailscaleService.getStatusCached();
    const self = await this.identity.get();
    const requireSigned = this.configuration.getHubPoolPreferences().poolRequireSignedPeers;
    const privateKey = self?.privateKey ?? null;
    const recipientNodeUuid = peer.peerNodeUuid;
    const graceLive = peer.bearerGraceUntil !== null && Date.parse(peer.bearerGraceUntil) > Date.now();
    // The grace window exists to fall back to the bearer while the peer may not hold our key yet.
    // With the bearer forbidden there is nothing to fall back to, and holding the signature back
    // only guarantees the request fails: every PIN pairing's confirm callback from a node requiring
    // signed peers was refused this way (fleet, 2026-09-23), though the peer had learned our key
    // from the PIN response and would have verified it. The callback is never retried, so the
    // joining node's row stayed `pending` for good.
    const holdForGrace = graceLive && Boolean(peer.presentTokenEncrypted) && !requireSigned && !options.preferSigned;

    if (self && privateKey && recipientNodeUuid && peer.peerPublicKey && !holdForGrace) {
      return buildSignedPoolHeaders(privateKey, {
        method,
        path,
        senderNodeUuid: self.nodeUuid,
        senderNodeFqdn: selfStatus.nodeFqdn ?? '',
        recipientNodeUuid,
        body,
      });
    }

    if (requireSigned) {
      throw new ForbiddenException(`This node requires signed pool peers and cannot yet sign requests to ${peer.nodeFqdn}`);
    }

    const token = await this.getPresentToken(peer);
    return { [POOL_PEER_HEADER]: selfStatus.nodeFqdn ?? '', Authorization: `Bearer ${token}` };
  }

  /** How a peer authenticates to this node today, for the operator surfaces. */
  private authModeOf(peer: HubPoolPeer): PoolStatusPeer['authMode'] {
    return peer.peerNodeUuid && peer.peerPublicKey ? 'signed' : 'bearer';
  }

  /**
   * Tailnet devices that identify themselves as CI-Hub nodes (via their
   * already-published `/inference/pool/identify`) and aren't paired/pairing
   * with this Hub yet.
   */
  async listDiscoverableDevices(): Promise<DiscoverablePoolPeer[]> {
    const selfStatus = await this.tailscaleService.getStatusCached();
    if (!selfStatus.connected && !this.tailscaleAdminApi.isConfigured()) {
      return [];
    }

    const candidateMap = new Map<string, { id: string; name: string; hostname: string }>();

    // 1. From local Tailscale daemon peer map (zero-config, no OAuth needed)
    for (const peer of selfStatus.peers ?? []) {
      if (peer.nodeFqdn && peer.nodeFqdn !== selfStatus.nodeFqdn) {
        candidateMap.set(peer.nodeFqdn, {
          id: peer.id ?? '',
          name: peer.nodeFqdn,
          hostname: peer.hostname ?? peer.nodeFqdn,
        });
      }
    }

    // 2. From Tailscale Admin API (if configured)
    if (this.tailscaleAdminApi.isConfigured() && selfStatus.tailnet) {
      try {
        const adminDevices = await this.tailscaleAdminApi.listDevices(selfStatus.tailnet);
        for (const device of adminDevices) {
          if (device.name && device.name !== selfStatus.nodeFqdn) {
            candidateMap.set(device.name, {
              id: device.id,
              name: device.name,
              hostname: device.hostname,
            });
          }
        }
      } catch (error) {
        this.logger.debug(`[HubPool] Admin API listDevices failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (candidateMap.size === 0) {
      return [];
    }

    const existingPeers = await this.repo.listAll();
    const known = new Set(existingPeers.map((p) => p.nodeFqdn));
    const candidates = [...candidateMap.values()].filter((d) => d.name && !known.has(d.name));

    const probed = await Promise.all(
      candidates.map(async (device): Promise<DiscoverablePoolPeer | null> => {
        try {
          const response = await fetch(`https://${device.name}/api/inference/pool/identify`, {
            signal: AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS),
          });
          if (!response.ok) return null;
          const body = (await response.json()) as { isCiHub?: boolean };
          if (!body.isCiHub) return null;
          return { tailscaleDeviceId: device.id, nodeFqdn: device.name, hostname: device.hostname };
        } catch (error) {
          this.logger.debug(`[HubPool] discovery probe for ${device.name} failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );

    return probed.filter((d): d is DiscoverablePoolPeer => d !== null);
  }

  /**
   * Everything the operator UI and CLI need in one poll: whether pooling is on and why, whether this
   * node is on a tailnet and whether it can enumerate the whole one, this node's own identity and
   * inventory, and every peer with its live queue depth — plus the operator's routing pins, each
   * resolved to a node name and to whether it can take work right now.
   *
   * `tailscaleAdminApiConfigured` here is the Admin API credential and nothing more: discovery has
   * two other directories that need no credential (the local daemon's peer map, the CI Portal
   * registry), so this response can neither confirm nor deny that discovery works.
   *
   * Deliberately cheap enough to poll: one `listAll()` SELECT, in-memory counters, two env reads,
   * the 30s-cached Tailscale status, and the {@link OWN_INVENTORY_TTL_MS}-cached local inventory.
   * It never calls `listDiscoverableDevices` (an HTTPS probe per unpaired tailnet candidate, all
   * uncached, and a Tailscale OAuth exchange on top when an Admin API credential is configured —
   * being connected to the tailnet is enough to pay the probes), and the route that wraps it,
   * `GET peers/discoverable`, adds a Portal dispatch call and a probe per named Portal device on
   * top. It never re-probes peers either — peer capabilities are read from the `lastCapabilities`
   * the health poll already cached. Pins add no query at all: they live in settings.json, and their
   * availability is computed from the peers and inventory already loaded.
   */
  async getPoolStatus(): Promise<PoolStatus> {
    const enabled = this.enabledState();
    const [peers, selfStatus, localNode, identity] = await Promise.all([
      this.repo.listAll(),
      this.tailscaleService.getStatusCached(),
      this.buildLocalNodeStatus(),
      this.identity.summary(),
    ]);

    const directions = this.directions();
    const connected = peers.filter((p) => p.status === 'connected').length;
    // Peers this node would actually send work to. Reduces to `connected` when nothing is disabled,
    // which is what keeps every default byte-identical to the previous build.
    const usable = peers.filter((p) => p.status === 'connected' && p.enabled !== false).length;
    // A node with a direction switched off, or with every connected peer individually disabled, is
    // NOT 'active' — it half-participates, and saying "active" there is exactly the lie an operator
    // would debug for an hour. `no_peers` still means "nothing is paired", not "nothing is usable".
    const partiallyDisabled = !directions.outbound.enabled || !directions.inbound.enabled || (connected > 0 && usable === 0);
    const reason: PoolStatusReason = enabled.enabled
      ? partiallyDisabled
        ? 'partially_disabled'
        : connected > 0
          ? 'active'
          : 'no_peers'
      : enabled.disabledBy === 'env'
        ? 'disabled_by_env'
        : 'disabled_by_setting';

    return {
      enabled: enabled.enabled,
      disabledBy: enabled.disabledBy,
      directions,
      reason,
      routingActive: directions.outbound.enabled && usable > 0,
      settings: this.configuration.getHubPoolPreferences(),
      tailscaleAdminApiConfigured: this.tailscaleAdminApi.isConfigured(),
      localNode: {
        ...localNode,
        nodeFqdn: selfStatus.nodeFqdn,
        tailnet: selfStatus.tailnet,
        tailscaleConnected: selfStatus.connected,
        // After the first load this is a cache read — `HubPoolIdentityService.summary()` memoizes,
        // and a Hub whose identity is broken pays one query a minute at most. That is what keeps
        // `getPoolStatus`'s "cheap enough for the UI to poll" promise, and the whole status card
        // usable, without ever putting a probe or a keygen on this path.
        identity,
        ...this.localPromptCeilingStatus(),
        maxNumCtx: this.configuration.getInferencePreferences()?.maxNumCtx ?? null,
        ollamaSlots: this.configuration.getInferencePreferences()?.ollamaSlots ?? null,
        throughput: this.throughput?.estimatesFor(LOCAL_CANDIDATE_KEY) ?? [],
      },
      // `peerKeyFingerprint`, never the key: the fingerprint is what an operator compares across two
      // screens when confirming a pairing, and the full key is only ever needed in-process.
      peers: peers.map((peer) => ({
        ...toPublicPeer(peer),
        // Why a peer is failing, not only that it is. `unreachable` alone sent operators looking for a
        // network fault on a node that answered every probe, just not as the Hub they had paired.
        probeFailure: this.probeFailures.get(peer.id) ?? null,
        inFlightRequests: this.loadService.get(peer.id),
        authMode: this.authModeOf(peer),
        peerKeyFingerprint: publicKeyFingerprint(peer.peerPublicKey),
        // The EFFECTIVE band the ranker would use — freshness applied, hostile values clamped, our
        // own forwarded count as a floor — not the raw jsonb. Showing the operator a number routing
        // does not believe is how a status page becomes a liability during an incident.
        gpuPressure: this.effectivePeerPressure(peer),
        // Clamped and freshness-gated, never the raw jsonb, for the reason directly above: this is
        // a remote machine's self-report about itself. `null` reads as "not reported", never as 0.
        containers: this.peerContainers(peer),
        // Through the same clamp the ranker reads it with, so a value routing ignores shows as none.
        maxPromptTokens: clampPromptCeiling((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.maxPromptTokens),
        maxNumCtx: this.peerContextCap(peer),
        ollamaSlots: clampOllamaSlots((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.ollamaSlots),
        throughput: this.peerThroughput(peer),
      })),
      peerCounts: {
        total: peers.length,
        connected,
        pending: peers.filter((p) => p.status === 'pending').length,
        unreachable: peers.filter((p) => p.status === 'unreachable').length,
        // Counted across every status, not just `connected`: disabling is a routing decision and
        // says nothing about the lifecycle, so this deliberately overlaps the three counts above.
        disabled: peers.filter((p) => p.enabled === false).length,
      },
      // Resolved from the peers and the local inventory this call already loaded — no extra query,
      // and the availability shown is the one routing would actually see.
      pins: resolveStatusPins(this.configuration.getHubPoolPreferences().poolPins, peers, localNode.backends),
      pairingPin: this.pairingPins.state(),
    };
  }

  /**
   * A peer's throughput as routing reads it: what this node timed, and its own advert after the same
   * validation and ageing `PoolProxyService` applies. Not freshness-gated — evidence ages on its own
   * clock, and the ranker keeps using it while it lives.
   */
  private peerThroughput(peer: HubPoolPeer): PoolStatusPeerThroughput {
    const now = Date.now();
    return {
      observed: this.throughput?.estimatesFor(peer.id, now) ?? [],
      advertised: readAdvertisedThroughput(
        (peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.throughput,
        peer.lastSeenAt ? now - parseDbTimestampMs(peer.lastSeenAt) : Number.NaN,
      ),
    };
  }

  /** This node's effective prompt ceiling and its source, for `/pool/status`. Resolved per call, like every pool setting. */
  private localPromptCeilingStatus(): Pick<PoolStatusLocalNode, 'maxPromptTokens' | 'maxPromptTokensSetBy'> {
    const ceiling = resolvePoolMaxPromptTokens(this.configuration.getHubPoolPreferences().poolMaxPromptTokens);
    return { maxPromptTokens: ceiling.maxPromptTokens, maxPromptTokensSetBy: ceiling.setBy };
  }

  /**
   * The pressure band this node would actually rank a peer at, for `/pool/status`.
   *
   * Shares `effectivePeerPressureBand` and the freshness rule with `PoolProxyService.peerPressure`
   * rather than re-deriving them here: they are the same decision, and two copies is how the number
   * on the operator's screen quietly stops matching the number routing used.
   */
  private effectivePeerPressure(peer: HubPoolPeer): number | null {
    const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
    const freshnessMs = this.configuration.getHubPoolPreferences().poolHealthPollSeconds * 1000 * CAPABILITIES_FRESHNESS_POLLS;
    return effectivePeerPressureBand({
      reported: capabilities?.gpuPressure,
      snapshotFresh: isCapabilitiesSnapshotFresh(peer.lastSeenAt, freshnessMs),
      forwardedInFlight: this.loadService.get(peer.id),
    });
  }

  private async buildLocalNodeStatus(): Promise<Omit<PoolStatusLocalNode, 'nodeFqdn' | 'tailnet' | 'tailscaleConnected'>> {
    const inFlightRequests = this.loadService.localInFlight();
    // Read outside the try: a down backend must not take the pressure band with it, and this is a
    // field read on an in-memory sampler that cannot throw.
    const gpuPressure = this.pressureService.band();
    const gpuPressureSource = this.pressureService.source();
    try {
      const inventory = await this.getOwnInventory();
      return {
        inFlightRequests,
        hardwareTier: inventory.hardwareTier,
        backends: inventory.backends,
        capabilitiesError: null,
        gpuPressure,
        gpuPressureSource,
      };
    } catch (error) {
      // A down backend must not take the status card with it — the pairing and kill-switch halves
      // of this payload are exactly what an operator needs while inference is broken.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[HubPool] could not build local capabilities for pool status: ${message}`);
      return { inFlightRequests, hardwareTier: null, backends: [], capabilitiesError: message, gpuPressure, gpuPressureSource };
    }
  }

  /**
   * Operator-initiated: pair with a candidate peer.
   *
   * The bearer token is still minted and still sent, because the peer may be on protocol 1 and
   * because the legacy `pair/confirm` callback authenticates with it either way. `pin`, when the
   * operator has one from the other Hub's screen, additionally carries this node's identity — and a
   * peer that accepts it answers with its own, which is pinned here on the spot.
   */
  async initiatePairing(rawNodeFqdn: string, displayName?: string, pin?: string): Promise<HubPoolPeer> {
    const nodeFqdn = this.requireBareHostname(rawNodeFqdn);
    // Re-checked here, not only in the DTO, for the same reason the hostname shape is: this is the
    // method that dials the name with a fresh token (and the PIN), whoever called it.
    if (isMdnsPeerName(nodeFqdn)) {
      throw new BadRequestException(MDNS_PEER_NAME_PAIRING_REFUSAL);
    }
    const existing = await this.repo.findByNodeFqdn(nodeFqdn);
    if (existing) {
      throw new ConflictException(`Already paired or pairing with ${nodeFqdn}`);
    }

    const rawToken = randomBytes(32).toString('hex');
    const row = await this.repo.create({
      nodeFqdn,
      displayName: displayName ?? null,
      direction: 'outbound',
      status: 'pending',
      verifyTokenHash: this.hashToken(rawToken),
      presentTokenEncrypted: null,
      tailscaleDeviceId: null,
    });

    try {
      const answered = await this.sendPairingRequest(`https://${nodeFqdn}/api/inference/pool/pair/request`, rawToken, pin);
      // A protocol-1 peer answers `{ received: true }` and this pins nothing, which is correct.
      const pinned = await this.pinPeerIdentity(row, answered, { setGrace: false });
      return pinned ?? row;
    } catch (error) {
      await this.repo.delete(row.id);
      throw error;
    }
  }

  /**
   * Operator-initiated: pair with a Hub found at an address rather than by name.
   *
   * This is the half of "find a peer by address" that the unauthenticated probe cannot do.
   * `GET /identify` answers `{ isCiHub, poolProtocol }` and nothing else — the MagicDNS name was
   * taken off it because it is published through the Cloudflare tunnel — so the address alone can
   * never name the node, and a peer row keyed on `node_fqdn` cannot be built from it.
   *
   * The PIN is what closes that gap. The operator mints one on the far Hub's own screen; presenting
   * it here authenticates the request, and the far side's answer carries the name (plus its
   * identity) back. So the name still comes from the node itself, exactly as before, but only to a
   * caller that has demonstrably been in front of it.
   *
   * The row is created AFTER the exchange, unlike {@link initiatePairing}, for the obvious reason:
   * until the answer lands there is no name to key it on. `address` is used once, to reach the
   * handshake, and is never stored — pairing callbacks, the health poll and every proxied request go
   * to `https://<fqdn>` as they always have.
   */
  async initiatePairingAtAddress(origin: string, displayName: string | undefined, pin: string): Promise<HubPoolPeer> {
    const selfFqdn = await this.selfNodeFqdn();
    if (!selfFqdn) {
      // Checked here rather than letting the peer 400 on `fromNodeFqdn`: the peer's approval callback
      // dials `https://<our name>`, so a Hub with no tailnet name cannot complete a pairing it starts.
      throw new BadRequestException(
        'This Hub has not joined a tailnet yet, so a peer would have no name to answer on. Run `cihub tailscale up` here first.',
      );
    }

    const rawToken = randomBytes(32).toString('hex');
    const answered = await this.sendPairingRequest(`${origin}/api/inference/pool/pair/request`, rawToken, pin);

    const nodeFqdn = answered.nodeFqdn ? normalizePeerFqdn(answered.nodeFqdn) : null;
    if (!nodeFqdn) {
      // Either a protocol-1 Hub (which ignores the PIN and answers `{ received: true }`) or one that
      // has not joined a tailnet. Both are "there is no name to dial", which is the same verdict the
      // old probe gave — just reached at the point where the answer actually exists.
      throw new BadRequestException(
        `The Hub at ${origin} did not answer with a tailnet name. It has to be on a tailnet, and on pool protocol ${MIN_PAIR_BY_ADDRESS_PROTOCOL} or later, before it can be paired with by address.`,
      );
    }
    if (nodeFqdn === selfFqdn) {
      throw new ConflictException(`${origin} is this Hub`);
    }
    const existing = await this.repo.findByNodeFqdn(nodeFqdn);
    if (existing) {
      throw new ConflictException(`Already paired or pairing with ${nodeFqdn}`);
    }

    const row = await this.repo.create({
      nodeFqdn,
      displayName: displayName ?? null,
      direction: 'outbound',
      status: 'pending',
      verifyTokenHash: this.hashToken(rawToken),
      presentTokenEncrypted: null,
      tailscaleDeviceId: null,
    });
    const pinned = await this.pinPeerIdentity(row, answered, { setGrace: false });
    return pinned ?? row;
  }

  /**
   * POST one `pair/request` and return whatever identity the far side answered with.
   *
   * Shared by both entry points so the body is assembled in exactly one place: the two differ only
   * in the URL they dial and in whether a PIN is optional.
   */
  private async sendPairingRequest(url: string, rawToken: string, pin: string | undefined): Promise<PoolPairingAnswer> {
    const selfStatus = await this.tailscaleService.getStatusCached();
    const self = await this.identity.get();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromNodeFqdn: selfStatus.nodeFqdn,
        fromDisplayName: selfStatus.hostname ?? undefined,
        token: rawToken,
        ...(pin ? { pin } : {}),
        // The identity claim rides ONLY alongside a PIN: without one the peer would be storing a
        // claim it cannot authenticate, which is exactly the anonymous write the PIN exists to
        // close. A PIN with no local identity yet still goes on its own — the PIN is what
        // authenticates the request, not what the request carries.
        ...(pin && self ? { fromNodeUuid: self.nodeUuid, fromPublicKey: self.publicKey } : {}),
      }),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // A refused PIN is the one failure an operator can act on, and a bare status code hides it.
      if (pin !== undefined && (response.status === 401 || response.status === 403)) {
        throw new Error(`Peer refused the pairing PIN (${response.status}). Mint a fresh one on that Hub — a PIN is single-use and expires.`);
      }
      // Carry the peer's own reason through when it gave one. Pairing by address is the case that
      // needs it: the operator typed an address and has no other way to see what is at the far end.
      const detail = await peerRefusalDetail(response);
      throw new Error(`Peer declined pairing request (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json().catch(() => ({}))) as PoolPairingAnswer;
  }

  /**
   * Store a peer's claimed identity on its row.
   *
   * `setGrace` says which side of the exchange this node was on, and it is the whole subtlety of
   * the upgrade. Learning a peer's key from a REQUEST means this node still owes it a reply
   * carrying this node's own key — a reply that may not arrive — so the peer may still be on the
   * bearer token and the grace window has to be opened. Learning it from a RESPONSE means the peer
   * has already processed this node's key, so no grace is needed and signing can start at once.
   *
   * Returns the updated row, or `null` when the claim was absent or unusable.
   */
  private async pinPeerIdentity(
    peer: HubPoolPeer,
    claim: { nodeUuid?: string; publicKey?: string },
    options: { setGrace: boolean },
  ): Promise<HubPoolPeer | null> {
    if (!claim.nodeUuid || !claim.publicKey || publicKeyFingerprint(claim.publicKey) === null) {
      return null;
    }
    const graceMs = bearerUpgradeGraceMs(this.configuration.getHubPoolPreferences().poolHealthPollSeconds);
    try {
      // Pre-check the partial UNIQUE index rather than letting it raise. The catch below is still
      // the backstop, but a 23505 string tells an operator nothing; this case has exactly one cause
      // and exactly one remedy, and both belong in the log line. Left alone rather than merged:
      // both rows may hold live tokens, and silently deleting an operator's pairing is not this
      // poll's decision to make.
      const collision = await this.repo.findByNodeUuid(claim.nodeUuid);
      if (collision && collision.id !== peer.id) {
        this.logger.warn(
          `[HubPool] ${peer.nodeFqdn} and ${collision.nodeFqdn} report the same node UUID — the same machine appears to be paired twice. Unpair one.`,
        );
        return null;
      }
      const updated = await this.repo.update(peer.id, {
        peerNodeUuid: claim.nodeUuid,
        peerPublicKey: claim.publicKey,
        bearerGraceUntil: options.setGrace ? new Date(Date.now() + graceMs).toISOString() : null,
      });
      if (updated) {
        this.logger.info(`[HubPool] pinned ${peer.nodeFqdn} to pool identity ${claim.nodeUuid} (${publicKeyFingerprint(claim.publicKey)})`);
      }
      return updated ?? null;
    } catch (error) {
      // The partial unique index on `peer_node_uuid`: another row already claims this identity.
      // Logged rather than thrown, so a duplicate never fails a pairing that works fine on tokens.
      this.logger.warn(
        `[HubPool] could not pin ${peer.nodeFqdn} to pool identity ${claim.nodeUuid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * This node's own identity, as a peer-facing claim. Empty when there is no usable identity yet.
   *
   * Two spellings, and they are not interchangeable: a claim travelling in a REQUEST body is
   * `fromNodeUuid`/`fromPublicKey` (matching `fromNodeFqdn` alongside it), and one travelling in a
   * RESPONSE body is the bare `nodeUuid`/`publicKey`. Sending the wrong one is silent — the
   * receiving DTO's identity fields are optional by necessity, so the claim is simply dropped and
   * the pairing quietly stays on bearer tokens.
   */
  private async ownIdentityClaim(): Promise<{ nodeUuid: string; publicKey: string } | Record<string, never>> {
    const self = await this.identity.get();
    return self ? { nodeUuid: self.nodeUuid, publicKey: self.publicKey } : {};
  }

  /** {@link ownIdentityClaim} in the shape a request body uses. */
  private async ownIdentityClaimForRequest(): Promise<{ fromNodeUuid: string; fromPublicKey: string } | Record<string, never>> {
    const self = await this.identity.get();
    return self ? { fromNodeUuid: self.nodeUuid, fromPublicKey: self.publicKey } : {};
  }

  /**
   * Inbound `POST /inference/pool/pair/request` from a would-be peer — the only
   * unauthenticated write in the module, so every check that can be made without
   * established trust is made here: the kill switch, the hostname shape, the
   * pending-row ceiling, and tailnet membership where the Admin API can attest it.
   */
  async receivePairingRequest(
    rawFromNodeFqdn: string,
    fromDisplayName: string | undefined,
    token: string,
    claim: { fromNodeUuid?: string; fromPublicKey?: string; pin?: string; source?: PinAttemptSource } = {},
  ): Promise<PoolPairingAnswer> {
    const enabled = this.enabledState();
    if (!enabled.enabled) {
      throw new ServiceUnavailableException(describeHubPoolDisabled(enabled.disabledBy));
    }

    const fromNodeFqdn = this.requireBareHostname(rawFromNodeFqdn);

    // Before anything is created, and before the duplicate check: a wrong PIN must leave this node
    // in exactly the state it was in, and must not reveal whether a row for that name exists.
    if (claim.pin !== undefined) {
      this.pairingPins.consume(claim.pin, { claimedFqdn: fromNodeFqdn, ...claim.source });
    }

    // A Hub must never pair with itself, and the receiver is the one party that knows its own name
    // for certain — the initiator only learns it from the answer below, by which point an inbound
    // row would already exist. Refusing here is what keeps a self-probe from leaving a phantom
    // pending request behind. Checked after the PIN so the answer still does not depend on state.
    const selfFqdn = await this.selfNodeFqdn();
    if (selfFqdn && selfFqdn === fromNodeFqdn) {
      throw new BadRequestException('That address is this Hub — a Hub cannot pair with itself');
    }

    const existing = await this.repo.findByNodeFqdn(fromNodeFqdn);
    if (existing) {
      // A claim that came with a verified PIN is authenticated, so a UUID other than the one pinned here
      // proves the name now belongs to a new identity on its own. The probe verdict is only in memory,
      // and a restart forgets it until the next failed probe.
      const pinnedAnotherIdentity =
        claim.pin !== undefined && Boolean(claim.fromNodeUuid && existing.peerNodeUuid) && claim.fromNodeUuid !== existing.peerNodeUuid;
      if (pinnedAnotherIdentity || this.probeFailures.get(existing.id)?.kind === 'identity_changed') {
        // The half-followed re-pair: the far side minted a fresh pairing, but the stale row here still
        // holds the name. Without this line the request vanishes into the debug log and the far side
        // waits on a pending row that never gets an answer.
        this.logger.warn(
          `[HubPool] ignoring a pairing request from ${fromNodeFqdn}: this Hub still holds the stale pairing for its previous identity. Run cihub pool unpair ${fromNodeFqdn} here first.`,
        );
      }
      this.logger.debug(`[HubPool] ignoring duplicate pairing request from ${fromNodeFqdn} (already have a ${existing.status} row)`);
      // A verified PIN gets the same answer here as it would on a fresh request, deliberately. It
      // is what the caller is entitled to either way, and answering differently would have made
      // this route tell a PIN holder whether a row for that name exists — the very thing the
      // ordering above (consume the PIN before the lookup) exists to avoid. It is also what lets an
      // initiator pairing by address report "already paired with <name>" instead of a shrug.
      return claim.pin === undefined ? {} : this.ownPairingAnswer();
    }

    const pending = await this.repo.listByStatus('pending');
    if (pending.filter((row) => row.direction === 'inbound').length >= MAX_PENDING_INBOUND_REQUESTS) {
      this.logger.warn(
        `[HubPool] refusing pairing request from ${fromNodeFqdn}: ${MAX_PENDING_INBOUND_REQUESTS} inbound requests already await approval`,
      );
      throw new ServiceUnavailableException('Too many pairing requests are already awaiting approval on this node');
    }

    await this.assertTailnetMember(fromNodeFqdn);

    const row = await this.repo.create({
      nodeFqdn: fromNodeFqdn,
      displayName: fromDisplayName ?? null,
      direction: 'inbound',
      status: 'pending',
      verifyTokenHash: null,
      presentTokenEncrypted: this.encryption.encrypt(token, fromNodeFqdn),
      tailscaleDeviceId: null,
    });

    // The row lands `pending` either way — a PIN authenticates the REQUEST, it does not stand in for
    // the operator seeing who is asking. A PIN read aloud, or over a shoulder, would otherwise get
    // an unintended node fully connected and spending GPU with no name ever shown. The one thing the
    // PIN does buy here is that the identity claim is now authenticated, so it can be pinned; the
    // operator's confirm screen renders its fingerprint alongside the FQDN.
    if (claim.pin === undefined) {
      return {};
    }
    await this.pinPeerIdentity(row, { nodeUuid: claim.fromNodeUuid, publicKey: claim.fromPublicKey }, { setGrace: true });
    return this.ownPairingAnswer();
  }

  /**
   * What a PIN-authenticated `pair/request` is answered with.
   *
   * This node's identity, plus the one thing `GET /identify` deliberately no longer discloses: its
   * MagicDNS name. That single field is what makes pairing by address work — an initiator that
   * reached this Hub at `192.168.1.42` has no other way to learn the name every later call must be
   * addressed to — and the PIN is precisely the boundary it sits behind. An anonymous caller on the
   * tunnel-published `/identify` still learns nothing but the protocol version.
   *
   * Best-effort on the name: a Tailscale CLI that is briefly unavailable answers with the identity
   * halves alone rather than failing a pairing request over it.
   */
  private async ownPairingAnswer(): Promise<PoolPairingAnswer> {
    const nodeFqdn = await this.selfNodeFqdn();
    return { ...(nodeFqdn ? { nodeFqdn } : {}), ...(await this.ownIdentityClaim()) };
  }

  /**
   * This node's own MagicDNS name, canonicalized, or `null` when it has none.
   *
   * Never allowed to throw, for the same reason {@link tailnetSuffix} is not: a Tailscale CLI that is
   * briefly unavailable must not turn an inbound pairing request into a 500.
   */
  private async selfNodeFqdn(): Promise<string | null> {
    try {
      const selfStatus = await this.tailscaleService.getStatusCached();
      return selfStatus.nodeFqdn ? normalizePeerFqdn(selfStatus.nodeFqdn) : null;
    } catch (error) {
      this.logger.warn(`[HubPool] could not read this node's own tailnet name: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private requireBareHostname(raw: string): string {
    const normalized = normalizePeerFqdn(raw);
    if (!normalized) {
      throw new BadRequestException('Peer node FQDN must be a bare hostname (no scheme, credentials, port, path or IP literal)');
    }
    return normalized;
  }

  /**
   * Refuses a pairing request from a name that is not on this tailnet.
   *
   * Two checks, in order of what the node actually knows:
   *
   * 1. **The MagicDNS suffix**, which needs no credential at all — `TailscaleStatus.tailnet` comes
   *    from the local CLI. This is the one that matters now that peers can be found without a
   *    Tailscale OAuth client: previously the whole method returned immediately when the Admin API
   *    was unconfigured, so a credential-less Hub — the exact configuration manual peer entry
   *    exists to serve — had no membership check on either side of the handshake.
   * 2. **Admin API device membership**, when a credential is configured. Strictly stronger, since a
   *    suffix is only a string.
   *
   * Still degrades to a no-op when this node has no tailnet of its own: a Hub that never joined one
   * has nothing to compare against, and refusing there would break pairing on a configuration that
   * works today.
   */
  private async assertTailnetMember(nodeFqdn: string): Promise<void> {
    const selfTailnet = await this.tailnetSuffix();
    if (selfTailnet && !nodeFqdn.endsWith(`.${selfTailnet}`)) {
      this.logger.warn(`[HubPool] rejecting pairing request from ${nodeFqdn}: not a name on this tailnet (${selfTailnet})`);
      throw new ForbiddenException('Pairing requests are only accepted from devices on this tailnet');
    }

    if (!this.tailscaleAdminApi.isConfigured()) {
      return;
    }

    let devices: TailscaleDevice[];
    try {
      const selfStatus = await this.tailscaleService.getStatusCached();
      if (!selfStatus.tailnet) {
        return;
      }
      devices = await this.tailscaleAdminApi.listDevices(selfStatus.tailnet);
    } catch (error) {
      this.logger.warn(
        `[HubPool] could not verify tailnet membership for ${nodeFqdn}; accepting the request on the operator's judgement: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (!devices.some((device) => normalizePeerFqdn(device.name) === nodeFqdn)) {
      this.logger.warn(`[HubPool] rejecting pairing request from ${nodeFqdn}: not a device on this tailnet`);
      throw new ForbiddenException('Pairing requests are only accepted from devices on this tailnet');
    }
  }

  /**
   * This node's own MagicDNS suffix, or `null` when it has none.
   *
   * Read through the 30s-cached status and never allowed to throw: a Tailscale CLI that is briefly
   * unavailable must not turn every inbound pairing request into a 500. An unknown suffix means the
   * suffix check is skipped, which is the same "accept on the operator's judgement" posture the
   * Admin API leg already takes when it cannot reach the API.
   */
  private async tailnetSuffix(): Promise<string | null> {
    try {
      const status = await this.tailscaleService.getStatusCached();
      return status.tailnet
        ? status.tailnet
            .trim()
            .toLowerCase()
            .replace(/^\.+|\.+$/g, '') || null
        : null;
    } catch (error) {
      this.logger.warn(`[HubPool] could not read this node's tailnet: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Expires `pending` rows nothing ever answered, so a squatted FQDN cannot block pairing forever
   * and the table cannot grow without bound.
   *
   * Both directions are swept, and the outbound half is the correction. The previous filter kept
   * only `direction === 'inbound'` on the reasoning that outbound rows "are operator-created and are
   * cleaned up by the peer's reject callback or by Unpair" — which holds only when the far side ever
   * answers. It does not when the callback cannot land: `approvePairing` confirms back over
   * `https://<fqdn>`, so a peer without `tailscale serve` on 443 leaves the initiator holding a
   * `pending` row no callback will ever resolve. That row is permanent, it makes a re-pair attempt
   * answer 409 "already paired or pairing", and Unpair was the operator's only way out.
   *
   * Sweeping both halves also keeps the two sides symmetric: the inbound row on the far node expires
   * on the same TTL, so an unanswered request disappears from both tables at roughly the same time
   * rather than stranding one end.
   */
  private async sweepExpiredPendingRequests(): Promise<void> {
    const cutoff = Date.now() - PENDING_REQUEST_TTL_MS;
    const pending = await this.repo.listByStatus('pending');
    const expired = pending.filter((row) => parseDbTimestampMs(row.createdAt) < cutoff);

    for (const row of expired) {
      this.logger.info(`[HubPool] expiring unanswered ${row.direction} pairing request for ${row.nodeFqdn} (created ${row.createdAt})`);
      await this.repo.delete(row.id);
    }
  }

  /** Operator approves a pending inbound request — issues our half of the handshake and confirms to the peer. */
  async approvePairing(id: string): Promise<HubPoolPeer> {
    const row = await this.repo.findById(id);
    if (row?.direction !== 'inbound' || row.status !== 'pending') {
      throw new NotFoundException('No pending inbound pairing request with that id');
    }

    const rawToken = randomBytes(32).toString('hex');
    const updated = await this.repo.update(id, { status: 'connected', verifyTokenHash: this.hashToken(rawToken) });
    if (!updated) {
      throw new NotFoundException('Pairing request disappeared while approving');
    }

    try {
      const selfStatus = await this.tailscaleService.getStatusCached();
      const body = { fromNodeFqdn: selfStatus.nodeFqdn, token: rawToken, ...(await this.ownIdentityClaimForRequest()) };
      const path = '/api/inference/pool/pair/confirm';
      const send = async (headers: Record<string, string>) =>
        fetch(`https://${row.nodeFqdn}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
        });
      // Signed first. After a PIN request the joining node has already pinned this node's key from
      // our response, so a signature verifies — and a joiner that requires signed peers refuses the
      // bearer the grace window would otherwise send, which left it `pending` for good (this
      // callback is never retried). Only a refused signature falls back to the bearer, and only
      // when this node still allows one: the joiner that never received our key.
      const signedFirst = await this.peerAuthHeaders(updated, 'POST', path, body, { preferSigned: true });
      let response = await send(signedFirst);
      if ((response.status === 401 || response.status === 403) && signedFirst[POOL_SIGNATURE_HEADER] && updated.presentTokenEncrypted) {
        const fallback = await this.peerAuthHeaders(updated, 'POST', path, body).catch(() => null);
        if (fallback && !fallback[POOL_SIGNATURE_HEADER]) {
          response = await send(fallback);
        }
      }
      if (!response.ok) {
        throw new Error(`confirm callback returned ${response.status}`);
      }
      // Learned from a RESPONSE, so no grace: the peer has already processed this node's key.
      const answered = (await response.json().catch(() => ({}))) as { nodeUuid?: string; publicKey?: string };
      await this.pinPeerIdentity(updated, answered, { setGrace: false });
    } catch (error) {
      // We're already connected on our side — the peer's row just stays 'pending'/'outbound'
      // until the operator retries pairing or removes it. Surfacing this as a thrown error would
      // roll back our own approval, which is wrong: WE did approve, the callback just didn't land.
      this.logger.warn(
        `[HubPool] pairing confirmed locally but callback to ${row.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return updated;
  }

  async rejectPairing(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (row?.direction !== 'inbound' || row.status !== 'pending') {
      throw new NotFoundException('No pending inbound pairing request with that id');
    }

    await this.repo.delete(id);

    try {
      // Authenticated like the unpair callback: the initiator only deletes its pending row for a
      // caller it can authenticate — the signature, or the token it issued in its own pair/request.
      const path = '/api/inference/pool/pair/reject';
      await fetch(`https://${row.nodeFqdn}${path}`, {
        method: 'POST',
        // No body: the peer identifies us from the guard headers, which is the only claim it should trust here.
        headers: await this.peerAuthHeaders(row, 'POST', path),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug(`[HubPool] best-effort reject callback to ${row.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Inbound `POST /inference/pool/pair/confirm` — `guardedRow` is `request.poolPeer` from
   * {@link PoolPeerGuard}, so the caller has already proved it holds the token this node issued.
   *
   * That is what makes this the right place for the legacy flow's identity exchange: the claim
   * arrives authenticated, and the answer carries this node's own identity back over the same
   * authenticated call. A pairing that never uses a PIN still ends up with both sides pinned.
   */
  async confirmPairing(
    guardedRow: HubPoolPeer,
    rawToken: string,
    claim: { fromNodeUuid?: string; fromPublicKey?: string } = {},
  ): Promise<{ nodeUuid: string; publicKey: string } | Record<string, never>> {
    if (guardedRow.direction !== 'outbound' || guardedRow.status !== 'pending') {
      throw new ConflictException('No pending outbound pairing awaiting confirmation for this peer');
    }
    const updated = await this.repo.update(guardedRow.id, {
      status: 'connected',
      presentTokenEncrypted: this.encryption.encrypt(rawToken, guardedRow.nodeFqdn),
    });
    // Learned from a REQUEST, so grace: the reply below carries this node's key and may not land.
    await this.pinPeerIdentity(updated ?? guardedRow, { nodeUuid: claim.fromNodeUuid, publicKey: claim.fromPublicKey }, { setGrace: true });
    return this.ownIdentityClaim();
  }

  /** Inbound `POST /inference/pool/pair/reject` — `guardedRow` is `request.poolPeer` from {@link PoolPeerGuard}: the decliner proved it holds the token we issued in our own pair/request. */
  async handleRemoteReject(guardedRow: HubPoolPeer): Promise<void> {
    if (guardedRow.direction === 'outbound' && guardedRow.status === 'pending') {
      await this.repo.delete(guardedRow.id);
    }
  }

  async removePeer(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    await this.repo.delete(id);
    this.probeFailures.delete(id);
    if (!row) {
      return;
    }

    // Best-effort, like rejectPairing: without it the peer keeps our row for up to three health
    // polls (~90s) and keeps forwarding us work we now answer with a 401 from PoolPeerGuard.
    try {
      const path = '/api/inference/pool/pair/unpair';
      await fetch(`https://${row.nodeFqdn}${path}`, {
        method: 'POST',
        // No body: the peer identifies us from the guard headers, which is the only claim it should trust here.
        headers: await this.peerAuthHeaders(row, 'POST', path),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug(`[HubPool] best-effort unpair callback to ${row.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Inbound `POST /inference/pool/pair/unpair` — the peer removed us, so drop our side too. */
  async handleRemoteUnpair(guardedRow: HubPoolPeer): Promise<void> {
    await this.repo.delete(guardedRow.id);
    this.probeFailures.delete(guardedRow.id);
  }

  /**
   * Drop a peer's cached capability snapshot so the proxy stops offering it as a candidate until
   * the next successful health probe re-populates it. Used when a peer answers a forwarded request
   * with 401/403 — it no longer considers us paired, so its cached model list is a lie.
   */
  async clearCachedCapabilities(peerId: string): Promise<void> {
    await this.repo.update(peerId, { lastCapabilities: null });
  }

  /**
   * This node's current capabilities, served to peers at `GET /inference/pool/capabilities`.
   *
   * `inFlightRequests` is what makes a peer's ranking of us more than a guess: without it a node
   * saturated by its own apps looks identical to an idle one, since the polling peer can only count
   * the work it forwarded itself.
   *
   * `acceptingWork: false` (inbound off, or this caller's row disabled) publishes an EMPTY
   * inventory alongside the real tier and queue depth. Both halves matter: the flag is what a
   * current peer skips on, and the empty inventory is what an older peer — which does not know the
   * flag — falls back to, since a node with no models matches nothing in its candidate list. The
   * live figures stay honest so the peer's health poll keeps succeeding and neither dashboard shows
   * a perfectly healthy machine as unreachable.
   */
  async getOwnCapabilities(acceptingWork = true): Promise<PoolPeerCapabilities> {
    const [inventory, self] = await Promise.all([this.getOwnInventory(), this.identity.get()]);
    const gpuPressure = this.pressureService.band();
    const gpuPressureSource = this.pressureService.source();
    const containers = this.ownContainerRollup();
    const promptCeiling = resolvePoolMaxPromptTokens(this.configuration.getHubPoolPreferences().poolMaxPromptTokens).maxPromptTokens;
    const contextCap = this.configuration.getInferencePreferences()?.maxNumCtx ?? null;
    const ollamaSlots = this.configuration.getInferencePreferences()?.ollamaSlots ?? null;
    const throughput = this.throughput?.estimatesFor(LOCAL_CANDIDATE_KEY) ?? [];
    return {
      hardwareTier: inventory.hardwareTier,
      backends: acceptingWork ? inventory.backends : [],
      acceptingWork,
      // This node's pool UUID, on a route the peer had to authenticate to reach. It is what tells a
      // still-bearer peer that an identity upgrade is available, and it is deliberately NOT on the
      // unauthenticated `/identify` probe: that route is published through the Cloudflare tunnel,
      // and a UUID whose whole point is surviving renames is a durable correlator.
      //
      // Read through the identity cache, which is a single memoized database row and never any
      // hardware probing — this answers every peer's 30s poll, and a node with no usable identity
      // simply omits the field and is told about the upgrade on a later probe.
      ...(self ? { nodeUuid: self.nodeUuid } : {}),
      // Never cached: this is the whole point of the snapshot for a ranking peer, and a stale
      // figure would tell it we are idle while our engines are saturated. The pressure band is in
      // this same uncached half and for the same reason — the OWN_INVENTORY_TTL_MS cache must not
      // be allowed to swallow a live counter.
      inFlightRequests: this.loadService.localInFlight(),
      // Spread rather than assigned: an unmeasured node omits the keys ENTIRELY rather than sending
      // 0. Absence and idleness must not share an encoding on the wire either — a peer reading this
      // turns a missing key into UNKNOWN_PRESSURE, and would have taken a 0 at face value.
      ...(gpuPressure === null ? {} : { gpuPressure }),
      ...(gpuPressureSource === null ? {} : { gpuPressureSource }),
      // Same spread, same rule, and deliberately outside the inventory cache: read fresh from the
      // runtime monitor's own sample on every call so OWN_INVENTORY_TTL_MS cannot pin a container
      // count that has since changed. It is a SAMPLED figure rather than a live counter — the
      // monitor collects on its own 60s timer and this only reads what it already has, because
      // probing Docker on the route answering every peer's poll is what the probe-timeout comment
      // above records going wrong. Nothing to report (opted out, no sample yet, sampling failing)
      // omits the key entirely; it never becomes `{ running: 0 }`, which is a claim we cannot make.
      ...(containers === null ? {} : { containers }),
      // Omitted, never `null`, when there is no ceiling: absence is what every older build sends and
      // what a peer reads as "serve anything", so the two must not diverge. Advertised whether or not
      // this node is accepting work — it is a standing preference, and a peer's status card should
      // not see it flicker with the inbound switch. Read per call, so a PATCH reaches peers on their
      // next poll rather than after a restart.
      ...(promptCeiling === null ? {} : { maxPromptTokens: promptCeiling }),
      // Same encoding as the ceiling, for the same reasons: absent is "no cap" on every build, it
      // describes the engine rather than an offer of work, and a PATCH reaches peers on their next
      // poll. An entry node reads it to cap what it hands an app the pool may send here.
      ...(contextCap === null ? {} : { maxNumCtx: contextCap }),
      // Same encoding again: absent is "not stated" on every build and ranks by queue depth alone,
      // it describes the daemon rather than an offer of work, and a PATCH reaches peers on their next
      // poll. An entry node with `poolSlotAwareness` on reads it to tell a full engine from a free one.
      ...(ollamaSlots === null ? {} : { ollamaSlots }),
      // Omitted when nothing has been timed, like every other measurement here: absence is what an
      // older build sends and what a reader ranks as unmeasured. Advertised whether or not this node
      // is accepting work, like the ceiling, because it describes the hardware rather than an offer.
      ...(throughput.length === 0 ? {} : { throughput }),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * This node's container rollup for the capability payload, or `null` for "do not report".
   *
   * Two independent reasons to stay silent, and both must omit the key rather than send zeros: the
   * operator has switched sharing off, or nothing here has a recent sample to publish. A peer
   * cannot tell those apart, and it does not need to — both mean "we cannot tell you", which is
   * exactly what a pre-container build already says by omitting it.
   *
   * The setting is read per call, never cached, so switching it off takes effect on the very next
   * peer poll rather than at the next restart — the same rule every other pool setting follows.
   */
  private ownContainerRollup(): PoolContainerRollup | null {
    if (!this.configuration.getHubPoolPreferences().poolShareContainerStats) {
      return null;
    }
    return this.resolveContainerSampler()?.containerRollup() ?? null;
  }

  /**
   * The apps-side sampler, resolved lazily through `ModuleRef` and memoized once it is found.
   *
   * A failure is NOT memoized: this is called from the poll path, `ModuleRef.get` is a map lookup,
   * and a permanent negative cache would turn one unlucky early call into a Hub that never reports
   * containers again. It is warned about exactly once, because a silently absent sampler is
   * indistinguishable on the wire from an operator who opted out — the one failure here that could
   * otherwise go unnoticed for the life of the install.
   */
  private resolveContainerSampler(): PoolContainerSampler | null {
    if (this.containerSampler) {
      return this.containerSampler;
    }
    try {
      this.containerSampler = this.moduleRef?.get<PoolContainerSampler>(POOL_CONTAINER_SAMPLER, { strict: false }) ?? null;
    } catch {
      // ModuleRef.get THROWS on an unresolvable token rather than returning undefined.
      this.containerSampler = null;
    }
    if (!this.containerSampler && !this.containerSamplerWarned) {
      this.containerSamplerWarned = true;
      this.logger.warn('[HubPool] no container sampler is wired up, so peers will see this node as not reporting containers');
    }
    return this.containerSampler;
  }

  /**
   * A peer's container rollup as this node is willing to believe it, or `null` for "not reported".
   *
   * Shared by `/pool/status` and `/pool/peers` rather than re-derived at each surface, and applied
   * on the READ path: `last_capabilities` is free-form jsonb the peer controls, and a row can
   * predate any check we add at the moment it is written. A stale snapshot discards the claim
   * entirely — the same rule {@link effectivePeerPressure} applies, and for the same reason: an
   * hour-old container count drawn as current is a number an operator would act on during the one
   * incident it is wrong for.
   */
  peerContainers(peer: HubPoolPeer): PoolContainerRollup | null {
    const capabilities = peer.lastCapabilities as unknown as PoolPeerCapabilities | null;
    const freshnessMs = this.configuration.getHubPoolPreferences().poolHealthPollSeconds * 1000 * CAPABILITIES_FRESHNESS_POLLS;
    if (!isCapabilitiesSnapshotFresh(peer.lastSeenAt, freshnessMs)) {
      return null;
    }
    return clampContainerRollup(capabilities?.containers);
  }

  /**
   * A peer's context cap as this node's routing reads it, or `null` for "no cap advertised".
   *
   * Shared by `/pool/status` and `/pool/peers` for the same reason {@link peerContainers} is: the
   * column is free-form jsonb the peer writes, so the clamped value is the only one a caller may
   * render, and both surfaces must show the number that actually excludes the peer.
   *
   * Deliberately NOT freshness-gated, unlike the rollup above: a cap is the far operator's policy,
   * not a measurement of this second, and `applyContextCap` keeps applying it for as long as it
   * still trusts the same snapshot's inventory. Gating it here would draw a capped node as uncapped
   * — "takes any window" — which is the one reading that sends a 64k request at a 16k engine.
   */
  peerContextCap(peer: HubPoolPeer): number | null {
    return clampContextCap((peer.lastCapabilities as unknown as PoolPeerCapabilities | null)?.maxNumCtx);
  }

  /**
   * Hardware tier + per-backend model lists, stale-while-revalidate behind {@link
   * OWN_INVENTORY_TTL_MS}, with a single-flight guard so concurrent callers share one fan-out.
   *
   * Three tiers, and the middle one is the whole point: fresh is served directly; STALE is served
   * directly too while a refresh runs in the background, so the caller that happened to arrive after
   * the TTL does not pay for the rebuild; only a genuinely cold cache — nothing cached at all, or
   * something older than {@link OWN_INVENTORY_MAX_STALE_MS} — blocks.
   *
   * That middle tier is what stops a slow node being evicted from the pool. The caller most likely
   * to hit an expired entry is a peer's health probe, and making IT wait for a twelve-backend
   * fan-out is what turned a loaded-but-healthy appliance into an `unreachable` row three probes
   * later.
   */
  private async getOwnInventory(): Promise<OwnInventory> {
    const cached = this.ownInventoryCache;
    const now = Date.now();
    if (cached && now < cached.expiresAt) {
      return cached.value;
    }

    // Stale but serviceable: hand back what we have and refresh behind the caller's back. The
    // refresh is deliberately not awaited, and its rejection is swallowed — a failed background
    // rebuild must not reject the read that triggered it, and the next caller simply tries again.
    if (cached && now < cached.expiresAt + OWN_INVENTORY_MAX_STALE_MS) {
      if (!this.ownInventoryInFlight) {
        void this.refreshOwnInventory().catch(() => {
          /* logged at the fan-out; a stale-serve must never surface as a caller-visible failure */
        });
      }
      return cached.value;
    }

    if (this.ownInventoryInFlight) {
      return this.ownInventoryInFlight;
    }

    return this.refreshOwnInventory();
  }

  /** The uncached fan-out itself, single-flighted. Always resolves to a freshly built inventory. */
  private async refreshOwnInventory(): Promise<OwnInventory> {
    if (this.ownInventoryInFlight) {
      return this.ownInventoryInFlight;
    }

    this.ownInventoryInFlight = (async () => {
      const [status, models] = await Promise.all([this.inferenceRouter.getStatus(), this.inferenceRouter.listModels()]);
      const inventory: OwnInventory = {
        hardwareTier: status.hardwareTier,
        backends: status.backends.map((b) => {
          // What we publish here is what every peer ranks us on, so a model this node has been
          // caught unable to serve must not appear in it. Advertising it would send us other
          // nodes' work for a model that fails on arrival — and unlike a local mis-route, the peer
          // has no way to find that out until it has already handed over the request.
          const unservable = new Set(b.unservableModels ?? []);
          return {
            type: b.type,
            healthy: b.healthy,
            modelsLoaded: models.filter((m) => m.backend === b.type && m.local && m.state !== 'available' && !unservable.has(m.id)).map((m) => m.id),
          };
        }),
      };
      this.ownInventoryCache = { value: inventory, expiresAt: Date.now() + OWN_INVENTORY_TTL_MS };
      return inventory;
    })().finally(() => {
      this.ownInventoryInFlight = null;
    });

    return this.ownInventoryInFlight;
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  // ── Bearer → signed migration ───────────────────────────────────────────

  /**
   * Inbound `POST /inference/pool/pair/upgrade` — `guardedRow` is `request.poolPeer`, so this is
   * authenticated by exactly the credential it retires.
   *
   * That framing matters and belongs in the docs as much as here: this is a TRANSFER of an existing
   * trust relationship onto a stronger carrier, not a fresh trust-on-first-use bootstrap. It is
   * precisely as trustworthy as the pairing it inherits, and it does not launder a pairing that was
   * bad to begin with.
   */
  async handleUpgradeRequest(
    guardedRow: HubPoolPeer,
    claim: { nodeUuid?: string; publicKey?: string },
  ): Promise<{ nodeUuid: string; publicKey: string } | Record<string, never>> {
    // Learned from a REQUEST, so grace: if the reply below is lost the caller retries next tick and
    // is still accepted, because its bearer token is still honoured inside the window.
    await this.pinPeerIdentity(guardedRow, claim, { setGrace: true });
    return this.ownIdentityClaim();
  }

  /** Operator-forced upgrade for one peer, instead of waiting for the health poll to get to it. */
  async upgradePeerToSigned(id: string): Promise<HubPoolPeer> {
    const peer = await this.repo.findById(id);
    if (!peer) {
      throw new NotFoundException('No pool peer with that id');
    }
    if (!(await this.identity.canSign())) {
      throw new ServiceUnavailableException('This node has no usable pool identity to upgrade with');
    }
    const upgraded = await this.exchangeIdentityWith(peer);
    if (!upgraded) {
      throw new ServiceUnavailableException(`${peer.nodeFqdn} did not complete the identity exchange`);
    }
    return upgraded;
  }

  /**
   * Ride the health poll: a peer still on the bearer token, which has just told us its pool UUID on
   * an authenticated `capabilities` response, gets upgraded on the spot.
   *
   * Deliberately driven by `capabilities.nodeUuid` and not by the unauthenticated `/identify`
   * probe. `/identify` is published through the Cloudflare tunnel; a UUID is a durable correlator
   * and does not belong on it, and reading protocol support from a route an attacker can answer
   * would let it steer this decision.
   */
  private async upgradeToSignedIfPossible(peer: HubPoolPeer, capabilities: PoolPeerCapabilities): Promise<void> {
    if (peer.peerPublicKey || !capabilities.nodeUuid || !(await this.identity.canSign())) {
      return;
    }
    await this.exchangeIdentityWith(peer);
  }

  private async exchangeIdentityWith(peer: HubPoolPeer): Promise<HubPoolPeer | null> {
    const claim = await this.ownIdentityClaim();
    if (!('nodeUuid' in claim)) {
      return null;
    }
    try {
      const path = '/api/inference/pool/pair/upgrade';
      const response = await fetch(`https://${peer.nodeFqdn}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await this.peerAuthHeaders(peer, 'POST', path, claim)) },
        body: JSON.stringify(claim),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`upgrade returned ${response.status}`);
      }
      const answered = (await response.json()) as { nodeUuid?: string; publicKey?: string };
      // Learned from a RESPONSE: the peer has our key, so this side can sign immediately.
      return await this.pinPeerIdentity(peer, answered, { setGrace: false });
    } catch (error) {
      // Non-fatal by design: the pairing keeps working on tokens and the next tick tries again.
      this.logger.debug(
        `[HubPool] identity upgrade with ${peer.nodeFqdn} did not complete: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Settle a row that has pinned a peer's key but is still carrying bearer tokens.
   *
   * Two outcomes, and the trigger for each is the point of the design:
   *   - EVIDENCE (`signedSeenAt` set by the guard): the peer really did upgrade, so both token
   *     columns are nulled and the grace window is cleared. From then on an old database backup
   *     holds tokens that authenticate nowhere.
   *   - NO EVIDENCE by the end of the window: the upgrade did not take on the far side. The pinning
   *     is rolled BACK rather than enforced — enforcing it would lock out a peer that is still, and
   *     correctly, presenting its bearer token. The next tick re-attempts the exchange.
   */
  private async reconcileBearerGrace(peer: HubPoolPeer): Promise<HubPoolPeer | null> {
    if (!peer.peerPublicKey) {
      return null;
    }

    if (peer.signedSeenAt) {
      if (!peer.verifyTokenHash && !peer.presentTokenEncrypted && !peer.bearerGraceUntil) {
        return null;
      }
      this.logger.info(`[HubPool] ${peer.nodeFqdn} is authenticating with its pinned key; retiring both bearer tokens for that peer`);
      return (await this.repo.update(peer.id, { verifyTokenHash: null, presentTokenEncrypted: null, bearerGraceUntil: null })) ?? null;
    }

    if (peer.bearerGraceUntil && Date.parse(peer.bearerGraceUntil) <= Date.now()) {
      this.logger.warn(
        `[HubPool] ${peer.nodeFqdn} never presented a signed request within the upgrade window; rolling the pinned key back and retrying`,
      );
      return (await this.repo.update(peer.id, { peerNodeUuid: null, peerPublicKey: null, bearerGraceUntil: null })) ?? null;
    }

    return null;
  }

  /**
   * Apply a name change the guard authenticated. Identity beats address: a signed peer arriving
   * under a different FQDN has MOVED, and today a MagicDNS rename breaks a pairing permanently
   * because `node_fqdn` is the unique key and the poll simply starts failing with no way back.
   *
   * Wrapped, because `node_fqdn` is UNIQUE and the new name may already belong to another row.
   */
  private async applyObservedFqdn(peer: HubPoolPeer): Promise<HubPoolPeer | null> {
    const observed = this.identity.takeObservedPeerFqdn(peer.id);
    if (!observed || observed === peer.nodeFqdn) {
      return null;
    }
    try {
      const updated = await this.repo.update(peer.id, { nodeFqdn: observed });
      this.logger.info(`[HubPool] peer ${peer.peerNodeUuid} moved from ${peer.nodeFqdn} to ${observed}; following the identity`);
      return updated ?? null;
    } catch (error) {
      this.logger.warn(
        `[HubPool] could not follow ${peer.nodeFqdn} to its new name ${observed}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ── Identity rotation ───────────────────────────────────────────────────

  /**
   * Replace this node's keypair, keeping its UUID, and unpair every peer.
   *
   * Destructive on purpose: every peer has pinned the old key and v1 has no signed-rotation
   * message, so there is nothing this node could send afterwards that a peer would believe. A
   * rotation path a compromised key could also drive would be worse than no rotation path.
   *
   * Two phases, in this order and not the other: the unpair calls go out FIRST, signed with the key
   * that is about to be destroyed, because once it is gone they cannot be authenticated at all. The
   * result names the peers that were not reached, so the operator knows which Hubs still hold a
   * stale row they will have to clear by hand.
   */
  async rotateIdentity(): Promise<{ nodeUuid: string; publicKeyFingerprint: string | null; unpaired: string[]; unreachable: string[] }> {
    const peers = await this.repo.listAll();
    const unpaired: string[] = [];
    const unreachable: string[] = [];

    for (const peer of peers) {
      try {
        const path = '/api/inference/pool/pair/unpair';
        const response = await fetch(`https://${peer.nodeFqdn}${path}`, {
          method: 'POST',
          headers: await this.peerAuthHeaders(peer, 'POST', path),
          signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`unpair returned ${response.status}`);
        }
        unpaired.push(peer.nodeFqdn);
      } catch (error) {
        this.logger.warn(
          `[HubPool] could not tell ${peer.nodeFqdn} about the identity rotation: ${error instanceof Error ? error.message : String(error)}`,
        );
        unreachable.push(peer.nodeFqdn);
      }
    }

    const rotated = await this.identity.rotate();
    for (const peer of peers) {
      await this.repo.delete(peer.id);
    }
    return {
      nodeUuid: rotated.nodeUuid,
      publicKeyFingerprint: publicKeyFingerprint(rotated.publicKey),
      unpaired,
      unreachable,
    };
  }

  // ── Pairing PIN (operator-facing) ───────────────────────────────────────

  /** Mint a pairing PIN. Refused while pooling is off, like every other pairing surface. */
  mintPairingPin(): { pin: string; expiresAt: string } {
    const enabled = this.enabledState();
    if (!enabled.enabled) {
      throw new ServiceUnavailableException(describeHubPoolDisabled(enabled.disabledBy));
    }
    return this.pairingPins.mint();
  }

  cancelPairingPin(): void {
    this.pairingPins.cancel();
  }

  /** This node's UUID + key fingerprint, for the operator surfaces. Never the private key. */
  async identitySummary(): Promise<PoolIdentitySummary> {
    return this.identity.summary();
  }

  private async refreshPeerHealth(): Promise<void> {
    // 'unreachable' rows are polled too: the peer may have come back (rebooted, network healed,
    // or HUB_POOL_USER_DISABLED removed), and nothing else in the system would ever re-probe it.
    //
    // Disabled peers are polled as well, and that is deliberate: the status card stays honest about
    // a machine that is up, and re-enabling one is instant instead of costing three polls. The
    // probe is a GET of the peer's inventory — it spends no GPU on either side.
    const peers = await this.repo.listByStatuses(['connected', 'unreachable']);
    // The pressure sampler's arm/disarm signal, taken from the rows this tick already had to read.
    // It is deliberately driven from here rather than from a second periodic query of its own: a
    // peerless Hub — nearly all of them — should pay nothing at all for a signal that only exists to
    // be compared against a peer's.
    this.pressureService.setPoolActive(peers.some((peer) => peer.status === 'connected'));
    // Rows deleted by any path (unpair, rotation, a hand-edited table) take their failure run with them.
    const polled = new Set(peers.map((peer) => peer.id));
    for (const id of this.probeFailures.keys()) {
      if (!polled.has(id)) {
        this.probeFailures.delete(id);
      }
    }
    this.loadService.forgetReportsExcept(polled);
    const now = Date.now();
    await Promise.all(peers.filter((peer) => !this.probeBackedOff(peer.id, now)).map((peer) => this.refreshOnePeer(peer)));
  }

  /** Whether a peer that refused us is still inside its backoff window. See `probeBackoffMs`. */
  private probeBackedOff(peerId: string, now: number): boolean {
    const nextProbeAt = this.probeFailures.get(peerId)?.nextProbeAt;
    return nextProbeAt !== null && nextProbeAt !== undefined && Date.parse(nextProbeAt) > now;
  }

  private async refreshOnePeer(peer: HubPoolPeer): Promise<void> {
    try {
      // Every FQDN-column write for this peer happens here, on the poll, and never in the guard:
      // `node_fqdn` is UNIQUE, so a collision has to be able to log instead of failing a request.
      const current = (await this.applyObservedFqdn(peer)) ?? peer;
      const path = '/api/inference/pool/capabilities';
      const response = await fetch(`https://${current.nodeFqdn}${path}`, {
        headers: await this.peerAuthHeaders(current, 'GET', path),
        signal: AbortSignal.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new PoolProbeHttpError(response.status, response.headers.get(POOL_REFUSAL_HEADER));
      }
      const capabilities = (await response.json()) as PoolPeerCapabilities;
      // Its `inFlightRequests` counts what we have forwarded to it; the proxy counts those live instead.
      const forwardedAtReport = this.loadService.get(current.id);
      const refreshed = await this.repo.update(current.id, {
        // A successful probe is the only recovery path back out of 'unreachable' — without this the
        // row would stay excluded from routing forever and Unpair would be the operator's only move.
        status: 'connected',
        consecutiveFailures: 0,
        lastSeenAt: new Date().toISOString(),
        lastCapabilities: capabilities as unknown as Record<string, unknown>,
      });
      this.probeFailures.delete(current.id);
      this.loadService.noteReport(current.id, forwardedAtReport);
      // Both of these are deliberately SEPARATE writes, after the health write has already
      // committed. `peer_node_uuid` carries a partial UNIQUE index (migration 0059), so pinning one
      // can raise a 23505 when the same physical node is somehow paired twice. Folding that into
      // the health write above would send the error into the catch below, where it would count as a
      // failed probe — and three ticks later a perfectly healthy peer would be marked `unreachable`
      // by a uniqueness conflict that has nothing to do with its health. `pinPeerIdentity` swallows
      // it instead, and warns.
      const settled = (await this.reconcileBearerGrace(refreshed ?? current)) ?? refreshed ?? current;
      await this.upgradeToSignedIfPossible(settled, capabilities);
    } catch (error) {
      const failures = peer.consecutiveFailures + 1;
      const failure = await this.recordProbeFailure(peer, error);
      this.logger.warn(
        `[HubPool] capabilities probe for ${peer.nodeFqdn} failed (${failures}/${UNREACHABLE_THRESHOLD}): ${failure.detail}${
          failure.action ? ` — ${failure.action} Next probe after ${failure.nextProbeAt}.` : ''
        }`,
      );
      await this.repo.update(peer.id, {
        consecutiveFailures: failures,
        // A changed identity is a definite answer, not a flaky network, so it leaves routing on the
        // first strike. The other two kinds keep the three-strike rule, since a single 401 can be a
        // restart racing its own identity load.
        status: failures >= UNREACHABLE_THRESHOLD || failure.kind === 'identity_changed' ? 'unreachable' : peer.status,
      });
    }
  }

  /**
   * Classify a failed probe and extend that peer's run of failures, scheduling its next probe.
   *
   * A kind change starts a new run, because the backoff and the operator's instructions belong to the
   * kind. A peer that stops refusing us and merely times out is back on the normal cadence at once.
   */
  private async recordProbeFailure(peer: HubPoolPeer, error: unknown): Promise<PoolPeerProbeFailure> {
    const classified = classifyProbeFailure(error);
    const previous = this.probeFailures.get(peer.id);
    const now = new Date();
    const attempts = previous?.kind === classified.kind ? previous.attempts + 1 : 1;
    const backoffMs = probeBackoffMs(classified.kind, attempts, this.healthPollIntervalMs());
    const failure: PoolPeerProbeFailure = {
      ...classified,
      since: previous?.kind === classified.kind ? previous.since : now.toISOString(),
      lastAttemptAt: now.toISOString(),
      attempts,
      nextProbeAt: backoffMs > 0 ? new Date(now.getTime() + backoffMs).toISOString() : null,
      action: probeFailureAction(classified.kind, peer.nodeFqdn, await this.selfNodeFqdn()),
    };
    this.probeFailures.set(peer.id, failure);
    return failure;
  }
}
