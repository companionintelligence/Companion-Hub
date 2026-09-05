import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, forwardRef, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { isHubPoolEnabled } from '@/common/helpers/hub-pool';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import type { DiscoverablePoolPeer, PoolPeerCapabilities } from './hub-pool.types';

const HEALTH_POLL_INTERVAL_MS = 30_000;
/** Consecutive failed capability probes before a connected peer is marked unreachable (matches the 3-strikes convention in registration.service.ts). */
const UNREACHABLE_THRESHOLD = 3;
const DISCOVERY_PROBE_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

/**
 * Pairing lifecycle + health polling for sibling Hub nodes ("peers") reachable
 * over Tailscale. See `hub_pool_peer` in schema.ts for the token model.
 */
@Injectable()
export class HubPoolPeerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly repo: HubPoolPeerRepository,
    private readonly tailscaleService: TailscaleService,
    private readonly tailscaleAdminApi: TailscaleAdminApiService,
    private readonly encryption: EncryptionService,
    @Inject(forwardRef(() => InferenceRouterService))
    private readonly inferenceRouter: InferenceRouterService,
  ) {}

  onModuleInit(): void {
    this.intervalHandle = setInterval(() => {
      void this.refreshPeerHealth();
    }, HEALTH_POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
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
    if (!isHubPoolEnabled()) {
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

  /** Operator-initiated: pair with a candidate peer discovered above. */
  async initiatePairing(nodeFqdn: string, displayName?: string): Promise<HubPoolPeer> {
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

  /** Inbound `POST /inference/pool/pair/request` from a would-be peer — no trust established yet. */
  async receivePairingRequest(fromNodeFqdn: string, fromDisplayName: string | undefined, token: string): Promise<void> {
    const existing = await this.repo.findByNodeFqdn(fromNodeFqdn);
    if (existing) {
      this.logger.debug(`[HubPool] ignoring duplicate pairing request from ${fromNodeFqdn} (already have a ${existing.status} row)`);
      return;
    }

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
      const selfStatus = await this.tailscaleService.getStatusCached();
      await fetch(`https://${row.nodeFqdn}/api/inference/pool/pair/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromNodeFqdn: selfStatus.nodeFqdn }),
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

  /** Inbound `POST /inference/pool/pair/reject` — the peer we asked to pair with declined. */
  async handleRemoteReject(fromNodeFqdn: string): Promise<void> {
    const row = await this.repo.findByNodeFqdn(fromNodeFqdn);
    if (row && row.direction === 'outbound' && row.status === 'pending') {
      await this.repo.delete(row.id);
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

  /** This node's current capabilities, served to peers at `GET /inference/pool/capabilities`. */
  async getOwnCapabilities(): Promise<PoolPeerCapabilities> {
    const [status, models] = await Promise.all([this.inferenceRouter.getStatus(), this.inferenceRouter.listModels()]);
    return {
      hardwareTier: status.hardwareTier,
      backends: status.backends.map((b) => ({
        type: b.type,
        healthy: b.healthy,
        modelsLoaded: models.filter((m) => m.backend === b.type && m.local && m.state !== 'available').map((m) => m.id),
      })),
      updatedAt: new Date().toISOString(),
    };
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
