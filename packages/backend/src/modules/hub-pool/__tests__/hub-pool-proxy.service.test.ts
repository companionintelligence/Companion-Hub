import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Logger } from '@nestjs/common';
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
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import {
  AUTO_MODEL,
  POOL_BACKEND_HEADER,
  POOL_MODEL_HEADER,
  POOL_SERVED_BY_HEADER,
  POOL_SERVED_LOCALLY,
  PoolProxyService,
  describeUnresolvableAuto,
  servedByHeaders,
} from '../hub-pool-proxy.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { PoolPeerCapabilities } from '../hub-pool.types';

function mockPeer(overrides: Partial<HubPoolPeer> = {}): HubPoolPeer {
  return {
    id: 'peer-1',
    tailscaleDeviceId: null,
    nodeFqdn: 'peer-hub.tailxyz.ts.net',
    displayName: 'Peer Hub',
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: null,
    verifyTokenHash: 'hash',
    presentTokenEncrypted: 'encrypted',
    peerNodeUuid: null,
    peerPublicKey: null,
    bearerGraceUntil: null,
    signedSeenAt: null,
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
  options: { inFlightRequests?: number; hardwareTier?: string; lastSeenAt?: string; gpuPressure?: unknown } = {},
): HubPoolPeer {
  return mockPeer({
    id,
    nodeFqdn: `${id}.tailxyz.ts.net`,
    lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
    lastCapabilities: capabilitiesWithModel(model, {
      inFlightRequests: options.inFlightRequests,
      ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
      // `unknown`, not `number`: the whole point of the peerPressure clamp is that this arrives as
      // free-form jsonb a paired peer controls, so the hostile cases have to be expressible here.
      ...('gpuPressure' in options ? { gpuPressure: options.gpuPressure as number } : {}),
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

/** Every header the service has set on the mock so far, lower-cased so assertions read like the wire. */
function headersSetOn(res: Response): Record<string, string> {
  return Object.fromEntries(vi.mocked(res.setHeader).mock.calls.map(([name, value]) => [String(name).toLowerCase(), String(value)]));
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
  let pressureService: MockProxy<HubPoolPressureService>;
  let service: PoolProxyService;

  /** Repoint the settings the proxy reads per request, as a settings PATCH would. */
  function setPoolPreferences(overrides: Partial<HubPoolPreferences>): void {
    configuration.getHubPoolPreferences.mockReturnValue({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: DEFAULT_POOL_HEALTH_POLL_SECONDS,
      poolPins: [],
      poolPressureWeight: DEFAULT_POOL_PRESSURE_WEIGHT,
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
    pressureService = mock<HubPoolPressureService>();
    // The fleet default: this node cannot measure its GPU, so it ranks neutral.
    pressureService.band.mockReturnValue(null);
    pressureService.source.mockReturnValue(null);
    service = new PoolProxyService(
      // The real registry over the same six mocks, not a mock registry: a mocked `entries()` would
      // return undefined and quietly drop every local candidate.
      new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox),
      peerService,
      tailscaleService,
      loadService,
      configuration,
      routingLog,
      pressureService,
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

    /**
     * The fleet node this guards against: core-4 answered `GET /api/tags` 200 listing `gemma3:1b`
     * while every `POST /api/generate` for it returned HTTP 500 `model failed to load`. Selecting
     * on the inventory alone made it a first-choice candidate for a model it failed 100% of
     * requests for — and the same claim went to every peer as this node's advertised capabilities.
     */
    it('excludes a local backend that lists the model but has been unable to serve it', async () => {
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['gemma3:1b'],
        unservableModels: ['gemma3:1b'],
      });

      const candidates = await service.buildCandidateList('gemma3:1b');

      expect(candidates).toEqual([]);
    });

    it('still offers a backend for the models it CAN serve', async () => {
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['gemma3:1b', 'llama3.2:3b'],
        unservableModels: ['gemma3:1b'],
      });

      // A node that cannot fit one model is still the right place for the ones it can fit.
      expect(await service.buildCandidateList('llama3.2:3b')).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('hands the request to a peer when the local engine cannot serve the model it lists', async () => {
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['gemma3:1b'],
        unservableModels: ['gemma3:1b'],
      });
      peerService.listConnectedPeers.mockResolvedValue([
        mockPeer({ lastCapabilities: capabilitiesWithModel('gemma3:1b') as unknown as Record<string, unknown> }),
      ]);

      const candidates = await service.buildCandidateList('gemma3:1b');

      expect(candidates).toEqual([{ peerId: 'peer-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', backend: 'ollama' }]);
    });

    it('includes a connected peer whose cached capabilities report the model', async () => {
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);

      const candidates = await service.buildCandidateList('llama3.2:3b');

      expect(candidates).toEqual([{ peerId: 'peer-1', nodeFqdn: 'peer-hub.tailxyz.ts.net', backend: 'ollama' }]);
    });
  });

  /**
   * The outbound half of the kill switch, plus the per-peer one.
   *
   * Both are applied HERE and not in `HubPoolPeerService.listConnectedPeers`, which is why these
   * tests assert that `listConnectedPeers` is still consulted (and so still returns the peer) while
   * the candidate list comes back local-only. Gating the service method instead would flip
   * `hasConnectedPeers()`, which `inference-env-resolver.ts` bakes into an app's `CI_LLM_BASE_URL`
   * at install time — permanently repointing every app created while the switch was off.
   */
  describe('outbound and per-peer kill switches', () => {
    const MODEL = 'llama3.2:3b';

    beforeEach(() => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
    });

    it('produces a local-only candidate list when outbound pooling is off', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      // Loaded enough that the peer would win outright if the switch were not in force.

      setPoolPreferences({ poolOutboundEnabled: false });

      expect(await service.buildCandidateList(MODEL)).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('returns the actionable 502 rather than shipping the request out when outbound is off and the model is not local', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['some-other-model'] });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      setPoolPreferences({ poolOutboundEnabled: false });
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      expect(res.status).toHaveBeenCalledWith(502);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('drops one disabled peer while a second, enabled peer is still ranked', async () => {
      const disabled = peerServing('peer-off', MODEL, { inFlightRequests: 0 });
      peerService.listConnectedPeers.mockResolvedValue([{ ...disabled, enabled: false }, peerServing('peer-on', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      const candidates = await service.buildCandidateList(MODEL);

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-on', null]);
    });

    it('skips a peer that says it is not accepting work, on the flag and not on an empty inventory', async () => {
      // A peer with inbound switched off publishes `acceptingWork: false` AND an empty inventory.
      // Asserting on a peer that still lists the model proves the flag itself is what we honour —
      // the empty list is only the fallback an older sender has.
      const refusing = peerServing('peer-refusing', MODEL, { inFlightRequests: 0 });
      peerService.listConnectedPeers.mockResolvedValue([
        {
          ...refusing,
          lastCapabilities: capabilitiesWithModel(MODEL, { inFlightRequests: 0, acceptingWork: false }) as unknown as Record<string, unknown>,
        },
      ]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      expect(await service.buildCandidateList(MODEL)).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('treats an absent acceptingWork as yes, so a peer on an older build still receives work', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-old', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual(['peer-old', null]);
    });

    it('ranks exactly as before when both switches are at their defaults', async () => {
      // The single-node/untouched-settings guarantee, asserted on the ranking itself.
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0 })]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      expect((await service.buildCandidateList(MODEL)).map((c) => c.peerId)).toEqual(['peer-idle', null]);
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

  describe('GPU-pressure ranking', () => {
    const MODEL = 'llama3.2:3b';

    /** Every ranking assertion below is about the pressure key, so keep local out of the list. */
    function withoutLocalCandidate(): void {
      ollama.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    }

    describe('the default (poolPressureWeight = 0) changes nothing', () => {
      it('does not reorder a tie that pressure would otherwise decide', async () => {
        // Same two peers, same everything except the band. At weight 0 the pressure key is not in
        // the comparator at all, so the static hardware tier still decides — and 'low' still loses.
        const calmButSlow = peerServing('peer-calm', MODEL, { inFlightRequests: 0, hardwareTier: 'low', gpuPressure: 0 });
        const busyButFast = peerServing('peer-busy', MODEL, { inFlightRequests: 0, hardwareTier: 'high', gpuPressure: 3 });
        peerService.listConnectedPeers.mockResolvedValue([calmButSlow, busyButFast]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        expect(candidates.map((c) => c.peerId)).toEqual(['peer-busy', 'peer-calm']);
      });

      it('keeps local first even when local is saturated and a peer reports band 0', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        pressureService.band.mockReturnValue(3);
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-calm', MODEL, { inFlightRequests: 0, gpuPressure: 0 })]);

        const candidates = await service.buildCandidateList(MODEL);

        // Byte-identical to the pre-pressure build: local scores 0, the peer scores 0 + affinity 1.
        expect(candidates[0]).toEqual({ peerId: null, nodeFqdn: null, backend: 'ollama' });
      });
    });

    describe('an unmeasured node ranks NEUTRAL, never idle', () => {
      it('does not let a silent peer outrank one that reported band 0', async () => {
        setPoolPreferences({ poolPressureWeight: 1 });
        const silent = peerServing('peer-silent', MODEL, { inFlightRequests: 0 });
        const measuredIdle = peerServing('peer-idle', MODEL, { inFlightRequests: 0, gpuPressure: 0 });
        peerService.listConnectedPeers.mockResolvedValue([silent, measuredIdle]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        // THE invariant of this feature. Silence is worth UNKNOWN_PRESSURE (1), so a node that
        // measured itself idle beats one that said nothing. If absence read as 0, the pool would
        // systematically prefer whichever machine knows least about itself — and on this fleet most
        // nodes cannot measure at all, so that is the common case rather than the exception.
        expect(candidates.map((c) => c.peerId)).toEqual(['peer-idle', 'peer-silent']);
      });

      it('ranks a silent peer AHEAD of one that reported band 2, so silence is mid and not worst', async () => {
        setPoolPreferences({ poolPressureWeight: 1 });
        const loaded = peerServing('peer-loaded', MODEL, { inFlightRequests: 0, gpuPressure: 2 });
        const silent = peerServing('peer-silent', MODEL, { inFlightRequests: 0 });
        peerService.listConnectedPeers.mockResolvedValue([loaded, silent]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        expect(candidates.map((c) => c.peerId)).toEqual(['peer-silent', 'peer-loaded']);
      });

      it('treats a local node that cannot measure as neutral rather than idle', async () => {
        setPoolPreferences({ poolPressureWeight: 1, poolLocalAffinity: 0 });
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        pressureService.band.mockReturnValue(null);
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', MODEL, { inFlightRequests: 0, gpuPressure: 0 })]);

        const candidates = await service.buildCandidateList(MODEL);

        // Local is unmeasured (1) against a peer that measured 0, and with affinity out of the way
        // the measured-idle peer wins. The sending side of the same invariant: this node does not
        // get to call itself idle just because it has no counter.
        expect(candidates[0]?.peerId).toBe('peer-idle');
      });

      it('discards a stale peer band, leaving it neutral rather than believing its 0', async () => {
        setPoolPreferences({ poolPressureWeight: 1 });
        const stale = peerServing('peer-stale', MODEL, {
          inFlightRequests: 0,
          gpuPressure: 0,
          lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        });
        const fresh = peerServing('peer-fresh', MODEL, { inFlightRequests: 0, gpuPressure: 0 });
        peerService.listConnectedPeers.mockResolvedValue([stale, fresh]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        // Staleness makes the whole snapshot unbelievable, load and pressure alike — and a stale 0
        // is exactly the value a wedged node keeps advertising while its card burns.
        expect(candidates.map((c) => c.peerId)).toEqual(['peer-fresh', 'peer-stale']);
      });
    });

    describe('with the weight turned on', () => {
      beforeEach(() => setPoolPreferences({ poolPressureWeight: 1 }));

      it('prefers the calmer of two equally queued peers', async () => {
        const calm = peerServing('peer-calm', MODEL, { inFlightRequests: 0, gpuPressure: 0 });
        const busy = peerServing('peer-busy', MODEL, { inFlightRequests: 0, gpuPressure: 3 });
        peerService.listConnectedPeers.mockResolvedValue([busy, calm]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        expect(candidates.map((c) => c.peerId)).toEqual(['peer-calm', 'peer-busy']);
      });

      it('does not let a calm peer outrank one with a materially shorter queue', async () => {
        const calmButQueued = peerServing('peer-queued', MODEL, { inFlightRequests: 4, gpuPressure: 0 });
        const busyButFree = peerServing('peer-free', MODEL, { inFlightRequests: 0, gpuPressure: 3 });
        peerService.listConnectedPeers.mockResolvedValue([calmButQueued, busyButFree]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        // Queue depth is work already accepted; pressure is a statement about the device. At weight
        // 1 a full band is worth three queued requests, and four of them still outweighs it.
        expect(candidates.map((c) => c.peerId)).toEqual(['peer-free', 'peer-queued']);
      });

      it('hands work to a calm peer when this node is queue-idle but its GPU is committed', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        pressureService.band.mockReturnValue(3);
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-calm', MODEL, { inFlightRequests: 0, gpuPressure: 0 })]);

        const candidates = await service.buildCandidateList(MODEL);

        // Local: 0 queued + 1x3 pressure = 3. Peer: 0 + 1x0 + affinity 1 = 1. This is the case the
        // feature exists for — a GPU busy with work that never came through the pool (ComfyUI, a
        // direct `ollama run`, another orchestrator) is invisible to every queue counter we have.
        expect(candidates[0]?.peerId).toBe('peer-calm');
      });

      it('applies a weight change on the next request, not the next restart', async () => {
        const calm = peerServing('peer-calm', MODEL, { inFlightRequests: 0, gpuPressure: 0, hardwareTier: 'low' });
        const busy = peerServing('peer-busy', MODEL, { inFlightRequests: 0, gpuPressure: 3, hardwareTier: 'high' });
        peerService.listConnectedPeers.mockResolvedValue([calm, busy]);
        withoutLocalCandidate();

        setPoolPreferences({ poolPressureWeight: 0 });
        const before = await service.buildCandidateList(MODEL);
        setPoolPreferences({ poolPressureWeight: 1 });
        const after = await service.buildCandidateList(MODEL);

        expect(before.map((c) => c.peerId)).toEqual(['peer-busy', 'peer-calm']);
        expect(after.map((c) => c.peerId)).toEqual(['peer-calm', 'peer-busy']);
      });
    });

    describe('a paired peer controls this value, so it is clamped on the read path', () => {
      beforeEach(() => setPoolPreferences({ poolPressureWeight: 1 }));

      it.each([
        ['a negative band', -5],
        ['an out-of-range band', 99],
        ['a fractional band', 1.5],
        ['a string', 'low'],
        ['null', null],
        ['NaN', Number.NaN],
      ])('clamps %s to neutral, so it cannot win a tie', async (_label, hostile) => {
        const liar = peerServing('peer-liar', MODEL, { inFlightRequests: 0, gpuPressure: hostile });
        const honest = peerServing('peer-honest', MODEL, { inFlightRequests: 0, gpuPressure: 0 });
        peerService.listConnectedPeers.mockResolvedValue([liar, honest]);
        withoutLocalCandidate();

        const candidates = await service.buildCandidateList(MODEL);

        // The negative one matters most: used raw it would beat every honest 0 forever, and it costs
        // a peer nothing to send. Everything hostile lands on UNKNOWN_PRESSURE instead.
        expect(candidates.map((c) => c.peerId)).toEqual(['peer-honest', 'peer-liar']);
      });

      it('floors a self-reported 0 by what this node has actually forwarded there', async () => {
        const pinnedAtZero = peerServing('peer-lying', MODEL, { inFlightRequests: 0, gpuPressure: 0 });
        const honest = peerServing('peer-honest', MODEL, { inFlightRequests: 0, gpuPressure: 1 });
        peerService.listConnectedPeers.mockResolvedValue([pinnedAtZero, honest]);
        withoutLocalCandidate();
        // Two requests of ours are running there right now. Whatever it claims, it is not idle.
        loadService.acquire('peer-lying');
        loadService.acquire('peer-lying');

        const candidates = await service.buildCandidateList(MODEL);

        // Without the floor, a peer that hardcodes gpuPressure: 0 wins every tie forever and the
        // band is an attack surface rather than a signal.
        expect(candidates.map((c) => c.peerId)).toEqual(['peer-honest', 'peer-lying']);
      });
    });
  });

  describe('proxyRequest', () => {
    it('attaches whatever credential peerAuthHeaders produced, and nothing of its own', async () => {
      // One helper decides between the signature and the bearer token, on both sides of the wire.
      // The proxy must not second-guess it: a hand-built `Authorization` here is exactly how the
      // client rule and the guard's no-downgrade rule would drift apart.
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.peerAuthHeaders.mockResolvedValue({
        'X-Hub-Pool-Node': 'a-node-uuid',
        'X-Hub-Pool-Peer': 'self-hub.tailxyz.ts.net',
        'X-Hub-Pool-Signature': 'v1.ed25519.zzz',
      });

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers['X-Hub-Pool-Signature']).toBe('v1.ed25519.zzz');
      expect(headers).not.toHaveProperty('Authorization');
      // The two routing headers the receiving handler cannot infer from the path are still ours.
      expect(headers['X-Hub-Pool-Backend']).toBe('ollama');
      expect(headers['X-Hub-Pool-Model']).toBe('llama3.2:3b');
      // Signed over the `/api`-prefixed path the peer will actually see, query already stripped.
      expect(peerService.peerAuthHeaders).toHaveBeenCalledWith(peer, 'POST', '/api/inference/pool/local/v1/chat/completions', {
        model: 'llama3.2:3b',
      });
    });

    it('still sends a bearer-only peer exactly what it sent before', async () => {
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel('llama3.2:3b') as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.peerAuthHeaders.mockResolvedValue({ 'X-Hub-Pool-Peer': 'self-hub.tailxyz.ts.net', Authorization: 'Bearer raw-token' });

      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));

      const res = createMockResponse();
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer raw-token');
      expect(headers['X-Hub-Pool-Peer']).toBe('self-hub.tailxyz.ts.net');
    });

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
   * The caller could not learn which node ran its request from the response at all: the routing log
   * knows, but it is session-gated, in-memory and gone on restart. Proving cross-node routing on the
   * fleet came down to asking a node for a model it does not have and checking `ollama ps` on the
   * far side. These pin the contract that replaces that: the decision is on the response, it is on
   * the wire before the first streamed byte, and nothing it says is something the caller could not
   * already know.
   */
  describe('serving-node attribution', () => {
    const MODEL = 'llama3.2:3b';
    const SELF_FQDN = 'self-hub.tailxyz.ts.net';
    const PEER_FQDN = 'peer-hub.tailxyz.ts.net';

    function peerHasModel(): HubPoolPeer {
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel(MODEL) as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');
      return peer;
    }

    async function route(res: Response, body: Record<string, unknown> = { model: MODEL }): Promise<void> {
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body, model: MODEL, res });
    }

    it('builds the three headers from the candidate, and only from the candidate', () => {
      expect(servedByHeaders({ peerId: 'peer-1', nodeFqdn: PEER_FQDN, backend: 'vllm' }, MODEL)).toEqual({
        [POOL_SERVED_BY_HEADER]: PEER_FQDN,
        [POOL_BACKEND_HEADER]: 'vllm',
        [POOL_MODEL_HEADER]: MODEL,
      });
      expect(servedByHeaders({ peerId: null, nodeFqdn: null, backend: 'ollama' }, MODEL)[POOL_SERVED_BY_HEADER]).toBe(POOL_SERVED_LOCALLY);
    });

    it('names the peer, its engine and the model on a response it proxied', async () => {
      peerHasModel();
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
      const res = createMockResponse();

      await route(res);

      const headers = headersSetOn(res);
      expect(headers['x-hub-pool-served-by']).toBe(PEER_FQDN);
      expect(headers['x-hub-pool-backend']).toBe('ollama');
      expect(headers['x-hub-pool-model']).toBe(MODEL);
      // The upstream's own headers still come through beside the attribution.
      expect(headers['content-type']).toBe('application/json');
    });

    /**
     * The common path: `poolLocalAffinity` defaults to 1, so with both nodes idle and both holding
     * the model the local engine wins. A caller must be able to tell that apart from a proxied
     * response — and the answer is the routing log's word `local`, never this node's own MagicDNS
     * name, which `identify` deliberately stopped handing to unauthenticated callers.
     */
    it('marks a response this node served itself as local, and never discloses its own name', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerHasModel();
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await route(res);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('local-ollama');
      const headers = headersSetOn(res);
      expect(headers['x-hub-pool-served-by']).toBe(POOL_SERVED_LOCALLY);
      expect(headers['x-hub-pool-backend']).toBe('ollama');
      expect(headers['x-hub-pool-model']).toBe(MODEL);
      expect(Object.values(headers).join(' ')).not.toContain(SELF_FQDN);
    });

    it('names the node that actually answered after a failover, not the one tried first', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerHasModel();
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('server error', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await route(res);

      expect(headersSetOn(res)['x-hub-pool-served-by']).toBe(PEER_FQDN);
      // Set exactly once: the rejected local attempt never reached the commit, so it left nothing behind.
      const servedBySets = vi.mocked(res.setHeader).mock.calls.filter(([name]) => String(name).toLowerCase() === 'x-hub-pool-served-by');
      expect(servedBySets).toHaveLength(1);
    });

    /**
     * `stream: true` is the common shape of a chat completion, and Node flushes headers on the first
     * body write — anything set after that is ERR_HTTP_HEADERS_SENT. So the assertion is not "the
     * header was set" but "it was already set when the first chunk reached the client".
     */
    it('has the attribution on the wire before the first streamed chunk', async () => {
      peerHasModel();
      const encoder = new TextEncoder();
      const frames = ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

      const res = createMockResponse();
      let headersAtFirstChunk: Record<string, string> | null = null;
      const write = res._write.bind(res);
      res._write = (chunk, encoding, callback) => {
        headersAtFirstChunk ??= headersSetOn(res);
        write(chunk, encoding, callback);
      };

      await route(res, { model: MODEL, stream: true });

      expect(headersAtFirstChunk).not.toBeNull();
      expect(headersAtFirstChunk?.['x-hub-pool-served-by']).toBe(PEER_FQDN);
      expect(headersAtFirstChunk?.['x-hub-pool-backend']).toBe('ollama');
      expect(headersAtFirstChunk?.['x-hub-pool-model']).toBe(MODEL);
      expect(Buffer.concat(res.chunks).toString()).toBe(frames.join(''));
    });

    /**
     * Attribution is THIS Hub's statement about the decision it made. A peer's `/local/*` answer is
     * an upstream like any other, and whatever `x-hub-pool-*` it carries — a spoofed served-by, or
     * the node UUID that only ever belongs on the signed request path — must not reach the caller.
     */
    it('never relays an upstream x-hub-pool-* header, and its own attribution wins', async () => {
      peerHasModel();
      vi.mocked(global.fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-hub-pool-served-by': 'somewhere-else.tailxyz.ts.net',
            'x-hub-pool-node': '0f4a1c2e-uuid-of-the-peer',
            'x-hub-pool-backend': 'vllm',
          },
        }),
      );
      const res = createMockResponse();

      await route(res);

      const headers = headersSetOn(res);
      expect(headers['x-hub-pool-served-by']).toBe(PEER_FQDN);
      expect(headers['x-hub-pool-backend']).toBe('ollama');
      expect(headers).not.toHaveProperty('x-hub-pool-node');
      expect(Object.values(headers).join(' ')).not.toContain('somewhere-else');
      expect(Object.values(headers).join(' ')).not.toContain('uuid-of-the-peer');
      expect(headers['content-type']).toBe('application/json');
    });

    it('carries no attribution on the 502 for a model nothing can serve', async () => {
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'missing' }, model: 'missing', res });

      expect(res.status).toHaveBeenCalledWith(502);
      expect(headersSetOn(res)).not.toHaveProperty('x-hub-pool-served-by');
    });
  });

  /**
   * A live request is the only thing that finds out whether a model can actually be served — the
   * health poll cannot, because the only proof is a generation, and generating on every poll would
   * pull every listed model into VRAM on the poll cadence. So what the request learns is fed back
   * to the engine that answered, and the next candidate list knows it.
   */
  describe('serving-capability feedback to the local engine', () => {
    const MODEL = 'gemma3:1b';

    /** The local Ollama lists the model; whether it can serve it is what these tests are about. */
    function localHasModel(): void {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
    }

    async function proxy(res = createMockResponse()): Promise<void> {
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });
    }

    it('reports a 5xx back to the engine that produced it', async () => {
      localHasModel();
      vi.mocked(global.fetch).mockResolvedValue(new Response('model failed to load', { status: 500 }));

      await proxy();

      expect(ollama.noteServingFailure).toHaveBeenCalledWith(MODEL, 'HTTP 500');
    });

    it('does not blame the model for a 429', async () => {
      localHasModel();
      vi.mocked(global.fetch).mockResolvedValue(new Response('busy', { status: 429 }));

      await proxy();

      // 429 and 408 fail over too, but they are the engine talking about its queue, not about the
      // model. Withholding a model because the node was briefly busy turns shedding into an outage.
      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
    });

    it('does not blame the model for a caller 4xx', async () => {
      localHasModel();
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }));

      await proxy();

      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
      // A 4xx is the engine's verdict on the request, not proof the model runs, so it clears nothing either.
      expect(ollama.noteServingSuccess).not.toHaveBeenCalled();
    });

    it('clears the record when the engine actually serves the model', async () => {
      localHasModel();
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await proxy();

      expect(ollama.noteServingSuccess).toHaveBeenCalledWith(MODEL);
    });

    it('does not charge the local engine for a peer 5xx', async () => {
      // The local node has nothing to do with this request, and a 500 relayed through a peer says
      // nothing about which of THAT node's backends failed — the peer corrects its own capabilities.
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel(MODEL) as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');
      vi.mocked(global.fetch).mockResolvedValue(new Response('server error', { status: 500 }));

      await proxy();

      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
      expect(ollama.noteServingSuccess).not.toHaveBeenCalled();
    });

    /**
     * A node serving only peer traffic never runs `proxyRequest`, so before the inbound path fed
     * the quarantine it earned no strikes at all: it withheld nothing and kept advertising a model
     * it could not load to the very peers deciding to send it more. That is exactly the shape of
     * fleet node core-4, which answers `/api/tags` with a model whose every generate 500s.
     */
    it('records a 5xx from a peer-forwarded request against the model', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response('model failed to load', { status: 500 }));

      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'peer.example.ts.net',
        MODEL,
      );

      expect(ollama.noteServingFailure).toHaveBeenCalledWith(MODEL, 'HTTP 500');
    });

    it('clears the record when a peer-forwarded request succeeds', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok', { status: 200 }));

      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'peer.example.ts.net',
        MODEL,
      );

      expect(ollama.noteServingSuccess).toHaveBeenCalledWith(MODEL);
    });

    // A peer now asks this node to describe a model its `auto` resolved to (`local/api/show`). The
    // engine answers that from the manifest without loading anything, so a 200 proves nothing about
    // serving — and counting it would clear the strikes of the model that fails every generation.
    it('does not let a peer-forwarded /api/show clear a withheld model', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ details: {} }), { status: 200 }));

      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/show',
        'POST',
        { model: MODEL },
        createMockResponse(),
        'peer.example.ts.net',
        MODEL,
      );

      expect(ollama.noteServingSuccess).not.toHaveBeenCalled();
      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
    });

    it('still forwards when the peer sends no model header', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response('model failed to load', { status: 500 }));

      // An older peer won't send `X-Hub-Pool-Model`. Losing the strike is acceptable; refusing the
      // forward over a missing attribution header would not be.
      await expect(
        service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', { model: MODEL }, createMockResponse(), 'peer.example.ts.net'),
      ).resolves.not.toThrow();

      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
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

      // Resolves rather than rejects: the peer that sent the work is gone, so there is nobody to
      // answer, and a rethrow would only have Nest log a routine hang-up as a server error.
      await expect(
        service.forwardToLocalBackendAndRespond(
          'ollama',
          '/v1/chat/completions',
          'POST',
          { model: MODEL },
          createMockResponse({ writeFails: true }),
          'peer-hub.tailxyz.ts.net',
        ),
      ).resolves.toBeUndefined();

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

  /**
   * Manual routing pins. `prefer` is the only mode there is, so every test here is ultimately about
   * the same property: a pin changes the ORDER of an already-built candidate list and can never
   * change its membership.
   */
  describe('manual routing pins', () => {
    const MODEL = 'llama3.2:3b';
    const localPin = { scope: 'default', targetKind: 'local', mode: 'prefer' } as const;

    beforeEach(() => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
    });

    it('puts the pinned peer first even though the ranker would have chosen the idle local node', async () => {
      // No local queue at all, so without the pin local wins on score AND on tier rank.
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-busy', MODEL, { inFlightRequests: 5 })]);
      setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-busy', mode: 'prefer' }] });

      expect(await service.buildCandidateList(MODEL)).toEqual([
        { peerId: 'peer-busy', nodeFqdn: 'peer-busy.tailxyz.ts.net', backend: 'ollama' },
        { peerId: null, nodeFqdn: null, backend: 'ollama' },
      ]);
    });

    it('keeps every other candidate behind the pinned one, in ranked order, so failover still works', async () => {
      peerService.listConnectedPeers.mockResolvedValue([
        peerServing('peer-busy', MODEL, { inFlightRequests: 9 }),
        peerServing('peer-idle', MODEL, { inFlightRequests: 0 }),
      ]);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-busy', mode: 'prefer' }] });

      expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual(['peer-busy', 'peer-idle', null]);
    });

    it('applies a model pin over the default pin, and only to that model', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', MODEL, { inFlightRequests: 0 })]);
      setPoolPreferences({
        poolPins: [
          { scope: 'default', targetKind: 'peer', peerId: 'peer-a', mode: 'prefer' },
          { scope: 'model', model: MODEL, targetKind: 'local', mode: 'prefer' },
        ],
      });
      loadService.acquire(LOCAL_CANDIDATE_KEY);

      // The model pin wins for this model...
      expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual([null, 'peer-a']);

      // ...and the default pin still governs a model it does not name.
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['other:1b'] });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', 'other:1b', { inFlightRequests: 0 })]);
      expect((await service.buildCandidateList('other:1b')).map((candidate) => candidate.peerId)).toEqual(['peer-a', null]);
    });

    it('matches a model pin verbatim: a case variant is a different model and does not apply', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', MODEL, { inFlightRequests: 0 })]);
      // Two queued locally against an idle peer clears the affinity head start, so the peer wins on
      // score alone — the ranking a pin would have had to override.
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      setPoolPreferences({ poolPins: [{ scope: 'model', model: 'Llama3.2:3B', targetKind: 'peer', peerId: 'peer-a', mode: 'prefer' }] });

      // Local is loaded, the peer is idle — but no pin applies, so this is the plain ranking.
      expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual(['peer-a', null]);
    });

    /**
     * The pin cannot resurrect an excluded node — the single most important property of applying it
     * to the finished list. An unreachable peer never reaches `usablePeers`, so a pin naming it is a
     * no-op rather than a way to force work onto a node the module has decided is down.
     */
    it('is a silent no-op when the pinned peer is unreachable, and the request still routes locally', async () => {
      peerService.listConnectedPeers.mockResolvedValue([]);
      setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-gone', mode: 'prefer' }] });

      expect(await service.buildCandidateList(MODEL)).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('is a silent no-op when the pinned peer was unpaired while the pin still named it', async () => {
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-still-here', MODEL, { inFlightRequests: 0 })]);
      setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-deleted', mode: 'prefer' }] });

      // The surviving peer is still ranked normally: a dangling pin removes nothing.
      expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual([null, 'peer-still-here']);
    });

    it('never re-admits a local backend that has been unable to serve the model, even pinned to local', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL], unservableModels: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', MODEL, { inFlightRequests: 0 })]);
      setPoolPreferences({ poolPins: [localPin] });

      expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual(['peer-a']);
    });

    it('records the pin that shaped the decision, and nothing about the model or peer it names', async () => {
      peerService.listConnectedPeers.mockResolvedValue([]);
      setPoolPreferences({ poolPins: [localPin] });
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      expect(routingLog.list()[0]?.pin).toEqual({ scope: 'default', mode: 'prefer', targetKind: 'local' });
    });

    it('leaves the routing-log pin null when no pin is set', async () => {
      peerService.listConnectedPeers.mockResolvedValue([]);
      vi.mocked(global.fetch).mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      expect(routingLog.list()[0]?.pin).toBeNull();
    });

    it('says a pin is in force in the 502 for a model nothing can serve', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
      peerService.listConnectedPeers.mockResolvedValue([]);
      setPoolPreferences({ poolPins: [{ scope: 'model', model: 'missing:1b', targetKind: 'local', mode: 'prefer' }] });
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'missing:1b' }, model: 'missing:1b', res });

      const body = vi.mocked(res.json).mock.calls[0]?.[0] as { error: string };
      expect(body.error).toContain('pinned to this Hub');
      // Still says the real problem is inventory: a prefer pin cannot be the reason a list is empty.
      expect(body.error).toContain('inventory problem');
    });

    /**
     * The regression that matters most for this feature, asserted rather than argued: a Hub with no
     * peers routes byte-identically with the pin machinery present. Both the empty-pins case and a
     * stale pin left over from a fleet that no longer exists.
     */
    it('leaves a peerless single-node Hub untouched, pins or no pins', async () => {
      peerService.listConnectedPeers.mockResolvedValue([]);
      vllm.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      const expected = [
        { peerId: null, nodeFqdn: null, backend: 'ollama' },
        { peerId: null, nodeFqdn: null, backend: 'vllm' },
      ];

      expect(await service.buildCandidateList(MODEL)).toEqual(expected);

      setPoolPreferences({ poolPins: [localPin] });
      expect(await service.buildCandidateList(MODEL)).toEqual(expected);

      setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'peer-from-a-past-life', mode: 'prefer' }] });
      expect(await service.buildCandidateList(MODEL)).toEqual(expected);
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

    // ci-hermes (CI_HERMES_OLLAMA_NATIVE=1) probes GET {root}/api/version to decide whether this
    // proxy speaks Ollama's native protocol before it will use it, and only trusts a 200 whose body
    // parses as `{"version": "<str>"}` — see CI-Hermes `ollama_native_adapter.py::_probe_is_ollama`.
    // This passthrough is a byte-for-byte proxy to the real local Ollama, never a synthesized
    // response, so the shape is exactly whatever Ollama itself returns.
    it('passes Ollama’s native /api/version shape through unmodified', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ version: '0.30.11' }), { status: 200 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/version', 'GET', undefined, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(JSON.parse(Buffer.concat(res.chunks).toString())).toEqual({ version: '0.30.11' });
    });

    // Ollama's native /api/tags answers `{"models": [...]}` — a different shape from the
    // OpenAI-compatible /v1/models list (`{"object": "list", "data": [...]}`) served by the sibling
    // route. Confirms the pool proxy never conflates the two.
    it('passes Ollama’s native /api/tags shape through unmodified, distinct from the /v1/models shape', async () => {
      const nativeTags = { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2019393189 }] };
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(nativeTags), { status: 200 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);

      const [url] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://local-ollama:11434/api/tags');
      const body = JSON.parse(Buffer.concat(res.chunks).toString());
      expect(body).toEqual(nativeTags);
      expect(body).not.toHaveProperty('object');
      expect(body).not.toHaveProperty('data');
    });

    it('falls over to the next backend for /api/tags when the first one 404s', async () => {
      const nativeTags = { models: [{ name: 'qwen3.6:27b' }] };
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('not found', { status: 404 })) // ollama
        .mockResolvedValueOnce(new Response(JSON.stringify(nativeTags), { status: 200 })); // vllm
      vllm.getBaseUrl.mockReturnValue('http://local-vllm:8000');

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(JSON.parse(Buffer.concat(res.chunks).toString())).toEqual(nativeTags);
    });

    it.each([
      '/api/version',
      '/api/tags',
    ])('warns that a native-probe path (%s) is unservable, since a silent fallback here loses num_ctx control for callers like ci-hermes', async (path) => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.mocked(global.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest(path, 'GET', undefined, res);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(path));
      warnSpy.mockRestore();
    });

    // /api/ps and /api/show carry no such native-vs-fallback significance, so exhausting local
    // backends for them stays at the existing quiet 502 — no warn log.
    it('does not warn for an unrelated local-only path exhausting its backends', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.mocked(global.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/ps', 'GET', undefined, res);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('answers an unresolvable auto on /api/show with the actionable 502 and calls no engine', async () => {
      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/show', 'POST', { name: AUTO_MODEL }, res);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: describeUnresolvableAuto() });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // The activity panel promised a row "when a request is placed"; the proxy only wrote one at first
  // byte, so an agent turn waiting minutes on a self-hosted engine showed nothing at all.
  describe('routing log rows opened at placement', () => {
    it('lists the request as pending on the node being tried while headers are still awaited, then settles it', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      let releaseUpstream!: (response: Response) => void;
      vi.mocked(global.fetch).mockReturnValueOnce(new Promise<Response>((resolve) => (releaseUpstream = resolve)));
      const res = createMockResponse();

      const inFlight = service.proxyRequest({
        path: '/v1/chat/completions',
        method: 'POST',
        body: { model: 'llama3.2:3b' },
        model: 'llama3.2:3b',
        res,
      });
      await vi.waitFor(() => expect(routingLog.list()).toHaveLength(1));

      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'pending',
        node: LOCAL_CANDIDATE_KEY,
        backend: 'ollama',
        status: null,
        durationMs: null,
        candidates: 1,
      });
      expect(routingLog.summary()).toMatchObject({ pending: 1, served: 0, failed: 0 });

      releaseUpstream(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await inFlight;

      expect(routingLog.list()).toHaveLength(1);
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', node: LOCAL_CANDIDATE_KEY, status: 200 });
      expect(typeof routingLog.list()[0].durationMs).toBe('number');
      expect(routingLog.summary()).toMatchObject({ pending: 0, served: 1 });
    });

    it('moves the pending row to the next candidate on failover instead of adding a row', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
      const peer = peerServing('peer-idle', 'llama3.2:3b', { inFlightRequests: 0 });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.peerAuthHeaders.mockResolvedValue({ Authorization: 'Bearer raw-token' });
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      // Peer ranks first (local is three deep) and 500s; local then serves.
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('engine fell over', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'llama3.2:3b' }, model: 'llama3.2:3b', res });

      expect(routingLog.list()).toHaveLength(1);
      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'served',
        node: LOCAL_CANDIDATE_KEY,
        attempt: 2,
        failedOverFrom: ['peer-idle.tailxyz.ts.net'],
      });
    });
  });

  // Apps are handed `EMBEDDINGS_MODEL=nomic-embed-text`; every engine lists `nomic-embed-text:latest`.
  describe('the implicit :latest tag', () => {
    it('offers the local backend when the request omits the tag the inventory spells out', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text:latest'] });

      expect(await service.buildCandidateList('nomic-embed-text')).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('offers a peer the same way, and still honours an unservable mark spelled either way', async () => {
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['nomic-embed-text:latest'],
        unservableModels: ['nomic-embed-text'],
      });
      peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-idle', 'nomic-embed-text:latest', { inFlightRequests: 0 })]);

      const candidates = await service.buildCandidateList('nomic-embed-text');

      expect(candidates.map((c) => c.peerId)).toEqual(['peer-idle']);
    });
  });

  // The alias apps send for "this Hub's default LLM". The local router always resolved it; the
  // pool matched inventories verbatim and answered 502 — so the first connected peer took every
  // app on `auto` (OpenClaw's primary is `ci-hub/auto`) off inference. beta-max, 2026-09-15.
  //
  // Then it resolved on the entry node only: the probe of all 16 fleet Hubs at dac546bcf found core-4
  // on `gemma3:1b`, beta-ms-a2 on `deepseek-r1:8b` (the newest pull, with `qwen3.6:27b` on the same
  // disk), and a node with no local LLM answering 502 while its peers held a dozen.
  describe('the auto alias', () => {
    // The real registry over the real catalog: the ranking reads the catalog's tool flags, sizes and
    // scores, and a mocked catalog would only prove the test's own fixture.
    function serviceWithCatalog(): PoolProxyService {
      return new PoolProxyService(
        new InferenceBackendRegistry(ollama, vllm, lemonade, mtplx, dspark, lucebox),
        peerService,
        tailscaleService,
        loadService,
        configuration,
        routingLog,
        pressureService,
        new ModelRegistryService(mock<LoggerService>()),
      );
    }

    function localHas(...models: string[]): void {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: models });
    }

    function peersAre(...peers: HubPoolPeer[]): void {
      peerService.listConnectedPeers.mockResolvedValue(peers);
      peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      peerService.peerAuthHeaders.mockResolvedValue({ Authorization: 'Bearer raw-token' });
    }

    function preferModel(preferredModel: string): void {
      configuration.getInferencePreferences.mockReturnValue({ preferredModel } as ReturnType<ConfigurationService['getInferencePreferences']>);
    }

    it('leaves a named model alone without sweeping the pool for it', async () => {
      const withCatalog = serviceWithCatalog();

      expect(await withCatalog.resolveModelAlias('gemma3:1b')).toBe('gemma3:1b');
      expect(ollama.healthCheck).not.toHaveBeenCalled();
      expect(peerService.listConnectedPeers).not.toHaveBeenCalled();
    });

    it('serves auto from a peer when this node has no chat model of its own, instead of the 502 it used to give', async () => {
      const withCatalog = serviceWithCatalog();
      localHas('nomic-embed-text:latest');
      peersAre(peerServing('peer-idle', 'qwen3.6:27b', { inFlightRequests: 0 }));
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await withCatalog.proxyRequest({
        path: '/api/chat',
        method: 'POST',
        body: { model: AUTO_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        model: AUTO_MODEL,
        res,
      });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('peer-idle');
      // The engine never sees the literal word.
      expect(JSON.parse(String(init.body))).toEqual({ model: 'qwen3.6:27b', messages: [{ role: 'user', content: 'hi' }] });
      expect((init.headers as Record<string, string>)[POOL_MODEL_HEADER]).toBe('qwen3.6:27b');
      expect(routingLog.list()[0]).toMatchObject({ model: 'qwen3.6:27b', node: 'peer-idle.tailxyz.ts.net', outcome: 'served' });
    });

    it('passes over a tool-less model and a tiny one on this node for a capable model on a peer', async () => {
      const withCatalog = serviceWithCatalog();
      // core-4's own disk, read 2026-09-17, where `auto` ran `gemma3:1b` — a model with no tool calling.
      localHas('qwen3-coder:30b', 'nomic-embed-text:cpu', 'gemma3:1b-cpu', 'gemma3:1b', 'nomic-embed-text:latest');
      peersAre(peerServing('peer-idle', 'gemma4:e2b', { inFlightRequests: 0 }));

      expect(await withCatalog.resolveModelAlias(AUTO_MODEL)).toBe('qwen3-coder:30b');

      // And with the capable model on the peer instead, the pool still finds it.
      localHas('nomic-embed-text:cpu', 'gemma3:1b-cpu', 'gemma3:1b', 'gemma4:e2b', 'nomic-embed-text:latest');
      peersAre(peerServing('peer-idle', 'qwen3-coder:30b', { inFlightRequests: 0 }));

      expect(await withCatalog.resolveModelAlias(AUTO_MODEL)).toBe('qwen3-coder:30b');
    });

    it("stands auto in with the operator's Settings → Inference model over a better-ranked one, even when only a peer has it", async () => {
      const withCatalog = serviceWithCatalog();
      localHas('qwen3.6:27b');
      peersAre(peerServing('peer-idle', 'gemma4:e2b', { inFlightRequests: 0 }));
      // A catalog id, as Settings stores it; the inventories list the engine id.
      preferModel('gemma4-e2b');

      expect(await withCatalog.resolveModelAlias(AUTO_MODEL)).toBe('gemma4:e2b');
    });

    it('ranks instead when the preferred model is nowhere in the pool', async () => {
      const withCatalog = serviceWithCatalog();
      localHas('gemma3:1b', 'qwen3.6:27b');
      preferModel('qwen3-8-27b');

      expect(await withCatalog.resolveModelAlias(AUTO_MODEL)).toBe('qwen3.6:27b');
    });

    it('never stands auto in with an embedding model — not when it is all the pool has, not when it is the preference', async () => {
      const withCatalog = serviceWithCatalog();
      localHas('nomic-embed-text:latest');
      peersAre(peerServing('peer-idle', 'mxbai-embed-large:latest', { inFlightRequests: 0 }));
      preferModel('nomic-embed-text');
      const res = createMockResponse();

      await withCatalog.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: AUTO_MODEL }, model: AUTO_MODEL, res });

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: describeUnresolvableAuto() });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(routingLog.list()[0]).toMatchObject({ model: AUTO_MODEL, outcome: 'failed', candidates: 0 });
    });

    it('only counts models candidate ranking would route to: not a withheld local model, a peer refusing work, or a peer backend that is down', async () => {
      const withCatalog = serviceWithCatalog();
      ollama.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['qwen3.6:27b', 'gemma3:1b'],
        unservableModels: ['qwen3.6:27b'],
      });
      const refusing = peerServing('peer-refusing', 'qwen3-coder:30b', { inFlightRequests: 0 });
      (refusing.lastCapabilities as unknown as PoolPeerCapabilities).acceptingWork = false;
      const engineDown = peerServing('peer-engine-down', 'gpt-oss:20b', { inFlightRequests: 0 });
      for (const backend of (engineDown.lastCapabilities as unknown as PoolPeerCapabilities).backends) backend.healthy = false;
      peersAre(refusing, engineDown);

      // Anything else would resolve `auto` to a model that then has no candidate at all.
      expect(await withCatalog.resolveModelAlias(AUTO_MODEL)).toBe('gemma3:1b');
    });

    it('still resolves on model names alone without the registry (the positional test shape)', async () => {
      localHas('nomic-embed-text:latest', 'qwen2.5:0.5b', 'my-custom:latest');

      // No catalog: the embedding is recognised by name, and the 0.5 B tag ranks below a model of unknown size.
      expect(await service.resolveModelAlias(AUTO_MODEL)).toBe('my-custom:latest');
    });

    it('answers an unresolvable auto with the actionable 502, not "no node has model auto"', async () => {
      const withCatalog = serviceWithCatalog();
      const res = createMockResponse();

      await withCatalog.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: AUTO_MODEL }, model: AUTO_MODEL, res });

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({ error: describeUnresolvableAuto() });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    // OpenClaw's Ollama provider asks `/api/show` about its chat model before the first chat, and
    // reads a 404 as "model not found" — the chat is never sent (beta-max, 2026-09-15).
    describe('on /api/show', () => {
      it('resolves auto to the model the chat will run, under either field name Ollama accepts', async () => {
        const withCatalog = serviceWithCatalog();
        localHas('gemma3:1b', 'qwen3.6:27b');
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ details: {} }), { status: 200 }));
        const res = createMockResponse();

        await withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { name: AUTO_MODEL, model: AUTO_MODEL, verbose: true }, res);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://local-ollama:11434/api/show');
        expect(JSON.parse(init.body as string)).toEqual({ name: 'qwen3.6:27b', model: 'qwen3.6:27b', verbose: true });
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('asks the peer holding the resolved model to describe it when no local engine can', async () => {
        const withCatalog = serviceWithCatalog();
        localHas('nomic-embed-text:latest');
        peersAre(peerServing('peer-idle', 'qwen3.6:27b', { inFlightRequests: 0 }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async (url) =>
          String(url).includes('peer-idle')
            ? new Response(JSON.stringify({ details: { parameter_size: '27B' } }), { status: 200 })
            : new Response('model not found', { status: 404 }),
        );
        const res = createMockResponse();

        await withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { model: AUTO_MODEL }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        const peerCall = fetchMock.mock.calls.find(([url]) => String(url).includes('peer-idle')) as [string, RequestInit];
        expect(peerCall[0]).toBe('https://peer-idle.tailxyz.ts.net/api/inference/pool/local/api/show');
        expect(JSON.parse(peerCall[1].body as string)).toEqual({ model: 'qwen3.6:27b' });
        expect(headersSetOn(res)[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe('peer-idle.tailxyz.ts.net');
        // A metadata lookup is not a turn: no routing-log row, and no queue depth left behind.
        expect(routingLog.list()).toHaveLength(0);
        expect(loadService.get('peer-idle')).toBe(0);
      });

      it('gives the same 502 as before when every peer holding the model 404s, as a build without local/api/show does', async () => {
        const withCatalog = serviceWithCatalog();
        localHas('nomic-embed-text:latest');
        peersAre(peerServing('peer-old', 'qwen3.6:27b', { inFlightRequests: 0 }));
        vi.mocked(global.fetch).mockResolvedValue(new Response('Cannot POST /api/inference/pool/local/api/show', { status: 404 }));
        const res = createMockResponse();

        await withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { model: AUTO_MODEL }, res);

        expect(res.status).toHaveBeenCalledWith(502);
        expect(res.json).toHaveBeenCalledWith({ error: 'No local backend able to serve /api/show' });
      });
    });
  });

  // The socket-level half of these lives in hub-pool-proxy-client-abort.test.ts; these cover the
  // routing decisions around a hang-up, which a real socket cannot make deterministic.
  describe('a client that hangs up', () => {
    const MODEL = 'llama3.2:3b';

    /** Behaves like real `fetch` about aborts: rejects with the signal's reason, before or while waiting. */
    function fetchThatWaitsForever(signals: AbortSignal[]): void {
      vi.mocked(global.fetch).mockImplementation((_url, init) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      });
    }

    it('aborts a peer forward still waiting for headers, and places the turn on no other candidate', async () => {
      const peers = [peerServing('peer-a', MODEL, { inFlightRequests: 0 }), peerServing('peer-b', MODEL, { inFlightRequests: 0 })];
      peerService.listConnectedPeers.mockResolvedValue(peers);
      peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      peerService.peerAuthHeaders.mockResolvedValue({ Authorization: 'Bearer raw-token' });
      const signals: AbortSignal[] = [];
      fetchThatWaitsForever(signals);
      const res = createMockResponse();

      const inFlight = service.proxyRequest({ path: '/api/chat', method: 'POST', body: { model: MODEL, stream: true }, model: MODEL, res });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      res.destroy();
      await inFlight;

      expect(signals[0]?.aborted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', status: null, failedOverFrom: [] });
      expect(loadService.get('peer-a')).toBe(0);
    });

    it('sends the upstream an already-aborted request when the client left while candidates were still being ranked', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      vllm.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      const signals: AbortSignal[] = [];
      fetchThatWaitsForever(signals);
      const res = createMockResponse();
      res.destroy();

      await service.proxyRequest({ path: '/api/chat', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      // Real `fetch` rejects an aborted signal before a byte leaves; and with two candidates, one attempt.
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    });
  });
});
