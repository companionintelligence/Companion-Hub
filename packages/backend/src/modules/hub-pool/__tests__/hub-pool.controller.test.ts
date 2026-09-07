import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Request, Response } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import { HubPoolDiscoveryService } from '../hub-pool-discovery.service';
import { HubPoolController } from '../hub-pool.controller';
import type { PoolStatus } from '../hub-pool.types';

function poolStatus(overrides: Partial<PoolStatus> = {}): PoolStatus {
  return {
    enabled: true,
    disabledBy: null,
    reason: 'no_peers',
    routingActive: false,
    directions: { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } },
    settings: {
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
      poolPressureWeight: 0,
    },
    tailscaleAdminApiConfigured: false,
    localNode: {
      nodeFqdn: 'self-hub.example-tailnet.ts.net',
      tailnet: 'example-tailnet.ts.net',
      tailscaleConnected: true,
      inFlightRequests: 0,
      hardwareTier: 'high',
      backends: [],
      capabilitiesError: null,
    },
    peers: [],
    peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0, disabled: 0 },
    ...overrides,
  };
}

/** The guard-resolved row a peer-facing handler reads, plus the header the caller supplied. */
function peerRequest(peer: Partial<HubPoolPeer> | undefined, headers: Record<string, string> = {}): Request {
  return {
    poolPeer: peer,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function mockResponse(): Response {
  const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

describe('HubPoolController', () => {
  let peerService: MockProxy<HubPoolPeerService>;
  let proxyService: MockProxy<PoolProxyService>;
  let configuration: MockProxy<ConfigurationService>;
  let routingLog: HubPoolRoutingLogService;
  let discoveryService: MockProxy<HubPoolDiscoveryService>;
  let controller: HubPoolController;

  beforeEach(() => {
    peerService = mock<HubPoolPeerService>();
    proxyService = mock<PoolProxyService>();
    configuration = mock<ConfigurationService>();
    // The default for every test that is not about the switches: this node serves the caller.
    peerService.inboundRefusal.mockReturnValue(null);
    routingLog = new HubPoolRoutingLogService();
    discoveryService = mock<HubPoolDiscoveryService>();
    controller = new HubPoolController(peerService, proxyService, mock<TailscaleService>(), configuration, routingLog, discoveryService);
  });

  describe('manual peer entry', () => {
    it('serves the merged candidate list, not the Tailscale-only one', async () => {
      // The route keeps its shape and its name; what changed underneath is that a manually probed
      // node now appears alongside a Tailscale-discovered one, deduplicated.
      discoveryService.listDiscoverableNodes.mockResolvedValue([
        { tailscaleDeviceId: 'ts-1', nodeFqdn: 'remote.tailxyz.ts.net', hostname: 'remote', source: 'tailscale' },
        { tailscaleDeviceId: '', nodeFqdn: 'lan-box.tailxyz.ts.net', hostname: 'lan-box', source: 'lan-probe' },
      ]);

      const result = await controller.listDiscoverable();

      expect(result).toHaveLength(2);
      expect(peerService.listDiscoverableDevices).not.toHaveBeenCalled();
    });

    it('probes an operator-typed address and reports the FQDN pairing will use', async () => {
      discoveryService.probeAddress.mockResolvedValue({
        address: '192.168.1.42',
        isCiHub: true,
        nodeFqdn: 'lan-box.tailxyz.ts.net',
        hostname: 'lan-box',
        alreadyPaired: false,
        pairable: true,
        reason: null,
      });

      const result = await controller.probePeerAddress({ address: '192.168.1.42' });

      expect(discoveryService.probeAddress).toHaveBeenCalledWith('192.168.1.42');
      expect(result).toMatchObject({ pairable: true, nodeFqdn: 'lan-box.tailxyz.ts.net' });
    });

    it('adds no new pairing path — the operator still pairs by FQDN', async () => {
      // Manual entry is a directory lookup. The address is discarded; `peers/pair` is unchanged, so
      // there is no second trust model to keep correct.
      peerService.initiatePairing.mockResolvedValue({ nodeFqdn: 'lan-box.tailxyz.ts.net' } as never);

      await controller.pairPeer({ nodeFqdn: 'lan-box.tailxyz.ts.net' });

      // Third argument is the optional pairing PIN (Group C); manual entry does not supply one.
      expect(peerService.initiatePairing).toHaveBeenCalledWith('lan-box.tailxyz.ts.net', undefined, undefined);
    });
  });

  describe('GET status', () => {
    it('answers the whole operator question in one payload, routing summary included', async () => {
      peerService.getPoolStatus.mockResolvedValue(poolStatus({ reason: 'active', routingActive: true }));
      routingLog.record({
        at: new Date().toISOString(),
        direction: 'outbound',
        path: '/v1/chat/completions',
        model: 'llama3.2:3b',
        node: 'local',
        peerId: null,
        backend: 'ollama',
        candidates: 2,
        attempt: 1,
        failedOverFrom: [],
        outcome: 'served',
        status: 200,
        durationMs: 8,
      });

      const status = await controller.poolStatus();

      expect(status).toMatchObject({ reason: 'active', routingActive: true });
      expect(status.routing).toMatchObject({ recorded: 1, served: 1, failed: 0, failovers: 0 });
    });
  });

  describe('settings', () => {
    it('reads the persisted preferences without touching the peer table', async () => {
      const stored = {
        poolEnabled: false,
        poolOutboundEnabled: true,
        poolInboundEnabled: false,
        poolLocalAffinity: 3,
        poolHealthPollSeconds: 45,
        poolPressureWeight: 0,
      };
      configuration.getHubPoolPreferences.mockReturnValue(stored);

      await expect(controller.getPoolSettings()).resolves.toEqual(stored);
    });

    it('passes a partial PATCH straight through, so an omitted field stays unchanged', async () => {
      configuration.setHubPoolPreferences.mockResolvedValue({
        poolEnabled: true,
        poolOutboundEnabled: true,
        poolInboundEnabled: true,
        poolLocalAffinity: 0,
        poolHealthPollSeconds: 30,
        poolPressureWeight: 0,
      });

      await controller.updatePoolSettings({ poolLocalAffinity: 0 });

      expect(configuration.setHubPoolPreferences).toHaveBeenCalledWith({ poolLocalAffinity: 0 });
    });

    it('round-trips a single directional switch without resending the rest', async () => {
      configuration.setHubPoolPreferences.mockResolvedValue({
        poolEnabled: true,
        poolOutboundEnabled: true,
        poolInboundEnabled: false,
        poolLocalAffinity: 1,
        poolHealthPollSeconds: 30,
        poolPressureWeight: 0,
      });

      await controller.updatePoolSettings({ poolInboundEnabled: false });

      expect(configuration.setHubPoolPreferences).toHaveBeenCalledWith({ poolInboundEnabled: false });
    });
  });

  describe('GET routing-log', () => {
    it('honours the limit and returns newest first alongside the summary', async () => {
      for (const model of ['a', 'b', 'c']) {
        routingLog.record({
          at: new Date().toISOString(),
          direction: 'outbound',
          path: '/v1/chat/completions',
          model,
          node: 'local',
          peerId: null,
          backend: 'ollama',
          candidates: 1,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'served',
          status: 200,
          durationMs: 1,
        });
      }

      const result = await controller.getPoolRoutingLog({ limit: 2 });

      expect(result.entries.map((e) => e.model)).toEqual(['c', 'b']);
      expect(result.summary.recorded).toBe(3);
    });
  });

  describe('GET capabilities', () => {
    it('refuses a peer probe outright when pooling is off, rather than answering "I have nothing"', async () => {
      // Answering emptily would be cached by the peer as this node's capabilities; a hard failure
      // is what correctly marks us unreachable to it.
      peerService.enabledState.mockReturnValue({ enabled: false, disabledBy: 'setting' });

      await expect(controller.capabilities({ poolPeer: { status: 'connected' } } as unknown as Request)).rejects.toThrow(ServiceUnavailableException);
      expect(peerService.getOwnCapabilities).not.toHaveBeenCalled();
    });

    it.each(['pending', 'unreachable'])('refuses a peer whose row is %s, even though the guard admitted its token', async (status) => {
      peerService.enabledState.mockReturnValue({ enabled: true, disabledBy: null });

      // PoolPeerGuard deliberately admits a pending row so /pair/confirm can use it, so this handler
      // is the only thing standing between a half-finished pairing and this node's inventory.
      await expect(controller.capabilities(peerRequest({ status }))).rejects.toThrow(ForbiddenException);
      expect(peerService.getOwnCapabilities).not.toHaveBeenCalled();
    });

    /**
     * The asymmetry between the master switch and the two finer ones, asserted on both sides.
     * Master-off means "I have left the pool" and must keep failing the probe outright; inbound-off
     * and a per-peer disable mean "still here, not serving", and a 503 there would show a healthy
     * machine as unreachable on both dashboards and cost three polls to come back from.
     */
    it.each([
      ['inbound pooling is off', 'inbound_disabled'],
      ['this peer is disabled here', 'peer_disabled'],
    ] as const)('answers 200 with acceptingWork: false when %s', async (_label, refusal) => {
      peerService.enabledState.mockReturnValue({ enabled: true, disabledBy: null });
      peerService.inboundRefusal.mockReturnValue(refusal);

      await controller.capabilities(peerRequest({ status: 'connected' }));

      // The argument, not the return: `getOwnCapabilities(false)` is what empties the inventory and
      // sets the flag, and the peer's health poll still succeeds.
      expect(peerService.getOwnCapabilities).toHaveBeenCalledWith(false);
    });

    it('serves the real inventory when nothing is refusing', async () => {
      peerService.enabledState.mockReturnValue({ enabled: true, disabledBy: null });
      peerService.inboundRefusal.mockReturnValue(null);

      await controller.capabilities(peerRequest({ status: 'connected' }));

      expect(peerService.getOwnCapabilities).toHaveBeenCalledWith(true);
    });

    it('keeps the 503 for the master switch, ahead of any inbound refusal', async () => {
      peerService.enabledState.mockReturnValue({ enabled: false, disabledBy: 'env' });
      peerService.inboundRefusal.mockReturnValue('inbound_disabled');

      await expect(controller.capabilities(peerRequest({ status: 'connected' }))).rejects.toThrow(ServiceUnavailableException);
      expect(peerService.getOwnCapabilities).not.toHaveBeenCalled();
    });
  });

  /**
   * The peer-facing forward. It never re-enters candidate selection — that is what stops a request
   * being relayed through a third node — so everything it refuses, it has to refuse here.
   */
  describe('peer-facing local forward', () => {
    const body = { model: 'llama3.2:3b' };

    it('forwards to the backend the caller named, attributed to the peer the guard authenticated', async () => {
      const res = mockResponse();
      const peer = { nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'connected' };

      await controller.localOllamaChat(
        peerRequest(peer, { 'x-hub-pool-backend': 'ollama', 'x-hub-pool-peer': 'spoofed.example-tailnet.ts.net' }),
        body,
        res,
      );

      // The FQDN comes from the row, not the header: the routing log has to record who was
      // authenticated, not who claimed to call.
      expect(proxyService.forwardToLocalBackendAndRespond).toHaveBeenCalledWith(
        'ollama',
        '/api/chat',
        'POST',
        body,
        res,
        'hub-b.example-tailnet.ts.net',
        undefined,
      );
    });

    it('passes the model header through so the peer forward can be credited to a model', async () => {
      const res = mockResponse();
      const peer = { nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'connected' };

      await controller.localOllamaChat(peerRequest(peer, { 'x-hub-pool-backend': 'ollama', 'x-hub-pool-model': 'llama3.2:3b' }), body, res);

      expect(proxyService.forwardToLocalBackendAndRespond).toHaveBeenCalledWith(
        'ollama',
        '/api/chat',
        'POST',
        body,
        res,
        'hub-b.example-tailnet.ts.net',
        'llama3.2:3b',
      );
    });

    it.each(['pending', 'unreachable'])('refuses a %s peer with 403 without touching a backend', async (status) => {
      const res = mockResponse();

      await controller.localOllamaChat(peerRequest({ nodeFqdn: 'hub-b.example-tailnet.ts.net', status }), body, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(proxyService.forwardToLocalBackendAndRespond).not.toHaveBeenCalled();
    });

    /**
     * 503, never 403. `shouldFailover` retries a >= 500 on the sender's next candidate, whereas
     * `noteRejectedCandidate` reads 401/403 as "this peer no longer considers us paired" and drops
     * its cached capabilities — which would make a temporary local policy decision look like a
     * broken pairing and invalidate a healthy one on every request.
     */
    it.each([
      ['inbound pooling is off', 'inbound_disabled'],
      ['the peer is disabled here', 'peer_disabled'],
    ] as const)('answers a forward with 503 when %s, so the sender fails over', async (_label, refusal) => {
      const res = mockResponse();
      peerService.inboundRefusal.mockReturnValue(refusal);

      await controller.localOllamaChat(
        peerRequest({ nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'connected' }, { 'x-hub-pool-backend': 'ollama' }),
        body,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(proxyService.forwardToLocalBackendAndRespond).not.toHaveBeenCalled();
    });

    it.each([
      ['a refusal', 'inbound_disabled' as const, 503, { nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'connected' }],
      ['an unconnected peer', null, 403, { nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'pending' }],
    ])('records %s in the routing log, so the serving side can say why a peer got nothing', async (_label, refusal, status, peer) => {
      peerService.inboundRefusal.mockReturnValue(refusal);

      await controller.localOllamaChat(peerRequest(peer, { 'x-hub-pool-backend': 'ollama' }), body, mockResponse());

      expect(proxyService.recordRefusedInboundForward).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/chat', fromPeerFqdn: 'hub-b.example-tailnet.ts.net', status }),
      );
    });

    it.each([
      ['no backend header', {}],
      ['a backend this build does not have', { 'x-hub-pool-backend': 'not-a-backend' }],
      ['an empty backend header', { 'x-hub-pool-backend': '' }],
    ])('refuses %s with 400 rather than guessing an engine', async (_label, headers) => {
      const res = mockResponse();

      await controller.localOllamaChat(peerRequest({ nodeFqdn: 'hub-b.example-tailnet.ts.net', status: 'connected' }, headers), body, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(proxyService.forwardToLocalBackendAndRespond).not.toHaveBeenCalled();
    });
  });

  describe('app-facing proxy', () => {
    it.each([
      ['/api/chat', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyOllamaChat(b, r)],
      ['/api/embed', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyOllamaEmbed(b, r)],
      ['/api/embeddings', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyOllamaEmbeddings(b, r)],
      ['/api/generate', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyOllamaGenerate(b, r)],
      ['/v1/chat/completions', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyChatCompletions(b, r)],
      ['/v1/completions', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyCompletions(b, r)],
      ['/v1/embeddings', (c: HubPoolController, b: Record<string, unknown>, r: Response) => c.proxyEmbeddings(b, r)],
    ])('routes %s across the pool on the body’s model', async (path, invoke) => {
      // Apps get OLLAMA_HOST pointed here as well as CI_LLM_BASE_URL, so a native missing from this
      // list is a 404 for every app on the node the moment a peer connects.
      await invoke(controller, { model: 'llama3.2:3b' }, mockResponse());

      expect(proxyService.proxyRequest).toHaveBeenCalledWith(expect.objectContaining({ path, method: 'POST', model: 'llama3.2:3b' }));
    });

    it('400s a body with no model instead of ranking candidates for undefined', async () => {
      const res = mockResponse();

      await controller.proxyChatCompletions({ messages: [] }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(proxyService.proxyRequest).not.toHaveBeenCalled();
    });

    it.each([
      ['/api/tags', (c: HubPoolController, r: Response) => c.proxyOllamaTags(r)],
      ['/api/ps', (c: HubPoolController, r: Response) => c.proxyOllamaPs(r)],
      ['/api/version', (c: HubPoolController, r: Response) => c.proxyOllamaVersion(r)],
      ['/v1/models', (c: HubPoolController, r: Response) => c.proxyOpenAiModelsList(r)],
    ])('serves %s from this node alone, since it carries no model to route on', async (path, invoke) => {
      await invoke(controller, mockResponse());

      expect(proxyService.proxyLocalOnlyRequest).toHaveBeenCalledWith(path, 'GET', undefined, expect.anything());
      expect(proxyService.proxyRequest).not.toHaveBeenCalled();
    });
  });

  describe('peer identity routes', () => {
    it('answers identify with the protocol version and nothing else', async () => {
      // Published through the Cloudflare tunnel. It used to return this node's full MagicDNS name,
      // which nothing consumed; the UUID and public key deliberately live behind PoolPeerGuard on
      // `GET capabilities`, because a UUID that survives renames is a durable correlator.
      expect(await controller.identify()).toEqual({ isCiHub: true, poolProtocol: 2 });
    });

    it('returns the PIN digits exactly once, alongside the fingerprint the far side will show', async () => {
      peerService.mintPairingPin.mockReturnValue({ pin: '123456', expiresAt: '2026-01-01T00:10:00.000Z' });
      peerService.identitySummary.mockResolvedValue({ nodeUuid: 'self-uuid', publicKeyFingerprint: 'aa:bb', identityError: null });

      expect(await controller.mintPairingPin()).toEqual({
        pin: '123456',
        expiresAt: '2026-01-01T00:10:00.000Z',
        nodeUuid: 'self-uuid',
        publicKeyFingerprint: 'aa:bb',
        identityError: null,
      });
      // Minting must not pay for this node's whole model inventory.
      expect(peerService.getPoolStatus).not.toHaveBeenCalled();
    });

    it('cancels an outstanding PIN', async () => {
      expect(await controller.cancelPairingPin()).toEqual({ cancelled: true });
      expect(peerService.cancelPairingPin).toHaveBeenCalled();
    });

    it('passes the operator’s PIN through to the pairing call', async () => {
      peerService.initiatePairing.mockResolvedValue({ id: 'peer-1', nodeFqdn: 'hub-b.example-tailnet.ts.net' } as HubPoolPeer);

      await controller.pairPeer({ nodeFqdn: 'hub-b.example-tailnet.ts.net', displayName: 'Beta', pin: '123456' } as never);

      expect(peerService.initiatePairing).toHaveBeenCalledWith('hub-b.example-tailnet.ts.net', 'Beta', '123456');
    });

    it('reports the source IP on an inbound pairing request, so the cooldown has something to key on', async () => {
      peerService.receivePairingRequest.mockResolvedValue({});
      const req = { ip: '100.64.0.7' } as unknown as Request;

      const answer = await controller.handlePairingRequest(req, {
        fromNodeFqdn: 'hub-b.example-tailnet.ts.net',
        token: 'a'.repeat(32),
        pin: '123456',
        fromNodeUuid: 'peer-uuid',
        fromPublicKey: 'peer-key',
      } as never);

      expect(answer).toEqual({ received: true });
      expect(peerService.receivePairingRequest).toHaveBeenCalledWith('hub-b.example-tailnet.ts.net', undefined, 'a'.repeat(32), {
        fromNodeUuid: 'peer-uuid',
        fromPublicKey: 'peer-key',
        pin: '123456',
        source: { ip: '100.64.0.7' },
      });
    });

    it('folds this node’s identity into the pairing answer when the PIN verified', async () => {
      peerService.receivePairingRequest.mockResolvedValue({ nodeUuid: 'self-uuid', publicKey: 'self-key' });

      const answer = await controller.handlePairingRequest(
        { ip: '100.64.0.7' } as unknown as Request,
        {
          fromNodeFqdn: 'hub-b.example-tailnet.ts.net',
          token: 'a'.repeat(32),
          pin: '123456',
        } as never,
      );

      expect(answer).toEqual({ received: true, nodeUuid: 'self-uuid', publicKey: 'self-key' });
    });

    it('refuses an upgrade the guard did not resolve a peer for', async () => {
      const req = { poolPeer: undefined } as unknown as Request;

      await expect(controller.handlePairingUpgrade(req, { nodeUuid: 'u', publicKey: 'k' } as never)).rejects.toThrow(ForbiddenException);
    });

    it('answers an upgrade with this node’s identity', async () => {
      peerService.handleUpgradeRequest.mockResolvedValue({ nodeUuid: 'self-uuid', publicKey: 'self-key' });
      const req = peerRequest({ id: 'peer-1', status: 'connected' });

      const answer = await controller.handlePairingUpgrade(req, { nodeUuid: 'peer-uuid', publicKey: 'peer-key' } as never);

      expect(answer).toEqual({ nodeUuid: 'self-uuid', publicKey: 'self-key' });
      expect(peerService.handleUpgradeRequest).toHaveBeenCalledWith(req.poolPeer, { nodeUuid: 'peer-uuid', publicKey: 'peer-key' });
    });

    it('names the peers a rotation could not reach', async () => {
      peerService.rotateIdentity.mockResolvedValue({
        nodeUuid: 'self-uuid',
        publicKeyFingerprint: 'cc:dd',
        unpaired: ['hub-b.example-tailnet.ts.net'],
        unreachable: ['hub-c.example-tailnet.ts.net'],
      });

      await expect(controller.rotateIdentity()).resolves.toMatchObject({ unreachable: ['hub-c.example-tailnet.ts.net'] });
    });
  });
});
