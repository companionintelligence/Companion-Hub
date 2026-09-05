import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Response } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { MtplxBackend } from '@/modules/inference/backends/mtplx.backend';
import { DsparkBackend } from '@/modules/inference/backends/dspark.backend';
import { LuceboxBackend } from '@/modules/inference/backends/lucebox.backend';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { PoolProxyService } from '../hub-pool-proxy.service';
import type { PoolPeerCapabilities } from '../hub-pool.types';

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: 'Peer Hub',
    direction: 'outbound',
    status: 'connected',
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: null,
    verifyTokenHash: 'hash',
    presentTokenEncrypted: 'encrypted',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function capabilitiesWithModel(model: string): PoolPeerCapabilities {
  return {
    hardwareTier: 'high',
    backends: [{ type: 'ollama', healthy: true, modelsLoaded: [model] }],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A real Writable so node:stream/promises `pipeline()` can drive it, plus the subset of Express's
 * Response API the service calls, as spies so tests can assert on them. `writeFails` simulates the
 * client vanishing mid-stream — the only way to reach the post-commit failure path.
 */
function createMockResponse(options: { writeFails?: boolean } = {}): Response & { chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      if (options.writeFails) {
        cb(new Error('client went away'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  }) as unknown as Response & { chunks: Buffer[] };
  // pipeline() destroys the destination on failure, which emits 'error'; nothing else listens here.
  writable.on('error', () => {});
  writable.chunks = chunks;
  writable.status = vi.fn().mockReturnValue(writable) as unknown as Response['status'];
  writable.setHeader = vi.fn().mockReturnValue(writable) as unknown as Response['setHeader'];
  writable.json = vi.fn().mockReturnValue(writable) as unknown as Response['json'];
  return writable;
}

describe('PoolProxyService', () => {
  let ollama: MockProxy<OllamaBackend>;
  let vllm: MockProxy<VllmBackend>;
  let lemonade: MockProxy<LemonadeBackend>;
  let mtplx: MockProxy<MtplxBackend>;
  let dspark: MockProxy<DsparkBackend>;
  let lucebox: MockProxy<LuceboxBackend>;
  let peerService: MockProxy<HubPoolPeerService>;
  let tailscaleService: MockProxy<TailscaleService>;
  let service: PoolProxyService;

  beforeEach(() => {
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    lemonade = mock<LemonadeBackend>();
    mtplx = mock<MtplxBackend>();
    dspark = mock<DsparkBackend>();
    lucebox = mock<LuceboxBackend>();
    peerService = mock<HubPoolPeerService>();
    tailscaleService = mock<TailscaleService>();

    for (const backend of [ollama, vllm, lemonade, mtplx, dspark, lucebox]) {
      backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    }
    ollama.getBaseUrl.mockReturnValue('http://local-ollama:11434');
    peerService.listConnectedPeers.mockResolvedValue([]);
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

    service = new PoolProxyService(ollama, vllm, lemonade, mtplx, dspark, lucebox, peerService, tailscaleService);
    global.fetch = vi.fn();
  });

  describe('buildCandidateList', () => {
    it('includes the local backend when it is healthy and reports the model', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });

      const candidates = await service.buildCandidateList('llama3.2:3b');

      expect(candidates).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('excludes the local backend when the model is not in its live inventory', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['some-other-model'] });

      const candidates = await service.buildCandidateList('llama3.2:3b');

      expect(candidates).toEqual([]);
    });

    it('includes a connected peer whose cached capabilities report the model', async () => {
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);

      const candidates = await service.buildCandidateList('llama3.2:3b');

      expect(candidates).toEqual([{ peerId: 'peer-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', backend: 'ollama' }]);
    });
  });

  describe('proxyRequest', () => {
    it('returns 502 when no candidate has the model', async () => {
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'missing' }, model: 'missing', res });

      expect(res.status).toHaveBeenCalledWith(502);
    });

    it('fails over to a connected peer when the local candidate 5xxs', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');

      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response('server error', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('local-ollama');
      expect(fetchMock.mock.calls[1]?.[0]).toContain('peer-hub.tailxyz.ts.net');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('does NOT fail over on an ordinary 4xx from the first candidate', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      // Only the local candidate should have been called — a 4xx is the caller's problem, not a
      // signal to retry elsewhere.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('passes a local 401 through instead of retrying it elsewhere', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad api key' }), { status: 401 }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('fails over on a 429 from the local engine — an overloaded node should shed work to a peer', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');

      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response('busy', { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('fails over when a peer answers 401, and drops its cached capabilities', async () => {
      const capabilities = capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown>;
      const peerA = mockPeer({ id: 'peer-a', nodeFqdn: 'a.tailxyz.ts.net', lastCapabilities: capabilities });
      const peerB = mockPeer({ id: 'peer-b', nodeFqdn: 'b.tailxyz.ts.net', lastCapabilities: capabilities });
      peerService.listConnectedPeers.mockResolvedValue([peerA, peerB]);
      peerService.getPeerById.mockImplementation(async (id) => (id === 'peer-a' ? peerA : peerB));
      peerService.getPresentToken.mockResolvedValue('raw-token');

      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        // peerA no longer holds our row: its PoolPeerGuard 401s. That is the transport rejecting
        // us, not a verdict on the caller's request.
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toContain('b.tailxyz.ts.net');
      expect(peerService.clearCachedCapabilities).toHaveBeenCalledWith('peer-a');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('fails over when the first candidate fails BEFORE the response is committed', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.status).toHaveBeenCalledTimes(1);
    });

    it('does NOT fail over when the stream dies AFTER the response is committed', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse({ writeFails: true });
      const destroySpy = vi.spyOn(res, 'destroy');

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      // The local candidate already flushed status + headers, so the peer must not be tried: a
      // second candidate writing into a committed response is ERR_HTTP_HEADERS_SENT.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).not.toHaveBeenCalled();
      expect(destroySpy).toHaveBeenCalled();
    });
  });

  describe('proxyLocalOnlyRequest', () => {
    it('serves an Ollama native that has no model to route on from the local engine', async () => {
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/show', 'POST', { model: 'llama3.2:3b' }, res);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://local-ollama:11434/api/show');
      expect(JSON.parse(init.body as string)).toEqual({ model: 'llama3.2:3b' });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('502s when no local backend can serve the path', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/version', 'GET', undefined, res);

      expect(res.status).toHaveBeenCalledWith(502);
    });
  });
});
