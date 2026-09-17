import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { InferenceStatus } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  POOL_CONTAINER_SAMPLER,
  type HubPoolPreferences,
  type PoolContainerSampler,
} from '@/common/helpers/hub-pool';
import { ModuleRef } from '@nestjs/core';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';
import { HubPoolIdentityService } from '../hub-pool-identity.service';
import { HubPoolPairingPinService } from '../hub-pool-pairing-pin.service';
import { generatePoolKeyPair, privateKeyFromBase64 } from '../hub-pool-peer-auth';

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: 'Peer Hub',
    direction: 'inbound',
    status: 'pending',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: null,
    lastCapabilities: null,
    verifyTokenHash: null,
    presentTokenEncrypted: 'ENC:peer-token',
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('HubPoolPeerService', () => {
  let repo: MockProxy<HubPoolPeerRepository>;
  let tailscaleService: MockProxy<TailscaleService>;
  let tailscaleAdminApi: MockProxy<TailscaleAdminApiService>;
  let encryption: MockProxy<EncryptionService>;
  let inferenceRouter: MockProxy<InferenceRouterService>;
  let configuration: MockProxy<ConfigurationService>;
  let loadService: HubPoolLoadService;
  let identity: MockProxy<HubPoolIdentityService>;
  let pairingPins: HubPoolPairingPinService;
  let pressureService: MockProxy<HubPoolPressureService>;
  let containerSampler: MockProxy<PoolContainerSampler>;
  let moduleRef: MockProxy<ModuleRef>;
  let service: HubPoolPeerService;

  /** Repoint the persisted settings, as a settings PATCH would. */
  function setPoolPreferences(overrides: Partial<HubPoolPreferences>): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolPins: [],
      poolRequireSignedPeers: false,
      poolShareContainerStats: true,
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
      ...overrides,
    });
  }

  beforeEach(() => {
    repo = mock<HubPoolPeerRepository>();
    tailscaleService = mock<TailscaleService>();
    tailscaleAdminApi = mock<TailscaleAdminApiService>();
    encryption = mock<EncryptionService>();
    inferenceRouter = mock<InferenceRouterService>();
    configuration = mock<ConfigurationService>();
    setPoolPreferences({});

    encryption.encrypt.mockImplementation((data: string) => `ENC:${data}`);
    encryption.decrypt.mockImplementation((data: string) => data.replace(/^ENC:/, ''));
    repo.listByStatus.mockResolvedValue([]);
    tailscaleService.getStatusCached.mockResolvedValue({
      installed: true,
      connected: true,
      version: '1.90.0',
      hostname: 'self-hub',
      nodeFqdn: 'self-hub.tailxyz.ts.net',
      tailnet: 'tailxyz.ts.net',
      ip: '100.64.0.1',
      supportsServices: true,
      httpsAvailable: true,
      backendState: 'Running',
      authUrl: null,
    });

    loadService = new HubPoolLoadService();
    identity = mock<HubPoolIdentityService>();
    // Default: this node has no usable identity, so every existing assertion still exercises the
    // bearer path byte-for-byte. The signed tests opt in with `giveSelfAnIdentity()`.
    identity.get.mockResolvedValue(null);
    identity.canSign.mockResolvedValue(false);
    identity.summary.mockResolvedValue({ nodeUuid: null, publicKeyFingerprint: null, identityError: null });
    identity.takeObservedPeerFqdn.mockReturnValue(undefined);
    pairingPins = new HubPoolPairingPinService(mock<LoggerService>());
    pressureService = mock<HubPoolPressureService>();
    // Unmeasured is the DEFAULT here on purpose: it is what every non-AMD node reports, so the
    // whole existing suite exercises the neutral path unless a test opts into a band.
    pressureService.band.mockReturnValue(null);
    pressureService.source.mockReturnValue(null);
    containerSampler = mock<PoolContainerSampler>();
    // No sample is the DEFAULT here, for the same reason the pressure band is: it is what a Hub
    // reports before its first collection lands, so the rest of the suite exercises the omitted-key
    // path unless a test opts into a rollup.
    containerSampler.containerRollup.mockReturnValue(null);
    moduleRef = mock<ModuleRef>();
    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === POOL_CONTAINER_SAMPLER) {
        return containerSampler as never;
      }
      // What Nest actually does with an unknown token: it throws rather than returning undefined.
      throw new Error(`Nest could not find ${String(token)}`);
    });
    service = new HubPoolPeerService(
      mock<LoggerService>(),
      repo,
      tailscaleService,
      tailscaleAdminApi,
      encryption,
      inferenceRouter,
      loadService,
      configuration,
      identity,
      pairingPins,
      pressureService,
      moduleRef,
    );
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('initiatePairing', () => {
    it('creates an outbound pending row and sends the raw token to the peer', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.create.mockImplementation(async (data) => mockPeer(data as Partial<HubPoolPeer>));
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await service.initiatePairing('peer-hub.tailxyz.ts.net', 'Peer Hub');

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ nodeFqdn: 'peer-hub.tailxyz.ts.net', direction: 'outbound', status: 'pending' }),
      );
      const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('peer-hub.tailxyz.ts.net/api/inference/pool/pair/request');
      expect(JSON.parse(init.body as string)).toMatchObject({ fromNodeFqdn: 'self-hub.tailxyz.ts.net' });
    });

    it('refuses a node FQDN that is not a bare hostname', async () => {
      await expect(service.initiatePairing('https://evil.example.com/x')).rejects.toThrow(BadRequestException);

      expect(repo.create).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rolls back the local row when the peer rejects the request', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      const created = mockPeer({ id: 'rollback-me' });
      repo.create.mockResolvedValue(created);
      vi.mocked(global.fetch).mockResolvedValue(new Response('nope', { status: 400 }));

      await expect(service.initiatePairing('peer-hub.tailxyz.ts.net')).rejects.toThrow();

      expect(repo.delete).toHaveBeenCalledWith('rollback-me');
    });
  });

  describe('receivePairingRequest', () => {
    it('stores an inbound pending row with the encrypted presented token', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await service.receivePairingRequest('requester.tailxyz.ts.net', 'Requester Hub', 'raw-token-value');

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeFqdn: 'requester.tailxyz.ts.net',
          direction: 'inbound',
          status: 'pending',
          presentTokenEncrypted: 'ENC:raw-token-value',
        }),
      );
    });

    it('ignores a duplicate request when a relationship already exists', async () => {
      repo.findByNodeFqdn.mockResolvedValue(mockPeer());

      await service.receivePairingRequest('peer-hub.tailxyz.ts.net', undefined, 'raw-token-value');

      expect(repo.create).not.toHaveBeenCalled();
    });

    it.each([
      'https://evil.example.com',
      'peer.tailxyz.ts.net@evil.example.com',
      'peer.tailxyz.ts.net:8443',
      'peer.tailxyz.ts.net/../attacker',
      '203.0.113.10',
    ])('refuses %s — the FQDN becomes the host of every later handshake call', async (fqdn) => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await expect(service.receivePairingRequest(fqdn, undefined, 'raw-token-value')).rejects.toThrow(BadRequestException);

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('stores the canonicalized name so a case-shifted retry cannot squat a second row', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await service.receivePairingRequest('Requester.TailXYZ.TS.NET.', undefined, 'raw-token-value');

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ nodeFqdn: 'requester.tailxyz.ts.net' }));
    });

    it('refuses intake when the node is disabled by the kill switch', async () => {
      vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses intake when the operator turned pooling off in Settings, naming that switch and not the env one', async () => {
      setPoolPreferences({ poolEnabled: false });
      repo.findByNodeFqdn.mockResolvedValue(undefined);

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).rejects.toThrow(/Settings/);

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a new request once the pending-approval list is full', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.listByStatus.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => mockPeer({ id: `pending-${i}`, nodeFqdn: `squat-${i}.tailxyz.ts.net`, direction: 'inbound' })),
      );

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('does not count operator-created outbound rows against the inbound cap', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.listByStatus.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => mockPeer({ id: `pending-${i}`, nodeFqdn: `mine-${i}.tailxyz.ts.net`, direction: 'outbound' })),
      );

      // `{}` rather than `undefined`: the handler now answers with this node's identity on a
      // PIN-verified request, and with an empty object on every protocol-1 one.
      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).resolves.toEqual({});

      expect(repo.create).toHaveBeenCalled();
    });

    it('refuses a requester that is not a device on this tailnet', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(true);
      tailscaleAdminApi.listDevices.mockResolvedValue([{ name: 'someone-else.tailxyz.ts.net' } as never]);

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).rejects.toThrow(ForbiddenException);

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts the request when the Admin API confirms the requester', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(true);
      tailscaleAdminApi.listDevices.mockResolvedValue([{ name: 'Requester.TailXYZ.TS.NET' } as never]);

      await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value');

      expect(repo.create).toHaveBeenCalled();
    });

    it('accepts the request when the Admin API is unreachable — the credential is optional, so it must not gate pairing', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(true);
      tailscaleAdminApi.listDevices.mockRejectedValue(new Error('502 from control plane'));

      await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value');

      expect(repo.create).toHaveBeenCalled();
    });

    it('refuses a name outside this tailnet even with NO Admin API credential configured', async () => {
      // The check that matters now that peers can be found without a Tailscale OAuth client.
      // Previously `assertTailnetMember` returned immediately when the Admin API was unconfigured,
      // so the credential-less configuration — the exact one manual peer entry exists to serve —
      // had no membership check on either side of the handshake. `TailscaleStatus.tailnet` comes
      // from the local CLI and needs no credential at all.
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(false);

      await expect(service.receivePairingRequest('impostor.evil-tailnet.ts.net', undefined, 'raw-token-value')).rejects.toThrow(ForbiddenException);

      expect(repo.create).not.toHaveBeenCalled();
    });

    it('accepts a name on this tailnet with no Admin API credential configured', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(false);

      await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value');

      expect(repo.create).toHaveBeenCalled();
    });

    it('does not refuse a suffix look-alike by accident', async () => {
      // `evil-tailxyz.ts.net` ends with the same characters as `tailxyz.ts.net` but is a different
      // tailnet — the check is on a dot-anchored suffix, not a substring.
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(false);

      await expect(service.receivePairingRequest('impostor.evil-tailxyz.ts.net', undefined, 'raw-token-value')).rejects.toThrow(ForbiddenException);
    });

    it('still accepts pairing on a Hub that has no tailnet of its own', async () => {
      // A Hub that never joined a tailnet has nothing to compare against. Refusing there would
      // break a configuration that works today, so the check degrades to a no-op.
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      tailscaleAdminApi.isConfigured.mockReturnValue(false);
      tailscaleService.getStatusCached.mockResolvedValue({
        installed: false,
        connected: false,
        version: null,
        hostname: null,
        nodeFqdn: null,
        tailnet: null,
        ip: null,
        supportsServices: false,
        httpsAvailable: false,
        backendState: null,
        authUrl: null,
      });

      await service.receivePairingRequest('requester.some-other.ts.net', undefined, 'raw-token-value');

      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('pending request expiry', () => {
    const sweep = (s: HubPoolPeerService) => (s as unknown as { sweepExpiredPendingRequests: () => Promise<void> }).sweepExpiredPendingRequests();

    it('deletes inbound pending rows older than the TTL', async () => {
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      repo.listByStatus.mockResolvedValue([
        mockPeer({ id: 'stale', direction: 'inbound', createdAt: stale }),
        mockPeer({ id: 'fresh', direction: 'inbound', createdAt: new Date().toISOString() }),
      ]);

      await sweep(service);

      expect(repo.delete).toHaveBeenCalledWith('stale');
      expect(repo.delete).not.toHaveBeenCalledWith('fresh');
    });

    /**
     * This previously asserted the opposite — that an outbound row is the operator's to retire —
     * on the reasoning that the peer's reject callback or Unpair would clean it up. That holds only
     * if the far side can ever answer. `approvePairing` confirms back over `https://<fqdn>`, so a
     * peer with no `tailscale serve` on 443 leaves the initiator holding a pending row nothing will
     * ever resolve, which then answers 409 "already paired or pairing" on every retry. Observed on
     * a real fleet; Unpair was the only way out.
     */
    it('deletes outbound pending rows older than the TTL, so a never-answered pairing unsticks itself', async () => {
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      repo.listByStatus.mockResolvedValue([
        mockPeer({ id: 'stranded', direction: 'outbound', createdAt: stale }),
        mockPeer({ id: 'recent', direction: 'outbound', createdAt: new Date().toISOString() }),
      ]);

      await sweep(service);

      expect(repo.delete).toHaveBeenCalledWith('stranded');
      // An outbound request still inside the TTL is a pairing the far operator may yet approve.
      expect(repo.delete).not.toHaveBeenCalledWith('recent');
    });
  });

  describe('approvePairing', () => {
    it('connects the row and confirms the pairing to the peer', async () => {
      const pending = mockPeer({ id: 'approve-me', direction: 'inbound', status: 'pending', presentTokenEncrypted: 'ENC:their-token' });
      repo.findById.mockResolvedValue(pending);
      repo.update.mockResolvedValue({ ...pending, status: 'connected' });
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await service.approvePairing('approve-me');

      expect(repo.update).toHaveBeenCalledWith('approve-me', expect.objectContaining({ status: 'connected' }));
      const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/inference/pool/pair/confirm');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer their-token');
    });

    it('does not throw when the confirm callback to the peer fails — approval already happened locally', async () => {
      const pending = mockPeer({ id: 'approve-me', direction: 'inbound', status: 'pending' });
      repo.findById.mockResolvedValue(pending);
      repo.update.mockResolvedValue({ ...pending, status: 'connected' });
      vi.mocked(global.fetch).mockRejectedValue(new Error('network down'));

      await expect(service.approvePairing('approve-me')).resolves.toMatchObject({ status: 'connected' });
    });

    it('rejects when there is no matching pending inbound row', async () => {
      repo.findById.mockResolvedValue(mockPeer({ status: 'connected' }));

      await expect(service.approvePairing('already-connected')).rejects.toThrow();
    });
  });

  describe('rejectPairing', () => {
    it('proves the exchange to the peer with the token that peer issued us', async () => {
      const pending = mockPeer({ id: 'reject-me', direction: 'inbound', status: 'pending', presentTokenEncrypted: 'ENC:their-token' });
      repo.findById.mockResolvedValue(pending);
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await service.rejectPairing('reject-me');

      expect(repo.delete).toHaveBeenCalledWith('reject-me');
      const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/inference/pool/pair/reject');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer their-token');
      expect(headers['X-Hub-Pool-Peer']).toBe('self-hub.tailxyz.ts.net');
      // The peer resolves us from the guarded headers, so a body naming a node would just be a second, forgeable claim.
      expect(init.body).toBeUndefined();
    });
  });

  describe('handleRemoteReject', () => {
    it('drops the pending outbound row the guard resolved', async () => {
      await service.handleRemoteReject(mockPeer({ id: 'ours', direction: 'outbound', status: 'pending' }));

      expect(repo.delete).toHaveBeenCalledWith('ours');
    });

    it('leaves a connected pairing alone — reject only retires a request that never completed', async () => {
      await service.handleRemoteReject(mockPeer({ id: 'ours', direction: 'outbound', status: 'connected' }));

      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe('confirmPairing', () => {
    it('connects an outbound pending row and stores the peer-issued token', async () => {
      const pending = mockPeer({ id: 'confirm-me', direction: 'outbound', status: 'pending', nodeFqdn: 'peer-hub.tailxyz.ts.net' });

      await service.confirmPairing(pending, 'new-raw-token');

      expect(repo.update).toHaveBeenCalledWith(
        'confirm-me',
        expect.objectContaining({ status: 'connected', presentTokenEncrypted: 'ENC:new-raw-token' }),
      );
    });

    it('rejects when the row is not an outbound pending request', async () => {
      const alreadyConnected = mockPeer({ direction: 'outbound', status: 'connected' });

      await expect(service.confirmPairing(alreadyConnected, 'token')).rejects.toThrow();
    });
  });

  describe('peer health (unreachable threshold)', () => {
    it('marks a connected peer unreachable after 3 consecutive failed capability probes', async () => {
      const peer = mockPeer({ status: 'connected', consecutiveFailures: 2, presentTokenEncrypted: 'ENC:token' });
      vi.mocked(global.fetch).mockRejectedValue(new Error('timeout'));

      // refreshOnePeer is private — this is the pure logic the plan's testing section asks to cover.
      await (service as unknown as { refreshOnePeer: (p: HubPoolPeer) => Promise<void> }).refreshOnePeer(peer);

      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ consecutiveFailures: 3, status: 'unreachable' }));
    });

    it('resets the failure count and caches capabilities on a successful probe', async () => {
      const peer = mockPeer({ status: 'connected', consecutiveFailures: 2, presentTokenEncrypted: 'ENC:token' });
      const capabilities = { hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString() };
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(capabilities), { status: 200 }));

      await (service as unknown as { refreshOnePeer: (p: HubPoolPeer) => Promise<void> }).refreshOnePeer(peer);

      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ consecutiveFailures: 0 }));
    });

    it('keeps polling unreachable rows, not just connected ones', async () => {
      repo.listByStatuses.mockResolvedValue([]);

      await (service as unknown as { refreshPeerHealth: () => Promise<void> }).refreshPeerHealth();

      expect(repo.listByStatuses).toHaveBeenCalledWith(['connected', 'unreachable']);
    });

    it('drives a peer to unreachable and back to connected once it answers again', async () => {
      const capabilities = { hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString() };
      const peer = mockPeer({ status: 'connected', consecutiveFailures: 2, presentTokenEncrypted: 'ENC:token' });
      const refresh = (service as unknown as { refreshOnePeer: (p: HubPoolPeer) => Promise<void> }).refreshOnePeer.bind(service);

      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('timeout'));
      await refresh(peer);
      expect(repo.update).toHaveBeenLastCalledWith(peer.id, expect.objectContaining({ status: 'unreachable' }));

      // The recovery half: the same row, now unreachable, is re-probed and answers.
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify(capabilities), { status: 200 }));
      await refresh({ ...peer, status: 'unreachable', consecutiveFailures: 3 });

      expect(repo.update).toHaveBeenLastCalledWith(peer.id, expect.objectContaining({ status: 'connected', consecutiveFailures: 0 }));
    });
  });

  describe('a peer that refuses us: classification, backoff and the operator action', () => {
    const STALE_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

    function refresh(peer: HubPoolPeer): Promise<void> {
      return (service as unknown as { refreshOnePeer: (p: HubPoolPeer) => Promise<void> }).refreshOnePeer(peer);
    }

    function poll(): Promise<void> {
      return (service as unknown as { refreshPeerHealth: () => Promise<void> }).refreshPeerHealth();
    }

    function refusal(refusalHeader?: string): Response {
      return new Response(JSON.stringify({ statusCode: 401, message: 'Invalid pool peer credentials' }), {
        status: 401,
        headers: refusalHeader ? { 'X-Hub-Pool-Refusal': refusalHeader } : {},
      });
    }

    /** beta-max as its peers held it on 2026-09-16: connected, pinned, and about to be recreated. */
    function stalePeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
      return mockPeer({
        id: 'beta-max',
        nodeFqdn: 'beta-max.tailxyz.ts.net',
        direction: 'outbound',
        status: 'connected',
        presentTokenEncrypted: 'ENC:token',
        peerNodeUuid: STALE_UUID,
        ...overrides,
      });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports a peer whose identity changed as identity_changed, with the exact re-pair commands', async () => {
      const peer = stalePeer();
      repo.listAll.mockResolvedValue([peer]);
      vi.mocked(global.fetch).mockResolvedValue(refusal('identity-mismatch'));

      await refresh(peer);
      const [reported] = (await service.getPoolStatus()).peers;

      expect(reported?.probeFailure).toMatchObject({ kind: 'identity_changed', httpStatus: 401, attempts: 1 });
      expect(reported?.probeFailure?.action).toContain('cihub pool unpair beta-max.tailxyz.ts.net');
      expect(reported?.probeFailure?.action).toContain('cihub pool approve self-hub.tailxyz.ts.net');
      // The identity is never re-pinned from a refusal: the row keeps the UUID the operator approved.
      expect(repo.update).not.toHaveBeenCalledWith(peer.id, expect.objectContaining({ peerNodeUuid: expect.anything() }));
      expect(repo.update).not.toHaveBeenCalledWith(peer.id, expect.objectContaining({ peerPublicKey: expect.anything() }));
    });

    it('takes a changed identity out of routing on the first strike instead of waiting for three', async () => {
      const peer = stalePeer({ consecutiveFailures: 0 });
      vi.mocked(global.fetch).mockResolvedValue(refusal('identity-mismatch'));

      await refresh(peer);

      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ consecutiveFailures: 1, status: 'unreachable' }));
    });

    it('keeps a bare 401 on the three-strike rule, since one can be a restart racing its identity load', async () => {
      const peer = stalePeer({ consecutiveFailures: 0 });
      vi.mocked(global.fetch).mockResolvedValue(refusal());

      await refresh(peer);

      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ consecutiveFailures: 1, status: 'connected' }));
    });

    it('stops probing a peer that refuses us on every poll, which is what logged 3,169 failures', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00Z') });
      const peer = stalePeer({ status: 'unreachable', consecutiveFailures: 3 });
      repo.listByStatuses.mockResolvedValue([peer]);
      vi.mocked(global.fetch).mockResolvedValue(refusal('identity-mismatch'));

      await poll();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // The next regular poll, 30 s later: still inside the backoff, so nothing is sent.
      vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
      await poll();
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // Past the window, it is probed again, and the window after that is longer.
      vi.setSystemTime(new Date('2026-09-16T12:01:01Z'));
      await poll();
      expect(global.fetch).toHaveBeenCalledTimes(2);
      repo.listAll.mockResolvedValue([peer]);
      const [reported] = (await service.getPoolStatus()).peers;
      expect(reported?.probeFailure).toMatchObject({ attempts: 2, since: '2026-09-16T12:00:00.000Z', nextProbeAt: '2026-09-16T12:03:01.000Z' });
    });

    it('never backs off an unreachable peer, so a node that comes back rejoins on the next poll', async () => {
      vi.useFakeTimers({ now: new Date('2026-09-16T12:00:00Z') });
      const peer = stalePeer({ status: 'unreachable', consecutiveFailures: 3 });
      repo.listByStatuses.mockResolvedValue([peer]);
      vi.mocked(global.fetch).mockRejectedValue(new TypeError('fetch failed'));

      await poll();
      vi.setSystemTime(new Date('2026-09-16T12:00:30Z'));
      await poll();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      repo.listAll.mockResolvedValue([peer]);
      expect((await service.getPoolStatus()).peers[0]?.probeFailure).toMatchObject({ kind: 'unreachable', nextProbeAt: null, action: null });
    });

    it('clears the failure once the peer answers again, so status stops telling the operator to re-pair', async () => {
      const peer = stalePeer();
      repo.listAll.mockResolvedValue([peer]);
      vi.mocked(global.fetch).mockResolvedValueOnce(refusal('identity-mismatch'));
      await refresh(peer);

      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString() }), { status: 200 }),
      );
      await refresh(peer);

      expect((await service.getPoolStatus()).peers[0]?.probeFailure).toBeNull();
    });

    it('starts a new run when the kind changes, so a peer that stops refusing is not left backed off', async () => {
      const peer = stalePeer();
      repo.listAll.mockResolvedValue([peer]);
      vi.mocked(global.fetch).mockResolvedValueOnce(refusal('identity-mismatch'));
      await refresh(peer);
      vi.mocked(global.fetch).mockRejectedValueOnce(new TypeError('fetch failed'));
      await refresh(peer);

      expect((await service.getPoolStatus()).peers[0]?.probeFailure).toMatchObject({ kind: 'unreachable', attempts: 1, nextProbeAt: null });
    });

    it('forgets the failure when the operator unpairs, so a re-pair under the same id starts clean', async () => {
      const peer = stalePeer();
      vi.mocked(global.fetch).mockResolvedValueOnce(refusal('identity-mismatch'));
      await refresh(peer);
      repo.findById.mockResolvedValue(peer);
      vi.mocked(global.fetch).mockResolvedValue(refusal());

      await service.removePeer(peer.id);
      repo.listAll.mockResolvedValue([peer]);

      expect((await service.getPoolStatus()).peers[0]?.probeFailure).toBeNull();
    });

    it('warns when a PIN pairing request is swallowed by the stale row it is meant to replace', async () => {
      const logger = mock<LoggerService>();
      (service as unknown as { logger: LoggerService }).logger = logger;
      const peer = stalePeer({ nodeFqdn: 'peer-hub.tailxyz.ts.net' });
      vi.mocked(global.fetch).mockResolvedValueOnce(refusal('identity-mismatch'));
      await refresh(peer);
      repo.findByNodeFqdn.mockResolvedValue(peer);

      await service.receivePairingRequest('peer-hub.tailxyz.ts.net', undefined, 'a'.repeat(64));

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Run cihub pool unpair peer-hub.tailxyz.ts.net here first'));
    });
  });

  describe('removePeer', () => {
    it('deletes the row and tells the peer to drop its half of the pairing', async () => {
      const peer = mockPeer({ id: 'remove-me', status: 'connected', presentTokenEncrypted: 'ENC:their-token' });
      repo.findById.mockResolvedValue(peer);
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await service.removePeer('remove-me');

      expect(repo.delete).toHaveBeenCalledWith('remove-me');
      const [url, init] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('peer-hub.tailxyz.ts.net/api/inference/pool/pair/unpair');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer their-token');
    });

    it('still removes the row when the unpair callback fails', async () => {
      const peer = mockPeer({ id: 'remove-me', status: 'connected', presentTokenEncrypted: 'ENC:their-token' });
      repo.findById.mockResolvedValue(peer);
      vi.mocked(global.fetch).mockRejectedValue(new Error('network down'));

      await expect(service.removePeer('remove-me')).resolves.toBeUndefined();

      expect(repo.delete).toHaveBeenCalledWith('remove-me');
    });
  });

  describe('getOwnCapabilities', () => {
    /** Held so a test can vary one field of the status without restating the whole shape. */
    let ownStatus: InferenceStatus;

    beforeEach(() => {
      ownStatus = {
        hardwareTier: 'high',
        backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://ollama:11434', modelsLoaded: 1 }],
        models: [],
        memoryBudget: {
          totalVramMb: 24576,
          totalRamMb: 65536,
          systemReservedRamMb: 8192,
          dockerOverheadMb: 2048,
          appContainerBudgetMb: 8192,
          modelBudgetVramMb: 20480,
          modelBudgetRamMb: 32768,
          modelUsedVramMb: 0,
          modelUsedRamMb: 0,
          pinnedVramMb: 0,
          pinnedRamMb: 0,
        },
        cloudProviders: [],
      };
      inferenceRouter.getStatus.mockResolvedValue(ownStatus);
      inferenceRouter.listModels.mockResolvedValue([
        {
          id: 'llama3.2:3b',
          object: 'model',
          created: 0,
          owned_by: 'local:ollama',
          state: 'loaded',
          backend: 'ollama',
          modality: ['text'],
          local: true,
        },
      ]);
    });

    it('publishes the queue depth peers rank this node on', async () => {
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const capabilities = await service.getOwnCapabilities();

      // Without this a node saturated by its own apps is indistinguishable from an idle one: the
      // polling peer can only count the work it forwarded itself.
      expect(capabilities.inFlightRequests).toBe(2);
      expect(capabilities.backends).toEqual([{ type: 'ollama', healthy: true, modelsLoaded: ['llama3.2:3b'] }]);
    });

    it('does not advertise a model the local engine has been unable to serve', async () => {
      inferenceRouter.getStatus.mockResolvedValue({
        ...ownStatus,
        backends: ownStatus.backends.map((b) => ({ ...b, unservableModels: ['llama3.2:3b'] })),
      });

      const capabilities = await service.getOwnCapabilities();

      // This snapshot is what every peer ranks us on. Advertising a model that fails on arrival
      // sends us other nodes' work for it, and unlike a local mis-route the peer cannot find out
      // until it has already handed the request over.
      expect(capabilities.backends).toEqual([{ type: 'ollama', healthy: true, modelsLoaded: [] }]);
    });

    it('reports an idle node as zero rather than omitting the figure', async () => {
      // `undefined` is the wire signal for "this build cannot measure it", and peers rank that as
      // mid-load — an idle node must not be handed that penalty.
      await expect(service.getOwnCapabilities()).resolves.toMatchObject({ inFlightRequests: 0 });
    });

    it('builds the model inventory once for concurrent callers instead of fanning out twice', async () => {
      // getStatus + listModels are twelve uncached backend health checks between them; a peer probe
      // arriving alongside an operator status poll must not pay for it twice.
      await Promise.all([service.getOwnCapabilities(), service.getOwnCapabilities()]);

      expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(1);
      expect(inferenceRouter.listModels).toHaveBeenCalledTimes(1);
    });

    it('reuses the cached inventory but re-reads the queue depth on every call', async () => {
      await service.getOwnCapabilities();
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const second = await service.getOwnCapabilities();

      expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(1);
      // A cached load figure would tell a ranking peer we are idle while our engines are busy.
      expect(second.inFlightRequests).toBe(1);
    });

    /**
     * The regression that evicted a healthy node from a live pool.
     *
     * The caller most likely to find an expired entry is a peer's health probe, and the rebuild it
     * would otherwise wait on measured 10.0s on a loaded appliance against a 15s budget — three
     * overruns and the peer is `unreachable`. A stale entry must therefore be SERVED, not awaited.
     */
    it('serves a stale inventory immediately and refreshes behind the caller', async () => {
      vi.useFakeTimers();
      try {
        await service.getOwnCapabilities();
        expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(1);

        // Past the TTL, well inside the staleness ceiling — the window every 30s peer probe lands in.
        vi.advanceTimersByTime(25_000);

        // A rebuild that never settles: if the read awaited it, this call could not resolve at all.
        inferenceRouter.getStatus.mockReturnValue(new Promise(() => {}) as never);

        const stale = await service.getOwnCapabilities();

        expect(stale.backends).toBeDefined();
        // Served from cache, and the refresh was still kicked off for the next caller.
        expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * The install-time defect fence.
   *
   * `hasConnectedPeers()` is consulted ONCE per app, at install time, by
   * `inference-env-resolver.ts` when it decides whether that app's `CI_LLM_BASE_URL` points at the
   * pool proxy or straight at a backend. If either kill switch reached `listConnectedPeers()`, an
   * app created while the switch was off would be pointed away from the pool permanently, and
   * turning the switch back on would not bring it back. The routing filter lives in
   * `PoolProxyService.buildCandidateList` instead.
   */
  describe('listConnectedPeers is not a routing decision', () => {
    it('returns a disabled peer, because the row is still a connected peer', async () => {
      repo.listByStatus.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected', enabled: false })]);

      expect((await service.listConnectedPeers()).map((p) => p.id)).toEqual(['p1']);
    });

    it('keeps hasConnectedPeers true with outbound off, so no app is repointed at a backend URL', async () => {
      repo.listByStatus.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected' })]);
      setPoolPreferences({ poolOutboundEnabled: false });

      expect(await service.hasConnectedPeers()).toBe(true);
    });

    it('keeps hasConnectedPeers true when every peer is disabled, for the same reason', async () => {
      repo.listByStatus.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected', enabled: false })]);

      expect(await service.hasConnectedPeers()).toBe(true);
    });

    it('still goes false under the MASTER switch, which is the documented "this Hub has left the pool"', async () => {
      repo.listByStatus.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected' })]);
      setPoolPreferences({ poolEnabled: false });

      expect(await service.hasConnectedPeers()).toBe(false);
    });
  });

  describe('inboundRefusal', () => {
    it('serves normally at the defaults', () => {
      expect(service.inboundRefusal(mockPeer({ status: 'connected' }))).toBeNull();
    });

    it('names the per-peer switch ahead of the direction, since that is the one to flip', () => {
      setPoolPreferences({ poolInboundEnabled: false });

      expect(service.inboundRefusal(mockPeer({ enabled: false }))).toBe('peer_disabled');
    });

    it('refuses every peer when inbound pooling is off', () => {
      setPoolPreferences({ poolInboundEnabled: false });

      expect(service.inboundRefusal(mockPeer({ enabled: true }))).toBe('inbound_disabled');
    });

    it('is unaffected by the OUTBOUND switch — a node that stops sending still serves', () => {
      setPoolPreferences({ poolOutboundEnabled: false });

      expect(service.inboundRefusal(mockPeer({ enabled: true }))).toBeNull();
    });
  });

  describe('container counts on the wire and in the status payload', () => {
    const rollup = { running: 4, stopped: 1, total: 5, cpuPercent: 37.5, memoryBytes: 2_147_483_648 };

    beforeEach(() => {
      inferenceRouter.getStatus.mockResolvedValue({
        hardwareTier: 'high',
        backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://ollama:11434', modelsLoaded: 1 }],
        models: [],
        memoryBudget: { totalVramMb: 24576, totalRamMb: 65536, systemReservedRamMb: 8192, dockerOverheadMb: 2048, availableForModelsMb: 20480 },
      } as unknown as InferenceStatus);
      inferenceRouter.listModels.mockResolvedValue([] as never);
    });

    describe('getOwnCapabilities', () => {
      it('publishes the counts and totals the local monitor already sampled', async () => {
        containerSampler.containerRollup.mockReturnValue(rollup);

        const capabilities = await service.getOwnCapabilities();

        expect(capabilities.containers).toEqual(rollup);
      });

      it('OMITS the key entirely when the operator opted out, rather than publishing zeros', async () => {
        setPoolPreferences({ poolShareContainerStats: false });
        containerSampler.containerRollup.mockReturnValue(rollup);

        const capabilities = await service.getOwnCapabilities();

        // Opting out and running an older build are deliberately the same thing on the wire: both
        // mean "we cannot tell you". Zeros would mean "this box is idle", which is a different
        // claim and, here, a false one — five containers are running.
        expect(capabilities).not.toHaveProperty('containers');
      });

      it('does not ask the sampler at all once sharing is off', async () => {
        setPoolPreferences({ poolShareContainerStats: false });

        await service.getOwnCapabilities();

        expect(containerSampler.containerRollup).not.toHaveBeenCalled();
      });

      it('OMITS the key when the local monitor has no recent sample', async () => {
        containerSampler.containerRollup.mockReturnValue(null);

        const capabilities = await service.getOwnCapabilities();

        // Nothing measured yet, or measurement failing. Either way this node has no claim to make,
        // and a peer must read "not reported" rather than an idle machine.
        expect(capabilities).not.toHaveProperty('containers');
      });

      it('OMITS the key when no sampler is wired up at all', async () => {
        // The failure mode of reaching AppsModule lazily: a token that never resolves. It has to
        // degrade to "not reported" rather than to zeros or to a thrown capabilities probe, which
        // would take the node out of the pool entirely.
        moduleRef.get.mockImplementation(() => {
          throw new Error('Nest could not find POOL_CONTAINER_SAMPLER');
        });

        const capabilities = await service.getOwnCapabilities();

        expect(capabilities).not.toHaveProperty('containers');
        expect(capabilities.hardwareTier).toBe('high');
      });

      it('publishes an all-zero rollup, which is a claim and not an absence', async () => {
        const idle = { running: 0, stopped: 0, total: 0, cpuPercent: 0, memoryBytes: 0 };
        containerSampler.containerRollup.mockReturnValue(idle);

        const capabilities = await service.getOwnCapabilities();

        // The one case that must NOT be omitted: the monitor looked and found nothing running.
        expect(capabilities.containers).toEqual(idle);
      });

      it('is not swallowed by the inventory cache — a moving count moves inside the TTL', async () => {
        containerSampler.containerRollup.mockReturnValue({ ...rollup, running: 1, stopped: 0, total: 1 });
        const first = await service.getOwnCapabilities();

        containerSampler.containerRollup.mockReturnValue({ ...rollup, running: 6, stopped: 0, total: 6 });
        const second = await service.getOwnCapabilities();

        expect(first.containers?.total).toBe(1);
        expect(second.containers?.total).toBe(6);
        expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(1);
      });

      it('stays honest while refusing inbound work', async () => {
        containerSampler.containerRollup.mockReturnValue(rollup);

        const capabilities = await service.getOwnCapabilities(false);

        // Container counts are a HEALTH signal, not an offer of work, so they follow
        // `inFlightRequests` and not `backends`. Blanking them would draw a loaded machine as an
        // idle one at the exact moment an operator is looking to find out why it stopped taking work.
        expect(capabilities.backends).toEqual([]);
        expect(capabilities.acceptingWork).toBe(false);
        expect(capabilities.containers).toEqual(rollup);
        expect(capabilities.inFlightRequests).toBe(0);
      });
    });

    describe('getPoolStatus', () => {
      function peerWith(id: string, capabilities: Record<string, unknown>, lastSeenAt = new Date().toISOString()): HubPoolPeer {
        return mockPeer({ id, status: 'connected', lastSeenAt, lastCapabilities: capabilities as unknown as Record<string, unknown> });
      }

      const baseCapabilities = { hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString() };

      it('reports a peer rollup that survived the clamp', async () => {
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, containers: rollup })]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.containers).toEqual(rollup);
      });

      it('reports a peer genuine zeros as zeros', async () => {
        const idle = { running: 0, stopped: 0, total: 0, cpuPercent: 0, memoryBytes: 0 };
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, containers: idle })]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.containers).toEqual(idle);
      });

      it('shows null for a peer that reported nothing — an older build, or one opted out', async () => {
        repo.listAll.mockResolvedValue([peerWith('p1', baseCapabilities)]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.containers).toBeNull();
      });

      it('shows null for a stale snapshot rather than an hour-old count drawn as current', async () => {
        const stale = peerWith('p1', { ...baseCapabilities, containers: rollup }, new Date(Date.now() - 10 * 60_000).toISOString());
        repo.listAll.mockResolvedValue([stale]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.containers).toBeNull();
      });

      it.each([
        ['negative counts', { running: -3, stopped: -1, total: -4, cpuPercent: -1, memoryBytes: -1 }],
        ['an absurd count', { running: 999_999_999, stopped: 0, total: 999_999_999, cpuPercent: 0, memoryBytes: 0 }],
        ['non-finite figures', { running: 1, stopped: 0, total: 1, cpuPercent: Number.NaN, memoryBytes: Number.POSITIVE_INFINITY }],
        ['wrong types', { running: '4', stopped: 'one', total: [5], cpuPercent: {}, memoryBytes: null }],
        ['a bare string', 'lots of them'],
        ['an array', [1, 2, 3]],
        ['more running than exist', { running: 40, stopped: 0, total: 4, cpuPercent: 1, memoryBytes: 1 }],
      ])('shows null for the hostile payload %s', async (_label, hostile) => {
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, containers: hostile })]);

        const status = await service.getPoolStatus();

        // A peer is a remote machine and `last_capabilities` is jsonb it fully controls. A number
        // routing (or an operator) would not believe must not reach the card at all, and it must
        // never be replaced with a plausible-looking zero.
        expect(status.peers[0]?.containers).toBeNull();
      });
    });
  });

  describe('GPU pressure on the wire and in the status payload', () => {
    beforeEach(() => {
      inferenceRouter.getStatus.mockResolvedValue({
        hardwareTier: 'high',
        backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://ollama:11434', modelsLoaded: 1 }],
        models: [],
        memoryBudget: { totalVramMb: 24576, totalRamMb: 65536, systemReservedRamMb: 8192, dockerOverheadMb: 2048, availableForModelsMb: 20480 },
      } as unknown as InferenceStatus);
      inferenceRouter.listModels.mockResolvedValue([
        {
          id: 'llama3.2:3b',
          object: 'model',
          created: 0,
          owned_by: 'local:ollama',
          state: 'loaded',
          backend: 'ollama',
          modality: ['text'],
          local: true,
        },
      ] as never);
    });

    describe('getOwnCapabilities', () => {
      it('publishes the band and the source that produced it when this node measured one', async () => {
        pressureService.band.mockReturnValue(2);
        pressureService.source.mockReturnValue('amd-drm');

        const capabilities = await service.getOwnCapabilities();

        expect(capabilities.gpuPressure).toBe(2);
        expect(capabilities.gpuPressureSource).toBe('amd-drm');
      });

      it('OMITS the keys entirely when unmeasured, rather than publishing 0', async () => {
        pressureService.band.mockReturnValue(null);
        pressureService.source.mockReturnValue(null);

        const capabilities = await service.getOwnCapabilities();

        // Absence and idleness must not share an encoding on the wire either. A peer reading a
        // missing key applies UNKNOWN_PRESSURE; it would have taken a literal 0 at face value and
        // ranked this node as the most attractive candidate in the pool.
        expect(capabilities).not.toHaveProperty('gpuPressure');
        expect(capabilities).not.toHaveProperty('gpuPressureSource');
      });

      it('publishes a measured band of 0, which is a claim and not an absence', async () => {
        pressureService.band.mockReturnValue(0);
        pressureService.source.mockReturnValue('amd-drm');

        const capabilities = await service.getOwnCapabilities();

        expect(capabilities.gpuPressure).toBe(0);
      });

      it('is not swallowed by the inventory cache — a moving band moves inside the TTL', async () => {
        pressureService.band.mockReturnValue(0);
        pressureService.source.mockReturnValue('amd-drm');
        const first = await service.getOwnCapabilities();

        pressureService.band.mockReturnValue(3);
        const second = await service.getOwnCapabilities();

        // Same guarantee `inFlightRequests` already has: only the expensive inventory is cached,
        // because a stale load figure is the one thing that actually mis-routes work.
        expect(first.gpuPressure).toBe(0);
        expect(second.gpuPressure).toBe(3);
        expect(inferenceRouter.getStatus).toHaveBeenCalledTimes(1);
      });

      it('still publishes the band while refusing inbound work', async () => {
        pressureService.band.mockReturnValue(1);
        pressureService.source.mockReturnValue('amd-drm');

        const capabilities = await service.getOwnCapabilities(false);

        // The refusal empties the inventory, not the live counters: the peer must keep seeing a
        // healthy machine so its health poll keeps succeeding.
        expect(capabilities.backends).toEqual([]);
        expect(capabilities.gpuPressure).toBe(1);
      });
    });

    describe('getPoolStatus', () => {
      function peerWith(id: string, capabilities: Record<string, unknown>, lastSeenAt = new Date().toISOString()): HubPoolPeer {
        return mockPeer({ id, status: 'connected', lastSeenAt, lastCapabilities: capabilities as unknown as Record<string, unknown> });
      }

      const baseCapabilities = { hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString() };

      it('reports this node own band and source', async () => {
        pressureService.band.mockReturnValue(2);
        pressureService.source.mockReturnValue('host-file');
        repo.listAll.mockResolvedValue([]);

        const status = await service.getPoolStatus();

        expect(status.localNode.gpuPressure).toBe(2);
        expect(status.localNode.gpuPressureSource).toBe('host-file');
      });

      it('still reports the band when the local inventory could not be built', async () => {
        pressureService.band.mockReturnValue(3);
        pressureService.source.mockReturnValue('amd-drm');
        inferenceRouter.getStatus.mockRejectedValue(new Error('ollama is down'));
        repo.listAll.mockResolvedValue([]);

        const status = await service.getPoolStatus();

        // A down backend must not take the pressure reading with it — during an incident that
        // number is one of the few things on the card still worth reading.
        expect(status.localNode.capabilitiesError).toContain('ollama is down');
        expect(status.localNode.gpuPressure).toBe(3);
      });

      it('reports a peer effective band, not the raw jsonb', async () => {
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, gpuPressure: 2 })]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.gpuPressure).toBe(2);
      });

      it('shows null for a peer that reported nothing', async () => {
        repo.listAll.mockResolvedValue([peerWith('p1', baseCapabilities)]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.gpuPressure).toBeNull();
        expect(status.peers[0]?.gpuPressure).not.toBe(0);
      });

      it('shows null for a stale snapshot, matching what routing would do with it', async () => {
        const stale = peerWith('p1', { ...baseCapabilities, gpuPressure: 0 }, new Date(Date.now() - 10 * 60_000).toISOString());
        repo.listAll.mockResolvedValue([stale]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.gpuPressure).toBeNull();
      });

      it.each([-5, 99, 1.5, 'low', null])('shows null for the hostile value %s', async (hostile) => {
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, gpuPressure: hostile })]);

        const status = await service.getPoolStatus();

        expect(status.peers[0]?.gpuPressure).toBeNull();
      });

      it('shows the forwarded-work floor rather than the peer own optimistic 0', async () => {
        repo.listAll.mockResolvedValue([peerWith('p1', { ...baseCapabilities, gpuPressure: 0 })]);
        loadService.acquire('p1');
        loadService.acquire('p1');

        const status = await service.getPoolStatus();

        // The same floor `PoolProxyService` applies. If the card showed 0 while routing believed 2,
        // an operator debugging a hot node would be reading a number nothing acts on.
        expect(status.peers[0]?.gpuPressure).toBe(2);
      });
    });
  });

  describe('setPeerEnabled', () => {
    it('writes only the flag, leaving the pairing and both tokens untouched', async () => {
      repo.update.mockResolvedValue(mockPeer({ id: 'p1', enabled: false }));

      await service.setPeerEnabled('p1', false);

      expect(repo.update).toHaveBeenCalledWith('p1', { enabled: false });
    });

    it('404s a peer that is gone rather than reporting a silent success', async () => {
      repo.update.mockResolvedValue(undefined);

      await expect(service.setPeerEnabled('missing', true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOwnCapabilities under an inbound refusal', () => {
    beforeEach(() => {
      inferenceRouter.getStatus.mockResolvedValue({
        hardwareTier: 'high',
        backends: [{ type: 'ollama', running: true, healthy: true, url: 'http://ollama:11434', modelsLoaded: 1 }],
      } as unknown as InferenceStatus);
      inferenceRouter.listModels.mockResolvedValue([
        {
          id: 'llama3.2:3b',
          object: 'model',
          created: 0,
          owned_by: 'local:ollama',
          state: 'loaded',
          backend: 'ollama',
          modality: ['text'],
          local: true,
        },
      ] as never);
    });

    it('publishes an empty inventory and acceptingWork: false, while staying honest about tier and load', async () => {
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const capabilities = await service.getOwnCapabilities(false);

      // Both halves matter: a current peer skips on the flag, an older one on the empty list. The
      // live figures keep the peer's health poll succeeding, so it does NOT mark this node down.
      expect(capabilities).toMatchObject({ acceptingWork: false, backends: [], hardwareTier: 'high', inFlightRequests: 1 });
    });

    it('advertises the real inventory when it is serving, which is the default', async () => {
      const capabilities = await service.getOwnCapabilities();

      expect(capabilities.acceptingWork).toBe(true);
      expect(capabilities.backends[0]?.modelsLoaded).toEqual(['llama3.2:3b']);
    });
  });

  describe('getPoolStatus', () => {
    beforeEach(() => {
      inferenceRouter.getStatus.mockRejectedValue(new Error('ollama unreachable'));
      inferenceRouter.listModels.mockRejectedValue(new Error('ollama unreachable'));
      tailscaleAdminApi.isConfigured.mockReturnValue(false);
      repo.listAll.mockResolvedValue([]);
    });

    it('reports no_peers when pooling is on but nothing is paired', async () => {
      const status = await service.getPoolStatus();

      expect(status).toMatchObject({
        enabled: true,
        disabledBy: null,
        reason: 'no_peers',
        routingActive: false,
        tailscaleAdminApiConfigured: false,
        peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0 },
      });
    });

    it('separates a .env override from an in-product one so the UI can name the right switch', async () => {
      setPoolPreferences({ poolEnabled: true });
      vi.stubEnv('HUB_POOL_USER_DISABLED', 'true');

      const fromEnv = await service.getPoolStatus();
      expect(fromEnv).toMatchObject({ enabled: false, disabledBy: 'env', reason: 'disabled_by_env' });
      // The persisted value is reported unchanged, so the settings form still shows what is stored.
      expect(fromEnv.settings.poolEnabled).toBe(true);

      vi.unstubAllEnvs();
      setPoolPreferences({ poolEnabled: false });

      expect(await service.getPoolStatus()).toMatchObject({ enabled: false, disabledBy: 'setting', reason: 'disabled_by_setting' });
    });

    it('is only routingActive when pooling is enabled AND a peer is connected', async () => {
      repo.listAll.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected', direction: 'outbound' })]);

      expect(await service.getPoolStatus()).toMatchObject({ reason: 'active', routingActive: true });

      setPoolPreferences({ poolEnabled: false });

      expect(await service.getPoolStatus()).toMatchObject({ reason: 'disabled_by_setting', routingActive: false });
    });

    it('carries every peer with its live queue depth, counted by status', async () => {
      repo.listAll.mockResolvedValue([
        mockPeer({ id: 'p-connected', nodeFqdn: 'a.example-tailnet.ts.net', status: 'connected' }),
        mockPeer({ id: 'p-pending', nodeFqdn: 'b.example-tailnet.ts.net', status: 'pending' }),
        mockPeer({ id: 'p-down', nodeFqdn: 'c.example-tailnet.ts.net', status: 'unreachable', consecutiveFailures: 3 }),
      ]);
      loadService.acquire('p-connected');
      loadService.acquire('p-connected');

      const status = await service.getPoolStatus();

      expect(status.peerCounts).toEqual({ total: 3, connected: 1, pending: 1, unreachable: 1, disabled: 0 });
      expect(status.peers.map((p) => [p.id, p.inFlightRequests])).toEqual([
        ['p-connected', 2],
        ['p-pending', 0],
        ['p-down', 0],
      ]);
      expect(status.peers[2]).toMatchObject({ status: 'unreachable', consecutiveFailures: 3 });
    });

    it('never exposes the token columns, whatever a peer row holds', async () => {
      repo.listAll.mockResolvedValue([mockPeer({ verifyTokenHash: 'secret-hash', presentTokenEncrypted: 'ENC:secret-token' })]);

      const status = await service.getPoolStatus();

      expect(status.peers[0]).not.toHaveProperty('verifyTokenHash');
      expect(status.peers[0]).not.toHaveProperty('presentTokenEncrypted');
      expect(JSON.stringify(status)).not.toContain('secret-hash');
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });

    it('still answers while the local backends are down, saying why the inventory is empty', async () => {
      const status = await service.getPoolStatus();

      // The pairing and kill-switch halves of this payload are exactly what an operator needs
      // while inference is broken, so a dead backend must not 500 the whole card.
      expect(status.localNode).toMatchObject({ hardwareTier: null, backends: [], capabilitiesError: 'ollama unreachable' });
      expect(status.localNode.nodeFqdn).toBe('self-hub.tailxyz.ts.net');
    });

    it('reports each direction and what is holding it off, so the UI can name the right switch', async () => {
      setPoolPreferences({ poolOutboundEnabled: false });
      vi.stubEnv('HUB_POOL_INBOUND_DISABLED', 'true');

      const status = await service.getPoolStatus();

      expect(status.directions).toEqual({
        outbound: { enabled: false, disabledBy: 'setting' },
        inbound: { enabled: false, disabledBy: 'env' },
      });
      // The MASTER switch is untouched by either — it is a different question with different copy.
      expect(status).toMatchObject({ enabled: true, disabledBy: null });
    });

    it('refuses to call itself active when a direction is off', async () => {
      // A node with inbound off serves nothing; "active" there is the lie an operator would spend
      // an hour debugging.
      repo.listAll.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected' })]);
      setPoolPreferences({ poolInboundEnabled: false });

      const status = await service.getPoolStatus();

      expect(status.reason).toBe('partially_disabled');
      // Outbound is still on and a usable peer exists, so this Hub IS routing its own work.
      expect(status.routingActive).toBe(true);
    });

    it('is not routingActive when outbound is off, even with a connected peer', async () => {
      repo.listAll.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected' })]);
      setPoolPreferences({ poolOutboundEnabled: false });

      expect(await service.getPoolStatus()).toMatchObject({ reason: 'partially_disabled', routingActive: false });
    });

    it('counts disabled peers and stops calling itself active when every connected peer is off', async () => {
      repo.listAll.mockResolvedValue([
        mockPeer({ id: 'p1', nodeFqdn: 'a.example-tailnet.ts.net', status: 'connected', enabled: false }),
        mockPeer({ id: 'p2', nodeFqdn: 'b.example-tailnet.ts.net', status: 'pending', enabled: false }),
      ]);

      const status = await service.getPoolStatus();

      // `disabled` deliberately overlaps the lifecycle counts: it is a routing decision, not a status.
      expect(status.peerCounts).toEqual({ total: 2, connected: 1, pending: 1, unreachable: 0, disabled: 2 });
      expect(status).toMatchObject({ reason: 'partially_disabled', routingActive: false });
    });

    it('still says no_peers, not partially_disabled, when nothing is paired at all', async () => {
      expect(await service.getPoolStatus()).toMatchObject({ reason: 'no_peers', routingActive: false });
    });

    it('reports the master switch, not partially_disabled, when both are in play', async () => {
      // The operator has one thing to change; naming the finer state would send them to the wrong control.
      repo.listAll.mockResolvedValue([mockPeer({ id: 'p1', status: 'connected' })]);
      setPoolPreferences({ poolEnabled: false, poolInboundEnabled: false });

      expect(await service.getPoolStatus()).toMatchObject({ reason: 'disabled_by_setting', routingActive: false });
    });

    it('never triggers peer discovery, which probes every unpaired candidate and is not pollable', async () => {
      await service.getPoolStatus();

      expect(tailscaleAdminApi.listDevices).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('peerAuthHeaders — the single place either credential is attached', () => {
    const SELF_UUID = '11111111-1111-4111-8111-111111111111';
    const PEER_UUID = '22222222-2222-4222-8222-222222222222';
    const keys = generatePoolKeyPair();

    /** Give this node a usable identity, as a booted Hub would have. */
    function giveSelfAnIdentity(): void {
      identity.get.mockResolvedValue({ nodeUuid: SELF_UUID, publicKey: keys.publicKey, privateKey: privateKeyFromBase64(keys.privateKey) });
      identity.canSign.mockResolvedValue(true);
    }

    it('signs for a pinned peer, and never sends a bearer token alongside a signature', async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({ status: 'connected', peerNodeUuid: PEER_UUID, peerPublicKey: keys.publicKey });

      const headers = await service.peerAuthHeaders(peer, 'GET', '/api/inference/pool/capabilities');

      expect(headers['X-Hub-Pool-Node']).toBe(SELF_UUID);
      expect(headers['X-Hub-Pool-Signature']).toMatch(/^v1\.ed25519\./);
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('falls back to the bearer token for a peer that has not been pinned yet', async () => {
      giveSelfAnIdentity();

      const headers = await service.peerAuthHeaders(mockPeer({ status: 'connected' }), 'GET', '/api/inference/pool/capabilities');

      expect(headers.Authorization).toBe('Bearer peer-token');
      expect(headers).not.toHaveProperty('X-Hub-Pool-Signature');
    });

    it('falls back to the bearer token when this node cannot sign, which keeps a broken JWT_SECRET routing', async () => {
      // `privateKey: null` is a regenerated `.env` over a retained volume — an ordinary reinstall.
      identity.get.mockResolvedValue({ nodeUuid: SELF_UUID, publicKey: keys.publicKey, privateKey: null });
      const peer = mockPeer({ status: 'connected', peerNodeUuid: PEER_UUID, peerPublicKey: keys.publicKey });

      const headers = await service.peerAuthHeaders(peer, 'GET', '/api/inference/pool/capabilities');

      expect(headers.Authorization).toBe('Bearer peer-token');
    });

    it('keeps presenting the bearer token while the grace window is live', async () => {
      giveSelfAnIdentity();
      // The side that learned the peer's key from a REQUEST cannot know its own reply arrived, so
      // the peer may still be on tokens — signing at it would strand the pairing.
      const peer = mockPeer({
        status: 'connected',
        peerNodeUuid: PEER_UUID,
        peerPublicKey: keys.publicKey,
        bearerGraceUntil: new Date(Date.now() + 600_000).toISOString(),
      });

      const headers = await service.peerAuthHeaders(peer, 'GET', '/api/inference/pool/capabilities');

      expect(headers.Authorization).toBe('Bearer peer-token');
    });

    it('signs once the grace window has closed', async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({
        status: 'connected',
        peerNodeUuid: PEER_UUID,
        peerPublicKey: keys.publicKey,
        bearerGraceUntil: new Date(Date.now() - 1).toISOString(),
      });

      const headers = await service.peerAuthHeaders(peer, 'GET', '/api/inference/pool/capabilities');

      expect(headers['X-Hub-Pool-Signature']).toMatch(/^v1\.ed25519\./);
    });

    it('refuses to emit a bearer token at all when this node requires signed peers', async () => {
      setPoolPreferences({ poolRequireSignedPeers: true });

      // The client half of the no-downgrade switch: the guard refuses to ACCEPT one, and this
      // refuses to SEND one, so the two rules cannot drift apart.
      await expect(service.peerAuthHeaders(mockPeer({ status: 'connected' }), 'GET', '/api/inference/pool/capabilities')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('pairing PIN gating', () => {
    it('refuses to mint a PIN while pooling is switched off', () => {
      setPoolPreferences({ poolEnabled: false });

      expect(() => service.mintPairingPin()).toThrow(ServiceUnavailableException);
    });

    it('rejects a pairing request carrying a wrong PIN before creating anything', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      service.mintPairingPin();

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value', { pin: '000000' })).rejects.toThrow(
        UnauthorizedException,
      );

      // Nothing created, nothing looked up: the PIN check runs ahead of both, so a wrong guess
      // cannot even reveal whether a row for that name already exists.
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.findByNodeFqdn).not.toHaveBeenCalled();
    });

    it('pins the caller’s identity and answers with its own once the PIN verifies', async () => {
      const keys = generatePoolKeyPair();
      identity.get.mockResolvedValue({
        nodeUuid: '11111111-1111-4111-8111-111111111111',
        publicKey: keys.publicKey,
        privateKey: privateKeyFromBase64(keys.privateKey),
      });
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.create.mockImplementation(async (data) => mockPeer(data as Partial<HubPoolPeer>));
      repo.update.mockImplementation(async (_id, data) => mockPeer(data as Partial<HubPoolPeer>));
      const { pin } = service.mintPairingPin();

      const answer = await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value', {
        pin,
        fromNodeUuid: '22222222-2222-4222-8222-222222222222',
        fromPublicKey: keys.publicKey,
      });

      // Pending, not connected: a PIN authenticates the request, not the operator's decision.
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', direction: 'inbound' }));
      expect(repo.update).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ peerNodeUuid: '22222222-2222-4222-8222-222222222222', peerPublicKey: keys.publicKey }),
      );
      // The name is in here, and this is the only route that discloses it: `GET /identify` is
      // unauthenticated and no longer does. Without it a Hub found by address could never be named,
      // and `POST peers/pair { address, pin }` would have nothing to key a row on.
      expect(answer).toEqual({
        nodeFqdn: 'self-hub.tailxyz.ts.net',
        nodeUuid: '11111111-1111-4111-8111-111111111111',
        publicKey: keys.publicKey,
      });
    });

    it('discloses nothing at all to a pairing request that carried no PIN', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.create.mockImplementation(async (data) => mockPeer(data as Partial<HubPoolPeer>));

      const answer = await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value', {});

      // The PIN is the disclosure boundary for this node's MagicDNS name, not merely the trigger for
      // pinning an identity. An anonymous caller gets today's bare acknowledgement.
      expect(answer).toEqual({});
    });

    it('stores no identity claim on a request that carried no PIN', async () => {
      repo.findByNodeFqdn.mockResolvedValue(undefined);
      repo.create.mockImplementation(async (data) => mockPeer(data as Partial<HubPoolPeer>));

      await service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value', {
        fromNodeUuid: '22222222-2222-4222-8222-222222222222',
        fromPublicKey: 'whatever-the-caller-said',
      });

      // An unauthenticated identity claim is exactly the anonymous write the PIN exists to close;
      // the legacy flow pins on `pair/confirm` instead, which PoolPeerGuard has authenticated.
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  /**
   * Group E's `HubPoolNodeIdentityService` derived a *second* node UUID for the same node, from
   * `resolveDeviceId`. Unified onto `HubPoolIdentityService`, which owns `hub_pool_identity` and
   * the keypair: one node, one UUID, and trust and discovery agree on it. These are E's assertions
   * re-pointed at the surviving service — the behaviour they pin down is what mattered, not which
   * class produced it.
   */
  describe('stable node identity, as peers and the operator see it', () => {
    const SELF_UUID = '11111111-1111-4111-8111-111111111111';
    const PEER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const keys = generatePoolKeyPair();

    /** The capabilities body a peer answers with. */
    function capabilitiesResponse(body: Record<string, unknown> = {}): Response {
      return new Response(JSON.stringify({ hardwareTier: 'high', backends: [], updatedAt: new Date().toISOString(), ...body }), { status: 200 });
    }

    function refresh(peer: HubPoolPeer): Promise<void> {
      return (service as unknown as { refreshOnePeer: (p: HubPoolPeer) => Promise<void> }).refreshOnePeer(peer);
    }

    function giveSelfAnIdentity(): void {
      identity.get.mockResolvedValue({ nodeUuid: SELF_UUID, publicKey: keys.publicKey, privateKey: privateKeyFromBase64(keys.privateKey) });
      identity.canSign.mockResolvedValue(true);
      identity.summary.mockResolvedValue({ nodeUuid: SELF_UUID, publicKeyFingerprint: 'ab:cd', identityError: null });
    }

    beforeEach(() => {
      inferenceRouter.getStatus.mockResolvedValue({ hardwareTier: 'high', backends: [] } as unknown as InferenceStatus);
      inferenceRouter.listModels.mockResolvedValue([]);
    });

    it("tells peers this node's UUID — the persisted one, the same value the guard verifies against", async () => {
      giveSelfAnIdentity();

      expect((await service.getOwnCapabilities()).nodeUuid).toBe(SELF_UUID);
    });

    it('omits nodeUuid entirely when this node has no usable identity, which is every pre-identity build', async () => {
      // `identity.get` resolves null by default — a Hub whose identity could not be established
      // tells peers no UUID, learns none from them, and reports none. Byte-for-byte the old shape.
      repo.listAll.mockResolvedValue([]);

      expect(await service.getOwnCapabilities()).not.toHaveProperty('nodeUuid');
      expect((await service.getPoolStatus()).localNode.identity).toEqual({
        nodeUuid: null,
        publicKeyFingerprint: null,
        identityError: null,
      });
    });

    it('surfaces the identity through pool status without triggering any discovery I/O', async () => {
      giveSelfAnIdentity();
      repo.listAll.mockResolvedValue([]);

      const status = await service.getPoolStatus();

      expect(status.localNode.identity).toEqual({ nodeUuid: SELF_UUID, publicKeyFingerprint: 'ab:cd', identityError: null });
      expect(tailscaleAdminApi.listDevices).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("learns a peer's UUID from the authenticated capabilities response, never from /identify", async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({ status: 'connected', presentTokenEncrypted: 'ENC:token' });
      repo.update.mockImplementation(async (_id, data) => mockPeer(data as Partial<HubPoolPeer>));
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(capabilitiesResponse({ nodeUuid: PEER_UUID }))
        .mockResolvedValue(new Response(JSON.stringify({ nodeUuid: PEER_UUID, publicKey: keys.publicKey }), { status: 200 }));

      await refresh(peer);

      // Pinned together with the public key, which is the only shape `peer_node_uuid` ever holds:
      // the guard resolves a row by UUID and then verifies with the key beside it.
      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ peerNodeUuid: PEER_UUID, peerPublicKey: keys.publicKey }));
    });

    it('does not attempt an upgrade for a peer whose key it already holds', async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({ status: 'connected', presentTokenEncrypted: 'ENC:token', peerNodeUuid: PEER_UUID, peerPublicKey: keys.publicKey });
      vi.mocked(global.fetch).mockResolvedValue(capabilitiesResponse({ nodeUuid: PEER_UUID }));

      await refresh(peer);

      // One call: the capabilities probe. No second round trip to `pair/upgrade`.
      expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
    });

    it('ignores a peer that reports no UUID, which is every pre-identity build', async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({ status: 'connected', presentTokenEncrypted: 'ENC:token' });
      vi.mocked(global.fetch).mockResolvedValue(capabilitiesResponse());

      await refresh(peer);

      expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('warns rather than merging when the same machine is paired twice under two names', async () => {
      giveSelfAnIdentity();
      const peer = mockPeer({ id: 'peer-1', status: 'connected', presentTokenEncrypted: 'ENC:token' });
      repo.findByNodeUuid.mockResolvedValue(mockPeer({ id: 'peer-2', nodeFqdn: 'same-box-renamed.tailxyz.ts.net' }));
      repo.update.mockImplementation(async (_id, data) => mockPeer(data as Partial<HubPoolPeer>));
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(capabilitiesResponse({ nodeUuid: PEER_UUID }))
        .mockResolvedValue(new Response(JSON.stringify({ nodeUuid: PEER_UUID, publicKey: keys.publicKey }), { status: 200 }));

      await refresh(peer);

      // Both rows may hold live tokens; silently deleting an operator's pairing is not this poll's
      // decision to make.
      expect(repo.update).not.toHaveBeenCalledWith('peer-1', expect.objectContaining({ peerNodeUuid: expect.anything() }));
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('writes the UUID separately from the health write, so a unique violation cannot mark a healthy peer unreachable', async () => {
      // `peer_node_uuid` carries a partial UNIQUE index (migration 0059). Folding the pin into the
      // health write would send a 23505 into the failure branch, and three ticks later a perfectly
      // healthy peer would be `unreachable` because of a uniqueness conflict.
      giveSelfAnIdentity();
      const peer = mockPeer({ id: 'peer-1', status: 'connected', consecutiveFailures: 0, presentTokenEncrypted: 'ENC:token' });
      repo.update.mockImplementation(async (_id, data) =>
        'peerNodeUuid' in data ? Promise.reject(new Error('duplicate key value violates unique constraint')) : mockPeer(data as Partial<HubPoolPeer>),
      );
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(capabilitiesResponse({ nodeUuid: PEER_UUID }))
        .mockResolvedValue(new Response(JSON.stringify({ nodeUuid: PEER_UUID, publicKey: keys.publicKey }), { status: 200 }));

      await refresh(peer);

      expect(repo.update).toHaveBeenCalledWith(peer.id, expect.objectContaining({ status: 'connected', consecutiveFailures: 0 }));
      expect(repo.update).not.toHaveBeenCalledWith(peer.id, expect.objectContaining({ status: 'unreachable' }));
    });
  });
});
