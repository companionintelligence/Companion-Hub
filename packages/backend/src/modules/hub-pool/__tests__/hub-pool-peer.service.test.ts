import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { TailscaleAdminApiService } from '@/modules/tailscale/tailscale-admin-api.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { HubPoolPeerRepository } from '../hub-pool-peer.repository';
import { HubPoolPeerService } from '../hub-pool-peer.service';

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: 'Peer Hub',
    direction: 'inbound',
    status: 'pending',
    consecutiveFailures: 0,
    lastSeenAt: null,
    lastCapabilities: null,
    verifyTokenHash: null,
    presentTokenEncrypted: 'ENC:peer-token',
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
  let service: HubPoolPeerService;

  beforeEach(() => {
    repo = mock<HubPoolPeerRepository>();
    tailscaleService = mock<TailscaleService>();
    tailscaleAdminApi = mock<TailscaleAdminApiService>();
    encryption = mock<EncryptionService>();
    inferenceRouter = mock<InferenceRouterService>();

    encryption.encrypt.mockImplementation((data: string) => `ENC:${data}`);
    encryption.decrypt.mockImplementation((data: string) => data.replace(/^ENC:/, ''));
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

    service = new HubPoolPeerService(mock<LoggerService>(), repo, tailscaleService, tailscaleAdminApi, encryption, inferenceRouter);
    global.fetch = vi.fn();
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
});
