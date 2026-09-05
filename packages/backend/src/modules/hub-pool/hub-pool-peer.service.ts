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
  ServiceUnavailableException,
} from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { describeHubPoolDisabled, normalizePeerFqdn, resolveHubPoolEnabled, type HubPoolEnabledState } from '@/common/helpers/hub-pool';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService, type TailscaleDevice } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import { HubPoolLoadService } from './hub-pool-load.service';
import {
  toPublicPeer,
  type DiscoverablePoolPeer,
  type PoolPeerCapabilities,
  type PoolStatus,
  type PoolStatusLocalNode,
  type PoolStatusReason,
} from './hub-pool.types';

/** Consecutive failed capability probes before a connected peer is marked unreachable (matches the 3-strikes convention in registration.service.ts). */
const UNREACHABLE_THRESHOLD = 3;
const DISCOVERY_PROBE_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;
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
 * 30s health probe *and* by the operator status endpoint, which the UI polls. Deliberately shorter
 * than the default poll interval so a peer probe still gets a freshly built inventory, while
 * operator polling in between is free. Only the inventory is cached — `inFlightRequests` and
 * `updatedAt` are stamped live on every read, since a stale load figure is the one thing that would
 * actually mis-route work.
 */
const OWN_INVENTORY_TTL_MS = 20_000;

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

  /** Effective kill-switch state: the `.env` override, then the persisted setting. */
  enabledState(): HubPoolEnabledState {
    return resolveHubPoolEnabled(this.configuration.getHubPoolPreferences().poolEnabled);
  }

  async listPeers(): Promise<HubPoolPeer[]> {
    return this.repo.listAll();
  }

  async getPeerById(id: string): Promise<HubPoolPeer | undefined> {
    return this.repo.findById(id);
  }

  async listConnectedPeers(): Promise<HubPoolPeer[]> {
    return this.repo.listByStatus('connected');
  }

  async hasConnectedPeers(): Promise<boolean> {
    if (!this.enabledState().enabled) {
      return false;
    }
    return (await this.listConnectedPeers()).length > 0;
  }

  /** Raw bearer token this Hub presents when calling `peer` — decrypted on demand, never cached. */
  async getPresentToken(peer: HubPoolPeer): Promise<string> {
    if (!peer.presentTokenEncrypted) {
      throw new Error(`No outbound pairing token stored for peer ${peer.nodeFqdn}`);
    }
    return this.encryption.decrypt(peer.presentTokenEncrypted, peer.nodeFqdn);
  }

  /**
   * Tailnet devices that identify themselves as CI-Hub nodes (via their
   * already-published `/inference/pool/identify`) and aren't paired/pairing
   * with this Hub yet.
   */
  async listDiscoverableDevices(): Promise<DiscoverablePoolPeer[]> {
    if (!this.tailscaleAdminApi.isConfigured()) {
      return [];
    }

    const selfStatus = await this.tailscaleService.getStatusCached();
    if (!selfStatus.tailnet) {
      return [];
    }

    const [devices, existingPeers] = await Promise.all([this.tailscaleAdminApi.listDevices(selfStatus.tailnet), this.repo.listAll()]);
    const known = new Set(existingPeers.map((p) => p.nodeFqdn));
    const candidates = devices.filter((d) => d.name && d.name !== selfStatus.nodeFqdn && !known.has(d.name));

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
   * Everything the operator UI and CLI need in one poll: whether pooling is on and why, whether
   * discovery is even possible, this node's own identity and inventory, and every peer with its
   * live queue depth.
   *
   * Deliberately cheap enough to poll: one `listAll()` SELECT, in-memory counters, two env reads,
   * the 30s-cached Tailscale status, and the {@link OWN_INVENTORY_TTL_MS}-cached local inventory.
   * It never calls `listDiscoverableDevices` (a Tailscale OAuth exchange plus an HTTPS probe per
   * tailnet device, all uncached) and never re-probes peers — peer capabilities are read from the
   * `lastCapabilities` the health poll already cached.
   */
  async getPoolStatus(): Promise<PoolStatus> {
    const enabled = this.enabledState();
    const [peers, selfStatus, localNode] = await Promise.all([
      this.repo.listAll(),
      this.tailscaleService.getStatusCached(),
      this.buildLocalNodeStatus(),
    ]);

    const connected = peers.filter((p) => p.status === 'connected').length;
    const reason: PoolStatusReason = enabled.enabled
      ? connected > 0
        ? 'active'
        : 'no_peers'
      : enabled.disabledBy === 'env'
        ? 'disabled_by_env'
        : 'disabled_by_setting';

    return {
      enabled: enabled.enabled,
      disabledBy: enabled.disabledBy,
      reason,
      routingActive: enabled.enabled && connected > 0,
      settings: this.configuration.getHubPoolPreferences(),
      tailscaleAdminApiConfigured: this.tailscaleAdminApi.isConfigured(),
      localNode: { ...localNode, nodeFqdn: selfStatus.nodeFqdn, tailnet: selfStatus.tailnet, tailscaleConnected: selfStatus.connected },
      peers: peers.map((peer) => ({ ...toPublicPeer(peer), inFlightRequests: this.loadService.get(peer.id) })),
      peerCounts: {
        total: peers.length,
        connected,
        pending: peers.filter((p) => p.status === 'pending').length,
        unreachable: peers.filter((p) => p.status === 'unreachable').length,
      },
    };
  }

  private async buildLocalNodeStatus(): Promise<Omit<PoolStatusLocalNode, 'nodeFqdn' | 'tailnet' | 'tailscaleConnected'>> {
    const inFlightRequests = this.loadService.localInFlight();
    try {
      const inventory = await this.getOwnInventory();
      return { inFlightRequests, hardwareTier: inventory.hardwareTier, backends: inventory.backends, capabilitiesError: null };
    } catch (error) {
      // A down backend must not take the status card with it — the pairing and kill-switch halves
      // of this payload are exactly what an operator needs while inference is broken.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[HubPool] could not build local capabilities for pool status: ${message}`);
      return { inFlightRequests, hardwareTier: null, backends: [], capabilitiesError: message };
    }
  }

  /** Operator-initiated: pair with a candidate peer discovered above. */
  async initiatePairing(rawNodeFqdn: string, displayName?: string): Promise<HubPoolPeer> {
    const nodeFqdn = this.requireBareHostname(rawNodeFqdn);
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
      const selfStatus = await this.tailscaleService.getStatusCached();
      const response = await fetch(`https://${nodeFqdn}/api/inference/pool/pair/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromNodeFqdn: selfStatus.nodeFqdn, fromDisplayName: selfStatus.hostname ?? undefined, token: rawToken }),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Peer declined pairing request (${response.status})`);
      }
    } catch (error) {
      await this.repo.delete(row.id);
      throw error;
    }

    return row;
  }

  /**
   * Inbound `POST /inference/pool/pair/request` from a would-be peer — the only
   * unauthenticated write in the module, so every check that can be made without
   * established trust is made here: the kill switch, the hostname shape, the
   * pending-row ceiling, and tailnet membership where the Admin API can attest it.
   */
  async receivePairingRequest(rawFromNodeFqdn: string, fromDisplayName: string | undefined, token: string): Promise<void> {
    const enabled = this.enabledState();
    if (!enabled.enabled) {
      throw new ServiceUnavailableException(describeHubPoolDisabled(enabled.disabledBy));
    }

    const fromNodeFqdn = this.requireBareHostname(rawFromNodeFqdn);

    const existing = await this.repo.findByNodeFqdn(fromNodeFqdn);
    if (existing) {
      this.logger.debug(`[HubPool] ignoring duplicate pairing request from ${fromNodeFqdn} (already have a ${existing.status} row)`);
      return;
    }

    const pending = await this.repo.listByStatus('pending');
    if (pending.filter((row) => row.direction === 'inbound').length >= MAX_PENDING_INBOUND_REQUESTS) {
      this.logger.warn(
        `[HubPool] refusing pairing request from ${fromNodeFqdn}: ${MAX_PENDING_INBOUND_REQUESTS} inbound requests already await approval`,
      );
      throw new ServiceUnavailableException('Too many pairing requests are already awaiting approval on this node');
    }

    await this.assertTailnetMember(fromNodeFqdn);

    await this.repo.create({
      nodeFqdn: fromNodeFqdn,
      displayName: fromDisplayName ?? null,
      direction: 'inbound',
      status: 'pending',
      verifyTokenHash: null,
      presentTokenEncrypted: this.encryption.encrypt(token, fromNodeFqdn),
      tailscaleDeviceId: null,
    });
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
   * Degrades to a no-op when the Admin API credential is absent or unhealthy: it
   * is explicitly optional (see `docs/hub-pool.md`), and a Hub that cannot
   * discover peers must still be able to accept pairing from one that can.
   */
  private async assertTailnetMember(nodeFqdn: string): Promise<void> {
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

  /** Expires inbound `pending` rows nothing ever answered, so a squatted FQDN cannot block pairing forever and the table cannot grow without bound. */
  private async sweepExpiredPendingRequests(): Promise<void> {
    const cutoff = Date.now() - PENDING_REQUEST_TTL_MS;
    const pending = await this.repo.listByStatus('pending');
    // Outbound rows are operator-created and are cleaned up by the peer's reject callback or by
    // Unpair, so only the anonymously-created inbound half is swept.
    const expired = pending.filter((row) => row.direction === 'inbound' && Date.parse(row.createdAt) < cutoff);

    for (const row of expired) {
      this.logger.info(`[HubPool] expiring unanswered pairing request from ${row.nodeFqdn} (created ${row.createdAt})`);
      await this.repo.delete(row.id);
    }
  }

  /** Operator approves a pending inbound request — issues our half of the handshake and confirms to the peer. */
  async approvePairing(id: string): Promise<HubPoolPeer> {
    const row = await this.repo.findById(id);
    if (!row || row.direction !== 'inbound' || row.status !== 'pending') {
      throw new NotFoundException('No pending inbound pairing request with that id');
    }

    const rawToken = randomBytes(32).toString('hex');
    const updated = await this.repo.update(id, { status: 'connected', verifyTokenHash: this.hashToken(rawToken) });
    if (!updated) {
      throw new NotFoundException('Pairing request disappeared while approving');
    }

    try {
      const presentToken = await this.getPresentToken(row);
      const selfStatus = await this.tailscaleService.getStatusCached();
      const response = await fetch(`https://${row.nodeFqdn}/api/inference/pool/pair/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Pool-Peer': selfStatus.nodeFqdn ?? '',
          Authorization: `Bearer ${presentToken}`,
        },
        body: JSON.stringify({ fromNodeFqdn: selfStatus.nodeFqdn, token: rawToken }),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`confirm callback returned ${response.status}`);
      }
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
    if (!row || row.direction !== 'inbound' || row.status !== 'pending') {
      throw new NotFoundException('No pending inbound pairing request with that id');
    }

    await this.repo.delete(id);

    try {
      // Authenticated like the unpair callback: the initiator only deletes its pending row for a
      // caller that can present the token it issued in its own pair/request.
      const presentToken = await this.getPresentToken(row);
      const selfStatus = await this.tailscaleService.getStatusCached();
      await fetch(`https://${row.nodeFqdn}/api/inference/pool/pair/reject`, {
        method: 'POST',
        // No body: the peer identifies us from the guard headers, which is the only claim it should trust here.
        headers: { 'X-Hub-Pool-Peer': selfStatus.nodeFqdn ?? '', Authorization: `Bearer ${presentToken}` },
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug(`[HubPool] best-effort reject callback to ${row.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Inbound `POST /inference/pool/pair/confirm` — `guardedRow` is `request.poolPeer` from {@link PoolPeerGuard}. */
  async confirmPairing(guardedRow: HubPoolPeer, rawToken: string): Promise<void> {
    if (guardedRow.direction !== 'outbound' || guardedRow.status !== 'pending') {
      throw new ConflictException('No pending outbound pairing awaiting confirmation for this peer');
    }
    await this.repo.update(guardedRow.id, { status: 'connected', presentTokenEncrypted: this.encryption.encrypt(rawToken, guardedRow.nodeFqdn) });
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
    if (!row) {
      return;
    }

    // Best-effort, like rejectPairing: without it the peer keeps our row for up to three health
    // polls (~90s) and keeps forwarding us work we now answer with a 401 from PoolPeerGuard.
    try {
      const presentToken = await this.getPresentToken(row);
      const selfStatus = await this.tailscaleService.getStatusCached();
      await fetch(`https://${row.nodeFqdn}/api/inference/pool/pair/unpair`, {
        method: 'POST',
        // No body: the peer identifies us from the guard headers, which is the only claim it should trust here.
        headers: { 'X-Hub-Pool-Peer': selfStatus.nodeFqdn ?? '', Authorization: `Bearer ${presentToken}` },
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.debug(`[HubPool] best-effort unpair callback to ${row.nodeFqdn} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Inbound `POST /inference/pool/pair/unpair` — the peer removed us, so drop our side too. */
  async handleRemoteUnpair(guardedRow: HubPoolPeer): Promise<void> {
    await this.repo.delete(guardedRow.id);
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
   */
  async getOwnCapabilities(): Promise<PoolPeerCapabilities> {
    const inventory = await this.getOwnInventory();
    return {
      ...inventory,
      // Never cached: this is the whole point of the snapshot for a ranking peer, and a stale
      // figure would tell it we are idle while our engines are saturated.
      inFlightRequests: this.loadService.localInFlight(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Hardware tier + per-backend model lists, behind {@link OWN_INVENTORY_TTL_MS} and a single-flight guard so concurrent callers share one fan-out. */
  private async getOwnInventory(): Promise<OwnInventory> {
    const cached = this.ownInventoryCache;
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    if (this.ownInventoryInFlight) {
      return this.ownInventoryInFlight;
    }

    this.ownInventoryInFlight = (async () => {
      const [status, models] = await Promise.all([this.inferenceRouter.getStatus(), this.inferenceRouter.listModels()]);
      const inventory: OwnInventory = {
        hardwareTier: status.hardwareTier,
        backends: status.backends.map((b) => ({
          type: b.type,
          healthy: b.healthy,
          modelsLoaded: models.filter((m) => m.backend === b.type && m.local && m.state !== 'available').map((m) => m.id),
        })),
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

  private async refreshPeerHealth(): Promise<void> {
    // 'unreachable' rows are polled too: the peer may have come back (rebooted, network healed,
    // or HUB_POOL_USER_DISABLED removed), and nothing else in the system would ever re-probe it.
    const peers = await this.repo.listByStatuses(['connected', 'unreachable']);
    await Promise.all(peers.map((peer) => this.refreshOnePeer(peer)));
  }

  private async refreshOnePeer(peer: HubPoolPeer): Promise<void> {
    try {
      const token = await this.getPresentToken(peer);
      const selfStatus = await this.tailscaleService.getStatusCached();
      const response = await fetch(`https://${peer.nodeFqdn}/api/inference/pool/capabilities`, {
        headers: { 'X-Hub-Pool-Peer': selfStatus.nodeFqdn ?? '', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`capabilities probe returned ${response.status}`);
      }
      const capabilities = (await response.json()) as PoolPeerCapabilities;
      await this.repo.update(peer.id, {
        // A successful probe is the only recovery path back out of 'unreachable' — without this the
        // row would stay excluded from routing forever and Unpair would be the operator's only move.
        status: 'connected',
        consecutiveFailures: 0,
        lastSeenAt: new Date().toISOString(),
        lastCapabilities: capabilities as unknown as Record<string, unknown>,
      });
    } catch (error) {
      const failures = peer.consecutiveFailures + 1;
      this.logger.warn(
        `[HubPool] capabilities probe for ${peer.nodeFqdn} failed (${failures}/${UNREACHABLE_THRESHOLD}): ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.repo.update(peer.id, {
        consecutiveFailures: failures,
        status: failures >= UNREACHABLE_THRESHOLD ? 'unreachable' : peer.status,
      });
    }
  }
}
