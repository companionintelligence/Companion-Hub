import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { DEFAULT_POOL_HEALTH_POLL_SECONDS, DEFAULT_POOL_LOCAL_AFFINITY, type HubPoolPreferences } from '@/common/helpers/hub-pool';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';

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
  let service: HubPoolPeerService;

  /** Repoint the persisted settings, as a settings PATCH would. */
  function setPoolPreferences(overrides: Partial<HubPoolPreferences>): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
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
    service = new HubPoolPeerService(
      mock<LoggerService>(),
      repo,
      tailscaleService,
      tailscaleAdminApi,
      encryption,
      inferenceRouter,
      loadService,
      configuration,
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

      await expect(service.receivePairingRequest('requester.tailxyz.ts.net', undefined, 'raw-token-value')).resolves.toBeUndefined();

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

    it('leaves an old outbound row alone — the operator created it and only they retire it', async () => {
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      repo.listByStatus.mockResolvedValue([mockPeer({ id: 'mine', direction: 'outbound', createdAt: stale })]);

      await sweep(service);

      expect(repo.delete).not.toHaveBeenCalled();
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

    it('never triggers peer discovery, which is a Tailscale OAuth exchange plus a probe per device', async () => {
      await service.getPoolStatus();

      expect(tailscaleAdminApi.listDevices).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
