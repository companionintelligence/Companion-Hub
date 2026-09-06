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
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DEFAULT_POOL_HEALTH_POLL_SECONDS, DEFAULT_POOL_LOCAL_AFFINITY, type HubPoolPreferences } from '@/common/helpers/hub-pool';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
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

function capabilitiesWithModel(model: string, overrides: Partial<PoolPeerCapabilities> = {}): PoolPeerCapabilities {
  return {
    hardwareTier: 'high',
    backends: [{ type: 'ollama', healthy: true, modelsLoaded: [model] }],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A connected peer that has the model and reports its own queue depth, as `refreshOnePeer` would have cached it. */
function peerServing(
  id: string,
  model: string,
  options: { inFlightRequests?: number; hardwareTier?: string; lastSeenAt?: string } = {},
): HubPoolPeer {
  return mockPeer({
    id,
    nodeFqdn: `${id}.tailxyz.ts.net`,
    lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
    lastCapabilities: capabilitiesWithModel(model, {
      inFlightRequests: options.inFlightRequests,
      ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
    }) as unknown as Record<string, unknown>,
  });
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
  let configuration: MockProxy<ConfigurationService>;
  // Real, not mocked: ranking is only meaningful against the counter the proxy itself maintains.
  let loadService: HubPoolLoadService;
  // Real too: the ring buffer's contents are the assertion in the routing-log tests.
  let routingLog: HubPoolRoutingLogService;
  let service: PoolProxyService;

  /** Repoint the settings the proxy reads per request, as a settings PATCH would. */
  function setPoolPreferences(overrides: Partial<HubPoolPreferences>): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      ...overrides,
    });
  }

  beforeEach(() => {
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    lemonade = mock<LemonadeBackend>();
    mtplx = mock<MtplxBackend>();
    dspark = mock<DsparkBackend>();
    lucebox = mock<LuceboxBackend>();
    peerService = mock<HubPoolPeerService>();
    tailscaleService = mock<TailscaleService>();
    configuration = mock<ConfigurationService>();
    setPoolPreferences({});

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

    loadService = new HubPoolLoadService();
    routingLog = new HubPoolRoutingLogService();
    service = new PoolProxyService(
      // The real registry over the same six mocks, not a mock registry: a mocked `entries()` would
      // return undefined and quietly drop every local candidate.
      new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox),
      peerService,
      tailscaleService,
      loadService,
      configuration,
      routingLog,
    );
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

  /**
   * Local and peer candidates are ranked in one list, so these assert on the full order rather than
   * on "local, then peers" — the concatenation this replaced made the pool a failover list, where a
   * local backend that merely had the model always won however long its queue was.
   */
  describe('candidate ranking', () => {
    const MODEL = 'llama3.2:3b';

    beforeEach(() => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
    });

    /** Keeps the local node out of a comparison that is only about peers. */
    function withoutLocalCandidate(): void {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    }

    it('hands work to an idle peer once the local node is busier than the affinity margin', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-idle', null]);
    });

    it('keeps work local while the peer is only one request emptier', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const candidates = await service.buildCandidateList(MODEL);

      // One queued request is what the default poolLocalAffinity says the prompt-prefix / KV cache
      // here is worth, so the handoff isn't taken yet.
      expect(candidates.map((c) => c.peerId)).toEqual([null, 'peer-idle']);
    });

    it('hands off at the very first queued request when the operator sets affinity to 0', async () => {
      // 0 is documented as "pure least-loaded" — the same board that stays local at the default.
      setPoolPreferences({ poolLocalAffinity: 0 });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-idle', null]);
    });

    it('keeps work local under a raised affinity where the default would have handed off', async () => {
      setPoolPreferences({ poolLocalAffinity: 5 });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      // Two queued locally: enough to hand off at the default of 1, not at 5.
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual([null, 'peer-idle']);
    });

    it('applies a settings change to the next request rather than the next restart', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual(['peer-idle', null]);

      setPoolPreferences({ poolLocalAffinity: 5 });

      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual([null, 'peer-idle']);
    });

    it('stretches the capability-freshness window with the configured poll interval', async () => {
      // 4 minutes old: stale at the default 30s poll (3 × 30s = 90s), fresh at a 120s one (3 × 120s).
      const peer = peerServing('peer-idle', MODEL, { inFlightRequests: 0, lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString() });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      // Stale: its reported 0 is discarded, so it ranks mid-load (1) + affinity (1) = 2, tying the
      // busy local node, which wins the tie on hardware rank.
      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual([null, 'peer-idle']);

      // A slower poll cadence makes the same snapshot current again — otherwise retuning the
      // interval would silently mark every peer permanently stale.
      setPoolPreferences({ poolHealthPollSeconds: 120 });

      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual(['peer-idle', null]);
    });

    it('ranks a peer whose snapshot has gone stale as mid-load, never as idle', async () => {
      const stale = peerServing('peer-stale', MODEL, { inFlightRequests: 0, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      const fresh = peerServing('peer-fresh', MODEL, { inFlightRequests: 0 });
      // Listed stale-first: insertion order alone would put the node we know nothing about in front.
      peerService.listConnectedPeers.mockResolvedValue([stale, fresh]);

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual([null, 'peer-fresh', 'peer-stale']);
    });

    it('ranks a peer that reports no queue figure at all as mid-load', async () => {
      // A peer on a build from before `inFlightRequests` existed — silence is not idleness.
      const silent = peerServing('peer-silent', MODEL);
      const reporting = peerServing('peer-reporting', MODEL, { inFlightRequests: 0 });
      peerService.listConnectedPeers.mockResolvedValue([silent, reporting]);
      withoutLocalCandidate();

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-reporting', 'peer-silent']);
    });

    it('counts forwards this node has in flight to a peer, not just what that peer last reported', async () => {
      const busy = peerServing('peer-busy', MODEL, { inFlightRequests: 0 });
      const light = peerServing('peer-light', MODEL, { inFlightRequests: 1 });
      peerService.listConnectedPeers.mockResolvedValue([busy, light]);
      withoutLocalCandidate();
      // Sent since peer-busy's last poll, so its own snapshot cannot know about them yet.
      loadService.acquire('peer-busy');
      loadService.acquire('peer-busy');

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-light', 'peer-busy']);
    });

    it('breaks a tie between equally queued peers on the hardware tier they report', async () => {
      const slow = peerServing('peer-low', MODEL, { inFlightRequests: 0, hardwareTier: 'low' });
      const fast = peerServing('peer-high', MODEL, { inFlightRequests: 0, hardwareTier: 'high' });
      peerService.listConnectedPeers.mockResolvedValue([slow, fast]);
      withoutLocalCandidate();

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-high', 'peer-low']);
    });

    it('counts a request a peer forwarded to us as local load for as long as it runs', async () => {
      let respond: (response: globalThis.Response) => void = () => {};
      vi.mocked(global.fetch).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );

      const forwarded = service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', { model: MODEL }, createMockResponse());

      // Otherwise a node saturated by peers' work advertises itself as idle to those same peers.
      expect(loadService.localInFlight()).toBe(1);

      respond(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await forwarded;

      expect(loadService.localInFlight()).toBe(0);
    });

    it('releases the local count when the request it was serving fails', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([]);
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      expect(loadService.localInFlight()).toBe(0);
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

  /**
   * Failover is decided by candidate *kind*, not by status alone: the same 401/403/404 that describes
   * a peer's own pairing hop is the local engine's verdict on the request. These walk both sides of
   * that asymmetry and the peer-first orderings the ranking can produce, which the local-first cases
   * above never reach.
   */
  describe('failover across candidate kinds', () => {
    const MODEL = 'llama3.2:3b';

    /** Ranks the peer ahead of the local node by making local busier than the affinity margin. */
    function peerFirst(peers: HubPoolPeer[]): void {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue(peers);
      peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      peerService.getPresentToken.mockResolvedValue('raw-token');
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
    }

    async function proxy(res = createMockResponse(), path = '/v1/chat/completions'): Promise<void> {
      await service.proxyRequest({ path, method: 'POST', body: { model: MODEL }, model: MODEL, res });
    }

    it('falls back to the local engine when the peer it preferred 5xxs', async () => {
      peerFirst([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response('peer exploded', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse();
      await proxy(res);

      // The saturated-local-node case has to survive its chosen peer dying, or handing work off is a
      // downgrade on availability.
      expect(fetchMock.mock.calls[0]?.[0]).toContain('peer-idle.tailxyz.ts.net');
      expect(fetchMock.mock.calls[1]?.[0]).toContain('local-ollama');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(routingLog.list()[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, attempt: 2, failedOverFrom: ['peer-idle.tailxyz.ts.net'] });
    });

    it('moves on when a peer 404s the forward, which is how an older build without this route answers', async () => {
      peerFirst([peerServing('peer-old', MODEL, { inFlightRequests: 0 })]);
      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(new Response('Cannot POST /api/inference/pool/local/api/embed', { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      const res = createMockResponse();
      await proxy(res, '/api/embed');

      // A peer missing the route says nothing about the app's request — a 404 passed through here
      // would break every app on this node because of a version skew on another one.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('passes a local 404 straight through instead of retrying it on a peer', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response('model not found', { status: 404 }));

      const res = createMockResponse();
      await proxy(res, '/api/embed');

      // Same status, opposite meaning: from our own engine it is the engine's verdict on the request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('passes a peer 400 through rather than replaying a malformed request across the fleet', async () => {
      peerFirst([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }));

      const res = createMockResponse();
      await proxy(res);

      expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('walks peer → peer → local before giving up, and names the whole chain', async () => {
      peerFirst([peerServing('peer-a', MODEL, { inFlightRequests: 0 }), peerServing('peer-b', MODEL, { inFlightRequests: 0 })]);
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      const res = createMockResponse();
      await proxy(res);

      expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(3);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'failed',
        failedOverFrom: ['peer-a.tailxyz.ts.net', 'peer-b.tailxyz.ts.net', LOCAL_CANDIDATE_KEY],
      });
    });

    it('leaves no in-flight count behind on the candidate it abandoned', async () => {
      peerFirst([peerServing('peer-a', MODEL, { inFlightRequests: 0 })]);
      vi.mocked(global.fetch)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await proxy();

      // A leaked count would make this node look permanently busier than it is, and would push work
      // to peers that do not need it — the failure mode is silent and never self-corrects.
      expect(loadService.get('peer-a')).toBe(0);
      expect(loadService.localInFlight()).toBe(2);
    });
  });

  /**
   * Nothing else in the module records which node served a request, so these assert against the
   * real request path rather than a hand-built record.
   */
  describe('routing log', () => {
    const MODEL = 'llama3.2:3b';

    function servingPeer(): HubPoolPeer {
      return mockPeer({ lastCapabilities: capabilitiesWithModel(MODEL) as unknown as Record<string, unknown> });
    }

    it('records a locally-served request as one entry with no failover chain', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      const entries = routingLog.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        direction: 'outbound',
        path: '/v1/chat/completions',
        model: MODEL,
        node: LOCAL_CANDIDATE_KEY,
        peerId: null,
        backend: 'ollama',
        candidates: 1,
        attempt: 1,
        failedOverFrom: [],
        outcome: 'served',
        status: 200,
      });
      expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records a failover as ONE entry naming the node it came from, not one entry per attempt', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      const peer = servingPeer();
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('server error', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      const entries = routingLog.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        node: 'peer-hub.tailxyz.ts.net',
        peerId: 'peer-1',
        attempt: 2,
        candidates: 2,
        failedOverFrom: [LOCAL_CANDIDATE_KEY],
        outcome: 'served',
        status: 200,
      });
      expect(routingLog.summary()).toMatchObject({ recorded: 1, served: 1, failovers: 1 });
    });

    it('records a request that no candidate could serve, with the whole chain that was tried', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      const peer = servingPeer();
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      expect(routingLog.list()[0]).toMatchObject({
        node: null,
        backend: null,
        outcome: 'failed',
        status: null,
        failedOverFrom: [LOCAL_CANDIDATE_KEY, 'peer-hub.tailxyz.ts.net'],
      });
    });

    it('records a request no node had the model for', async () => {
      await service.proxyRequest({
        path: '/v1/chat/completions',
        method: 'POST',
        body: { model: 'missing' },
        model: 'missing',
        res: createMockResponse(),
      });

      expect(routingLog.list()[0]).toMatchObject({ model: 'missing', candidates: 0, outcome: 'failed', node: null });
    });

    it('records work a peer forwarded to this node, attributed to the peer the guard authenticated', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/v1/chat/completions',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'peer-hub.tailxyz.ts.net',
      );

      expect(routingLog.list()[0]).toMatchObject({
        direction: 'inbound',
        node: 'peer-hub.tailxyz.ts.net',
        backend: 'ollama',
        outcome: 'served',
        status: 200,
        // The peer's body is passed through untouched, so the model it asked for is never parsed.
        model: null,
      });
    });

    it('records a peer forward once even when the client dies mid-stream', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await expect(
        service.forwardToLocalBackendAndRespond(
          'ollama',
          '/v1/chat/completions',
          'POST',
          { model: MODEL },
          createMockResponse({ writeFails: true }),
          'peer-hub.tailxyz.ts.net',
        ),
      ).rejects.toThrow();

      // The backend answered; a stream that then dies is the same routing decision, not a second one.
      expect(routingLog.list()).toHaveLength(1);
      expect(routingLog.list()[0]).toMatchObject({ direction: 'inbound', status: 200, outcome: 'served' });
    });

    it('never records the request body or the response, only routing metadata', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ text: 'the answer' }] }), { status: 200 }));

      await service.proxyRequest({
        path: '/v1/chat/completions',
        method: 'POST',
        body: { model: MODEL, messages: [{ role: 'user', content: 'my private prompt' }] },
        model: MODEL,
        res: createMockResponse(),
      });

      const serialized = JSON.stringify(routingLog.list());
      expect(serialized).not.toContain('my private prompt');
      expect(serialized).not.toContain('the answer');
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
