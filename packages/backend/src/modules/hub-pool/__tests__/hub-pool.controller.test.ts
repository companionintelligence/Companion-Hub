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
import { HubPoolController } from '../hub-pool.controller';
import type { PoolStatus } from '../hub-pool.types';

function poolStatus(overrides: Partial<PoolStatus> = {}): PoolStatus {
  return {
    enabled: true,
    disabledBy: null,
    reason: 'no_peers',
    routingActive: false,
    settings: { poolEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 },
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
    peerCounts: { total: 0, connected: 0, pending: 0, unreachable: 0 },
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
  let controller: HubPoolController;

  beforeEach(() => {
    peerService = mock<HubPoolPeerService>();
    proxyService = mock<PoolProxyService>();
    configuration = mock<ConfigurationService>();
    routingLog = new HubPoolRoutingLogService();
    controller = new HubPoolController(peerService, proxyService, mock<TailscaleService>(), configuration, routingLog);
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
      configuration.getHubPoolPreferences.mockReturnValue({ poolEnabled: false, poolLocalAffinity: 3, poolHealthPollSeconds: 45 });

      await expect(controller.getPoolSettings()).resolves.toEqual({ poolEnabled: false, poolLocalAffinity: 3, poolHealthPollSeconds: 45 });
    });

    it('passes a partial PATCH straight through, so an omitted field stays unchanged', async () => {
      configuration.setHubPoolPreferences.mockResolvedValue({ poolEnabled: true, poolLocalAffinity: 0, poolHealthPollSeconds: 30 });

      await controller.updatePoolSettings({ poolLocalAffinity: 0 });

      expect(configuration.setHubPoolPreferences).toHaveBeenCalledWith({ poolLocalAffinity: 0 });
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
      );
    });

    it.each(['pending', 'unreachable'])('refuses a %s peer with 403 without touching a backend', async (status) => {
      const res = mockResponse();

      await controller.localOllamaChat(peerRequest({ nodeFqdn: 'hub-b.example-tailnet.ts.net', status }), body, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(proxyService.forwardToLocalBackendAndRespond).not.toHaveBeenCalled();
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
});
