import { INFERENCE_BACKEND_TYPES, type BackendResidency } from '@ci-hub/common/types';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Logger } from '@nestjs/common';
import { OPTIONAL_DEPS_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { TailscaleService } from '@/modules/tailscale/tailscale.service';
import { OllamaBackend } from '@/modules/inference/backends/ollama.backend';
import { VllmBackend } from '@/modules/inference/backends/vllm.backend';
import { LemonadeBackend } from '@/modules/inference/backends/lemonade.backend';
import { OmlxBackend } from '@/modules/inference/backends/omlx.backend';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  DEFAULT_POOL_SLOT_AWARENESS,
  MIN_POOL_MAX_PROMPT_TOKENS,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import { HubPoolPressureService } from '../hub-pool-pressure.service';
import { HubPoolPeerService } from '../hub-pool-peer.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '../hub-pool-load.service';
import { PLACEMENT_PROBE_BUDGET_MS } from '../hub-pool-local-health.service';
import { HubPoolRoutingLogService } from '../hub-pool-routing-log.service';
import {
  HubPoolThroughputService,
  SLOWER_PLACEMENT_FLOOR_MS,
  SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT,
  SLOWER_PLACEMENT_RATIO,
  THROUGHPUT_FORGET_AFTER_MS,
  THROUGHPUT_HALF_LIFE_MS,
  THROUGHPUT_HOLD_MS,
  UNMEASURED_DEFER_MIN_PROMPT_TOKENS,
  type PrefillPrediction,
  type UnmeasuredPrior,
} from '../hub-pool-throughput.service';
import {
  AUTO_MODEL,
  HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS_ENV_VAR,
  HUB_POOL_SLOWER_PLACEMENT_RATIO_ENV_VAR,
  POOL_BACKEND_HEADER,
  POOL_MODEL_HEADER,
  POOL_REQUEST_ID_HEADER,
  POOL_SERVED_BY_HEADER,
  POOL_SERVED_LOCALLY,
  PoolForwardDeadlineError,
  PoolProxyService,
  applyContextCap,
  applyLocalContention,
  applyPromptCeiling,
  applySlotPlacement,
  applySlowerPlacement,
  applyThroughputPlacement,
  describeUnresolvableAuto,
  isRelayedEngineResponse,
  requestedNumCtx,
  normalizePoolRequestId,
  servedByHeaders,
  splitByThroughput,
  splitDemoted,
  type MeasuredPrefill,
  type SlowerPlacement,
  type UnmeasuredPlacement,
} from '../hub-pool-proxy.service';
import { firstByteBudgetMs, forwardBudgetMs } from '../hub-pool-budget';
import {
  POOL_AFFINITY_HEADER,
  PREFIX_AFFINITY_TTL_MS,
  PrefixAffinityStore,
  applyPrefixAffinity,
  derivePrefixKey,
  normalizePoolSessionKey,
  promptHead,
} from '../hub-pool-prefix-affinity';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import type { LoggerService } from '@/core/logger/logger.service';
import type { PoolCandidate, PoolPeerCapabilities, PoolThroughputEstimate } from '../hub-pool.types';

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
  options: {
    inFlightRequests?: number;
    hardwareTier?: string;
    lastSeenAt?: string;
    gpuPressure?: unknown;
    maxPromptTokens?: number;
    ollamaSlots?: number;
  } = {},
): HubPoolPeer {
  return mockPeer({
    id,
    nodeFqdn: `${id}.tailxyz.ts.net`,
    lastSeenAt: options.lastSeenAt ?? new Date().toISOString(),
    lastCapabilities: capabilitiesWithModel(model, {
      inFlightRequests: options.inFlightRequests,
      ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
      ...('maxPromptTokens' in options ? { maxPromptTokens: options.maxPromptTokens } : {}),
      ...('ollamaSlots' in options ? { ollamaSlots: options.ollamaSlots } : {}),
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
  let omlx: MockProxy<OmlxBackend>;
  let peerService: MockProxy<HubPoolPeerService>;
  let tailscaleService: MockProxy<TailscaleService>;
  let configuration: MockProxy<ConfigurationService>;
  // Real, not mocked: ranking is only meaningful against the counter the proxy itself maintains.
  let loadService: HubPoolLoadService;
  // Real too: the ring buffer's contents are the assertion in the routing-log tests.
  let routingLog: HubPoolRoutingLogService;
  let pressureService: MockProxy<HubPoolPressureService>;
  // Real: placement is only meaningful against the evidence the proxy itself records.
  let throughput: HubPoolThroughputService;
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
      poolMaxPromptTokens: null,
      poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      poolPrefixAffinityMaxInFlight: DEFAULT_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
      poolSlotAwareness: DEFAULT_POOL_SLOT_AWARENESS,
      ...overrides,
    });
  }

  beforeEach(() => {
    ollama = mock<OllamaBackend>();
    vllm = mock<VllmBackend>();
    lemonade = mock<LemonadeBackend>();
    omlx = mock<OmlxBackend>();
    peerService = mock<HubPoolPeerService>();
    tailscaleService = mock<TailscaleService>();
    configuration = mock<ConfigurationService>();
    setPoolPreferences({});

    for (const backend of [ollama, vllm, lemonade, omlx]) {
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
    throughput = new HubPoolThroughputService();
    service = buildService();
    global.fetch = vi.fn();
  });

  function buildService(): PoolProxyService {
    return new PoolProxyService(
      // The real registry over the same six mocks, not a mock registry: a mocked `entries()` would
      // return undefined and quietly drop every local candidate.
      new InferenceBackendRegistry(ollama, vllm, lemonade, omlx),
      peerService,
      tailscaleService,
      loadService,
      configuration,
      routingLog,
      pressureService,
      // One `undefined` (the model registry), not two: this branch drops the `InferenceRouterService`
      // slot that used to sit before it, because `auto` is now resolved by `pool-auto-model.ts`
      // against the whole pool. Leaving the old placeholder in would land `throughput` past the end
      // of the constructor and silently give every test its own empty store.
      undefined,
      throughput,
    );
  }

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

    it("reports every local backend's probe on the 502, from the container's point of view", async () => {
      // The node runs the model on vLLM; the Hub container cannot reach it (a firewall rule that
      // only allowed Ollama's port). The old body said "no pool node has it", and it was wrong
      // about where to look.
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      vllm.getBaseUrl.mockReturnValue('http://host.docker.internal:8000');
      vllm.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [], error: 'timeout of 5000ms exceeded' });
      omlx.getBaseUrl.mockReturnValue('http://host.docker.internal:8000');
      omlx.healthCheck.mockResolvedValue({ running: true, healthy: false, modelsLoaded: [], error: 'The server names itself "vllm"' });
      const res = createMockResponse();

      await service.proxyRequest({
        path: '/v1/chat/completions',
        method: 'POST',
        body: { model: 'Qwen/Qwen2.5-3B-Instruct-AWQ' },
        model: 'Qwen/Qwen2.5-3B-Instruct-AWQ',
        res,
      });

      expect(res.status).toHaveBeenCalledWith(502);
      const body = vi.mocked(res.json).mock.calls[0]?.[0] as { error: string; localBackends: unknown[] };
      expect(body.error).toContain('local omlx at http://host.docker.internal:8000 answered but was left out: The server names itself "vllm"');
      expect(body.error).toContain('local vllm, lemonade not reachable from inside the Hub container');
      expect(body.localBackends).toEqual(
        expect.arrayContaining([
          {
            type: 'ollama',
            url: 'http://local-ollama:11434',
            running: true,
            healthy: true,
            listsModel: false,
            error: undefined,
            probedMsAgo: expect.any(Number),
          },
          {
            type: 'vllm',
            url: 'http://host.docker.internal:8000',
            running: false,
            healthy: false,
            listsModel: false,
            error: 'timeout of 5000ms exceeded',
            probedMsAgo: expect.any(Number),
          },
          {
            type: 'omlx',
            url: 'http://host.docker.internal:8000',
            running: true,
            healthy: false,
            listsModel: false,
            error: 'The server names itself "vllm"',
            probedMsAgo: expect.any(Number),
          },
        ]),
      );
      // One row per declared backend — derived from the tuple so adding one does not quietly
      // assert the old count.
      expect(body.localBackends).toHaveLength(INFERENCE_BACKEND_TYPES.length);
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

    /**
     * A peer relays its engines' answers and marks them with the engine (`X-Hub-Pool-Backend`); its
     * own guard's refusals carry no mark. A marked 401/403 is an engine behind the peer refusing the
     * key that peer holds for it — a vLLM, Lemonade or oMLX key mismatch there — and dropping the
     * peer's whole inventory for it took its Ollama models out of the pool too.
     */
    describe("a peer's engine refusing its own key", () => {
      const MODEL = 'llama3.2:3b';
      const capabilities = capabilitiesWithModel(MODEL) as unknown as Record<string, unknown>;
      const peerA = mockPeer({ id: 'peer-a', nodeFqdn: 'a.tailxyz.ts.net', lastCapabilities: capabilities });
      const peerB = mockPeer({ id: 'peer-b', nodeFqdn: 'b.tailxyz.ts.net', lastCapabilities: capabilities });
      const engineRefusal = (status: number) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status,
          headers: { 'content-type': 'application/json', [POOL_BACKEND_HEADER]: 'vllm' },
        });

      function peers(...rows: HubPoolPeer[]): void {
        peerService.listConnectedPeers.mockResolvedValue(rows);
        peerService.getPeerById.mockImplementation(async (id) => rows.find((row) => row.id === id));
        peerService.getPresentToken.mockResolvedValue('raw-token');
      }

      async function route(): Promise<Response & { chunks: Buffer[] }> {
        const res = createMockResponse();
        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });
        return res;
      }

      it("fails over to the next candidate and keeps the peer's cached capabilities", async () => {
        peers(peerA, peerB);
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(engineRefusal(401))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const res = await route();

        expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toContain('b.tailxyz.ts.net');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(peerService.clearCachedCapabilities).not.toHaveBeenCalled();
        expect(routingLog.list()[0]).toMatchObject({ node: 'b.tailxyz.ts.net', outcome: 'served', failedOverFrom: ['a.tailxyz.ts.net'] });
      });

      it("relays the engine's 401 from the last candidate rather than a 502, and keeps the pairing", async () => {
        peers(peerA);
        vi.mocked(global.fetch).mockResolvedValueOnce(engineRefusal(401));

        const res = await route();

        expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(Buffer.concat(res.chunks).toString()).toContain('Invalid API key');
        // The peer's mark is its own statement; this Hub states its own attribution instead.
        expect(headersSetOn(res)[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe('a.tailxyz.ts.net');
        expect(peerService.clearCachedCapabilities).not.toHaveBeenCalled();
        expect(routingLog.list()[0]).toMatchObject({
          node: 'a.tailxyz.ts.net',
          outcome: 'failed',
          status: 401,
          failedOverFrom: [],
          requestError: { signature: 'client-error', basis: 'status', confirms: null },
        });
      });

      it('tells the operator to check the key on the last candidate too, where the app gets the refusal', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          peers(peerA);
          vi.mocked(global.fetch).mockResolvedValueOnce(engineRefusal(401));

          const res = await route();

          expect(res.status).toHaveBeenCalledWith(401);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("peer a.tailxyz.ts.net's ollama engine answered 401"));
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('check the API key that peer holds for it'));
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('warns once per peer engine for a refusal that recurs, and at debug after that', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
        try {
          peers(peerA, peerB);
          const refusalLines = (spy: typeof warnSpy) => spy.mock.calls.filter(([line]) => String(line).includes('check the API key')).length;
          for (let turn = 0; turn < 3; turn += 1) {
            vi.mocked(global.fetch)
              .mockResolvedValueOnce(engineRefusal(401))
              .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
            await route();
          }

          expect(refusalLines(warnSpy)).toBe(1);
          expect(refusalLines(debugSpy)).toBe(2);

          // Another engine's refusal on the same peer is its own line.
          const vllmOnA = capabilitiesWithModel(MODEL, { backends: [{ type: 'vllm', healthy: true, modelsLoaded: [MODEL] }] });
          peers(mockPeer({ id: 'peer-a', nodeFqdn: 'a.tailxyz.ts.net', lastCapabilities: vllmOnA as unknown as Record<string, unknown> }), peerB);
          vi.mocked(global.fetch)
            .mockResolvedValueOnce(engineRefusal(401))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          await route();

          expect(refusalLines(warnSpy)).toBe(2);
          expect(warnSpy).toHaveBeenLastCalledWith(expect.stringContaining("peer a.tailxyz.ts.net's vllm engine answered 401"));
        } finally {
          warnSpy.mockRestore();
          debugSpy.mockRestore();
        }
      });

      it('treats a marked 403 the same way', async () => {
        peers(peerA, peerB);
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(engineRefusal(403))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const res = await route();

        expect(res.status).toHaveBeenCalledWith(200);
        expect(peerService.clearCachedCapabilities).not.toHaveBeenCalled();
      });

      it('still reads an unmarked 403 from the last candidate as the pairing: capabilities dropped, 502', async () => {
        peers(peerA);
        // The peer's `forwardLocal` "not connected" answer, or any peer on a build before the mark.
        vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Peer is not connected' }), { status: 403 }));

        const res = await route();

        expect(res.status).toHaveBeenCalledWith(502);
        expect(peerService.clearCachedCapabilities).toHaveBeenCalledWith('peer-a');
      });

      it('marks what it relays for a peer with the engine that answered, error or not', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
        const refused = createMockResponse();
        await service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', { model: MODEL }, refused, 'core-6.tailxyz.ts.net', MODEL);

        vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ done: true }), { status: 200 }));
        const served = createMockResponse();
        await service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', { model: MODEL }, served, 'core-6.tailxyz.ts.net', MODEL);

        expect(refused.status).toHaveBeenCalledWith(401);
        expect(headersSetOn(refused)[POOL_BACKEND_HEADER.toLowerCase()]).toBe('ollama');
        expect(headersSetOn(served)[POOL_BACKEND_HEADER.toLowerCase()]).toBe('ollama');
      });

      it('recognises the mark, and only the mark', () => {
        expect(isRelayedEngineResponse(new Headers({ [POOL_BACKEND_HEADER]: 'vllm' }))).toBe(true);
        expect(isRelayedEngineResponse(new Headers({ 'x-hub-pool-backend': 'lemonade' }))).toBe(true);
        expect(isRelayedEngineResponse(new Headers({ 'content-type': 'application/json' }))).toBe(false);
      });
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

    /**
     * The row settled `served` at headers time, and the dead stream then appends to its
     * `failedOverFrom`. A mutation that skipped `updatedAt` was invisible to a `?since=` poller, which
     * had already seen the row and was told nothing had changed.
     */
    it('moves the row past a cursor when the stream dies after the commit', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3.2:3b'] });
        vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'));
        const settle = routingLog.settle.bind(routingLog);
        vi.spyOn(routingLog, 'settle').mockImplementation((row, patch) => {
          settle(row, patch);
          // The stream then runs for a second before the client's socket fails.
          vi.setSystemTime(new Date('2026-09-17T10:00:01.000Z'));
        });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: 'llama3.2:3b' },
          model: 'llama3.2:3b',
          res: createMockResponse({ writeFails: true }),
        });

        const page = routingLog.query({ since: '2026-09-17T10:00:00.500Z' });
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]).toMatchObject({ outcome: 'served', failedOverFrom: [POOL_SERVED_LOCALLY], updatedAt: '2026-09-17T10:00:01.000Z' });
      } finally {
        vi.useRealTimers();
      }
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
   * The routing log had no key, so a caller holding a response could not find the row that explains
   * it, and the peer's inbound row could only be matched by time. The id is minted once per request and
   * has to reach three places — the response, the row, and the forward to the peer — identically.
   */
  describe('request ids and request shape', () => {
    const MODEL = 'llama3.2:3b';

    function peerHasModel(): void {
      const peer = mockPeer({ lastCapabilities: capabilitiesWithModel(MODEL) as unknown as Record<string, unknown> });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.peerAuthHeaders.mockResolvedValue({ Authorization: 'Bearer raw-token' });
    }

    /** Header names of a forward are whatever case the proxy wrote; read them the way a server would. */
    function forwardedHeader(call: number, name: string): string | undefined {
      const init = vi.mocked(global.fetch).mock.calls[call]?.[1] as RequestInit | undefined;
      const entry = Object.entries((init?.headers ?? {}) as Record<string, string>).find(([key]) => key.toLowerCase() === name.toLowerCase());
      return entry?.[1];
    }

    it('adds the id to the attribution headers only when there is one', () => {
      const candidate = { peerId: null, nodeFqdn: null, backend: 'ollama' as const };

      expect(servedByHeaders(candidate, MODEL, 'req-1')[POOL_REQUEST_ID_HEADER]).toBe('req-1');
      expect(servedByHeaders(candidate, MODEL)).not.toHaveProperty(POOL_REQUEST_ID_HEADER);
    });

    it('answers with the id of the routing-log row, and sends the same id to the serving peer', async () => {
      peerHasModel();
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      const id = routingLog.list()[0]?.id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(headersSetOn(res)['x-hub-pool-request-id']).toBe(id);
      expect(forwardedHeader(0, POOL_REQUEST_ID_HEADER)).toBe(id);
    });

    it('keeps one id across a failover, so the row a caller finds is the whole story', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerHasModel();
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(new Response('engine down', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      expect(routingLog.list()).toHaveLength(1);
      const row = routingLog.list()[0];
      expect(row).toMatchObject({ outcome: 'served', failedOverFrom: [POOL_SERVED_LOCALLY] });
      expect(forwardedHeader(1, POOL_REQUEST_ID_HEADER)).toBe(row?.id);
      expect(headersSetOn(res)['x-hub-pool-request-id']).toBe(row?.id);
    });

    it('hands the caller the id on a 502 too — a failed call is the one worth looking up', async () => {
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: 'missing' }, model: 'missing', res });

      expect(res.status).toHaveBeenCalledWith(502);
      expect(headersSetOn(res)['x-hub-pool-request-id']).toBe(routingLog.list()[0]?.id);
    });

    /**
     * A 900 s wait and a 300 s wait looked like the same row: the first-byte budget is sized from the
     * prompt, and nothing recorded the prompt size or the budget. The row states both, from the body
     * as forwarded — including the usage opt-in the proxy adds to a streamed body — and from the same
     * budget function the forward's timer calls.
     */
    it('records stream, the forwarded body size, and the budget the forward timer used', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
      const prompt = 'x'.repeat(184_000);

      await service.proxyRequest({
        path: '/v1/chat/completions',
        method: 'POST',
        body: { model: MODEL, stream: true, messages: [{ role: 'user', content: prompt }] },
        model: MODEL,
        res: createMockResponse(),
      });

      const forwarded = String((vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit).body);
      expect(routingLog.list()[0]).toMatchObject({
        stream: true,
        bodyBytes: Buffer.byteLength(forwarded),
        budgetMs: forwardBudgetMs(true, forwarded.length),
      });
      // Sized from the prompt, not the fixed floor: this is the case the field exists for.
      expect(routingLog.list()[0]?.budgetMs).toBe(firstByteBudgetMs(forwarded.length));
    });

    it('records the shape on an inbound forward, and keeps the id the sender minted', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await service.forwardToLocalBackendAndRespond(
        'ollama',
        '/api/chat',
        'POST',
        { model: MODEL, stream: false },
        createMockResponse(),
        'core.tailxyz.ts.net',
        MODEL,
        'req-from-core',
      );

      expect(routingLog.list()[0]).toMatchObject({
        id: 'req-from-core',
        direction: 'inbound',
        stream: false,
        budgetMs: forwardBudgetMs(false, JSON.stringify({ model: MODEL, stream: false }).length),
      });
    });

    it.each([
      ['a UUID', '0b7c2d4e-8f7a-4a51-9d0e-3c5f6a7b8c9d', '0b7c2d4e-8f7a-4a51-9d0e-3c5f6a7b8c9d'],
      ['another build’s dotted id', 'core-2.req:42', 'core-2.req:42'],
      ['nothing', undefined, undefined],
      ['an empty header', '', undefined],
      ['a leading separator', '-flag', undefined],
      ['a control character', 'abc\u0007', undefined],
    ])('normalises %s from a peer', (_label, raw, expected) => {
      expect(normalizePoolRequestId(raw)).toBe(expected);
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
   * core-2, 2026-09-26 23:51:12Z: one `qwen3.8:27b` turn with no user message in it. Ollama answered
   * 500 `no user query found in messages` from core-14 in 128 ms, core-17 in 134 ms, core-7 after
   * queueing 4m29s behind another turn, and beta-max; the proxy read every 500 as a node failure,
   * walked all nine candidates, and handed the app a 502 naming beta-max after 307 s. These pin the
   * other reading: a 500 whose body is a known engine verdict on the request goes back to the caller.
   */
  describe('a request no node can serve', () => {
    const MODEL = 'qwen3.8:27b';
    const NODES = Array.from({ length: 9 }, (_, index) => `node-${index + 1}`);
    const fqdn = (id: string) => `${id}.tailxyz.ts.net`;
    /** The incident's body: Ollama's native chat with a system prompt and no user turn. */
    const NO_USER_TURN = {
      model: MODEL,
      stream: true,
      options: { num_ctx: 65536 },
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'assistant', content: 'Done.' },
      ],
    };

    // `globalThis.`: this file's `Response` type is Express's, and these are fetch responses.
    function engineError(status: number, body: unknown): globalThis.Response {
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    const promptError = () => engineError(500, { error: 'no user query found in messages' });
    const templateError = () =>
      engineError(500, { error: 'template: :14:7: executing "" at <.ToolCalls>: can\'t evaluate field ToolCalls in type *api.Message' });
    const ok = () => new Response(JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true }), { status: 200 });

    /** Nine peers holding the model, equally idle, so the ranker keeps them in this order; nothing local. */
    function ninePeers(overrides: (id: string) => Partial<PoolPeerCapabilities> = () => ({})): HubPoolPeer[] {
      const peers = NODES.map((id) =>
        mockPeer({
          id,
          nodeFqdn: fqdn(id),
          lastCapabilities: capabilitiesWithModel(MODEL, { inFlightRequests: 0, ...overrides(id) }) as unknown as Record<string, unknown>,
        }),
      );
      peerService.listConnectedPeers.mockResolvedValue(peers);
      peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      return peers;
    }

    async function proxy(
      res = createMockResponse(),
      path = '/api/chat',
      body: Record<string, unknown> = NO_USER_TURN,
    ): Promise<Response & { chunks: Buffer[] }> {
      await service.proxyRequest({ path, method: 'POST', body, model: MODEL, res });
      return res as Response & { chunks: Buffer[] };
    }

    it('answers the prompt error from the first of nine candidates, with the engine’s own body as a 400', async () => {
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockImplementation(async () => promptError());

      const res = await proxy();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain(fqdn('node-1'));
      // A 400, not the engine's 500: OpenClaw read the incident's 502 as "provider internal error …
      // usually temporary — try again shortly", and the OpenAI SDKs retry any 5xx on their own.
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.status).toHaveBeenCalledTimes(1);
      // The engine's words, not a 502 about the pool: the app has to see what is wrong with its request.
      expect(res.json).not.toHaveBeenCalled();
      expect(JSON.parse(Buffer.concat(res.chunks).toString())).toEqual({ error: 'no user query found in messages' });
      const row = routingLog.list()[0];
      expect(headersSetOn(res)).toMatchObject({
        'x-hub-pool-served-by': fqdn('node-1'),
        'x-hub-pool-request-id': row?.id,
        'x-hub-pool-upstream-status': '500',
        'content-type': 'application/json; charset=utf-8',
      });
      expect(row).toMatchObject({
        node: fqdn('node-1'),
        candidates: 9,
        attempt: 1,
        failedOverFrom: [],
        outcome: 'failed',
        status: 500,
        requestError: { signature: 'no-user-query', basis: 'definitive', confirms: null },
      });
    });

    it('reads the same verdict in the OpenAI-shaped error Ollama’s /v1 and llama-server send', async () => {
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockImplementation(async () =>
        engineError(500, { error: { code: 500, message: 'No user query found in messages.', type: 'server_error' } }),
      );

      const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: NO_USER_TURN.messages });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(routingLog.list()[0]?.requestError).toEqual({ signature: 'no-user-query', basis: 'definitive', confirms: null });
    });

    it('answers it from this node’s own engine too, and does not count it against the model', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      fetchMock.mockImplementation(async () => promptError());

      const res = await proxy();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('local-ollama');
      expect(res.status).toHaveBeenCalledWith(400);
      // Two such answers inside five minutes would otherwise withhold a model that serves every
      // well-formed request, on every node an agent looping on one bad turn happened to reach.
      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
      expect(ollama.noteServingSuccess).not.toHaveBeenCalled();
    });

    it('still walks every candidate for a 500 that carries no such verdict, and still charges the model for it', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      // What a node that cannot run the model says. Its neighbours may well be able to.
      fetchMock.mockImplementation(async () =>
        engineError(500, { error: 'model requires more system memory (30.1 GiB) than is available (22.4 GiB)' }),
      );

      const res = await proxy();

      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(res.status).toHaveBeenCalledWith(502);
      expect(ollama.noteServingFailure).toHaveBeenCalledWith(MODEL, 'HTTP 500');
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', node: null, requestError: null });
    });

    it('still fails over a 503, a 429 and a transport error, whatever their bodies say', async () => {
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      fetchMock
        .mockResolvedValueOnce(engineError(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }))
        // Only a 500 is read as an engine's verdict: a 503 or a 429 is a node talking about itself.
        .mockResolvedValueOnce(engineError(503, { error: 'no user query found in messages' }))
        .mockResolvedValueOnce(engineError(429, { error: 'no user query found in messages' }))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(ok());

      const res = await proxy();

      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', attempt: 5, requestError: null });
    });

    it('does not take the Hub’s own 500 for an engine’s verdict', async () => {
      ninePeers();
      const fetchMock = vi.mocked(global.fetch);
      // Nest's shape, from a peer whose forward threw. It says nothing about the request.
      fetchMock.mockResolvedValueOnce(engineError(500, { statusCode: 500, message: 'no user query found in messages' })).mockResolvedValueOnce(ok());

      const res = await proxy();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    describe('a verdict one node alone cannot vouch for', () => {
      it('tries exactly one more candidate, and hands the caller its answer when it agrees', async () => {
        ninePeers();
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => templateError());

        const res = await proxy();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Still the engine's 500: a template that would not render may be the model's own copy, and
        // that is not something the app can fix by changing its request.
        expect(res.status).toHaveBeenCalledWith(500);
        expect(JSON.parse(Buffer.concat(res.chunks).toString()).error).toContain('executing');
        expect(headersSetOn(res)['x-hub-pool-served-by']).toBe(fqdn('node-2'));
        expect(headersSetOn(res)).not.toHaveProperty('x-hub-pool-upstream-status');
        expect(routingLog.list()[0]).toMatchObject({
          node: fqdn('node-2'),
          attempt: 2,
          failedOverFrom: [fqdn('node-1')],
          outcome: 'failed',
          status: 500,
          requestError: { signature: 'chat-template', basis: 'confirmed', confirms: fqdn('node-1') },
        });
      });

      it('serves the request when the next node can, which is why one node was not enough', async () => {
        ninePeers();
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(templateError()).mockResolvedValueOnce(ok());

        const res = await proxy();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', node: fqdn('node-2'), requestError: null });
      });

      it('does not count a node that never answered as the confirmation', async () => {
        ninePeers();
        const fetchMock = vi.mocked(global.fetch);
        fetchMock
          .mockResolvedValueOnce(templateError())
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValueOnce(engineError(500, { error: 'llama runner process has terminated: exit status 2' }))
          .mockResolvedValueOnce(templateError());

        const res = await proxy();

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(routingLog.list()[0]).toMatchObject({
          attempt: 4,
          failedOverFrom: [fqdn('node-1'), fqdn('node-2'), fqdn('node-3')],
          requestError: { signature: 'chat-template', basis: 'confirmed', confirms: fqdn('node-1') },
        });
      });

      /**
       * The second node to agree is only the next in rank, and a pool mixes engines: two Lemonade
       * (llama-server) nodes refusing a message shape says nothing about Ollama, which parses the
       * message itself and renders its own Go template rather than the GGUF's Jinja one.
       */
      describe('when an engine that has not answered yet is still ahead', () => {
        const onLemonade = (id: string): Partial<PoolPeerCapabilities> =>
          id === 'node-1' || id === 'node-2' ? { backends: [{ type: 'lemonade', healthy: true, modelsLoaded: [MODEL] }] } : {};
        const malformed = () =>
          engineError(500, {
            error: { code: 500, message: 'Failed to parse messages: Missing \'role\' in message: {"content":"x"}', type: 'server_error' },
          });
        const jinja = () =>
          engineError(500, { error: { code: 500, message: 'Error rendering the chat template: Unknown filter', type: 'server_error' } });

        it.each([
          ['a malformed message', malformed],
          ['a Jinja template that would not render', jinja],
        ])('keeps walking past two llama-server nodes that agree on %s, to the Ollama node behind them', async (_label, refusal) => {
          ninePeers(onLemonade);
          const fetchMock = vi.mocked(global.fetch);
          fetchMock.mockResolvedValueOnce(refusal()).mockResolvedValueOnce(refusal()).mockResolvedValue(ok());

          const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect(res.status).toHaveBeenCalledWith(200);
          expect(routingLog.list()[0]).toMatchObject({
            outcome: 'served',
            node: fqdn('node-3'),
            backend: 'ollama',
            failedOverFrom: [fqdn('node-1'), fqdn('node-2')],
            requestError: null,
          });
        });

        it('stops once every node left runs an engine that already refused', async () => {
          ninePeers(() => ({ backends: [{ type: 'lemonade', healthy: true, modelsLoaded: [MODEL] }] }));
          const fetchMock = vi.mocked(global.fetch);
          fetchMock.mockImplementation(async () => malformed());

          const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

          expect(fetchMock).toHaveBeenCalledTimes(2);
          expect(res.status).toHaveBeenCalledWith(400);
          expect(routingLog.list()[0]?.requestError).toEqual({ signature: 'invalid-message', basis: 'confirmed', confirms: fqdn('node-1') });
        });
      });

      it('keeps charging the model for a template that would not render, since the node’s own copy may be the broken one', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        ninePeers();
        vi.mocked(global.fetch).mockImplementation(async () => templateError());

        await proxy();

        expect(ollama.noteServingFailure).toHaveBeenCalledWith(MODEL, 'HTTP 500');
      });
    });

    describe('a prompt longer than the window', () => {
      const tooLong = () =>
        engineError(500, {
          error: { code: 500, message: 'the request exceeds the available context size, try increasing it', type: 'server_error' },
        });

      it('is confirmed by the next candidate when the request sets the window itself on Ollama’s native route', async () => {
        ninePeers();
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => tooLong());

        const res = await proxy();

        // `options.num_ctx` is what both Ollama candidates load the model at, so they ran the same window.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]?.requestError).toEqual({ signature: 'context-length', basis: 'confirmed', confirms: fqdn('node-1') });
      });

      it('is not confirmed by a node with a larger window, which gets its own chance', async () => {
        ninePeers((id) => ({ maxNumCtx: id === 'node-1' ? 16384 : 65536 }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => tooLong());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        // node-1 runs 16384 and node-2 65536: node-2 failing too is new evidence, not agreement, and
        // it takes node-3, on the same 65536, to confirm it.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]?.requestError).toEqual({ signature: 'context-length', basis: 'confirmed', confirms: fqdn('node-2') });
      });

      /**
       * The same pair of windows, the other way round: two small-window nodes ranked ahead of larger
       * ones. Placement moves a capped node back only when the pool's own estimate of the prompt
       * (bytes / 4) is over its cap, so an underestimate leaves a 16384 node first — and the two of
       * them agreeing proves only that the prompt needs more than 16384.
       */
      it('keeps walking past two nodes that agree when a node still ahead runs a larger window', async () => {
        ninePeers((id) => ({ maxNumCtx: id === 'node-1' || id === 'node-2' ? 16384 : 131072 }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(tooLong()).mockResolvedValueOnce(tooLong()).mockResolvedValue(ok());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(routingLog.list()[0]).toMatchObject({
          outcome: 'served',
          node: fqdn('node-3'),
          failedOverFrom: [fqdn('node-1'), fqdn('node-2')],
          requestError: null,
        });
      });

      it('keeps walking when a node still ahead does not state its window', async () => {
        ninePeers((id) => (id === 'node-3' ? {} : { maxNumCtx: 16384 }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(tooLong()).mockResolvedValueOnce(tooLong()).mockResolvedValue(ok());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', node: fqdn('node-3'), requestError: null });
      });

      /**
       * A node's advertised cap is its operator's statement of `OLLAMA_CONTEXT_LENGTH`. It places
       * requests on every engine the node runs, which costs nothing when it is wrong, but it says
       * nothing about the window a Lemonade or vLLM engine was launched with, so two of those agreeing
       * on equal caps proves nothing about the third.
       */
      it('does not take an Ollama cap for the window another engine on a peer runs', async () => {
        ninePeers(() => ({ maxNumCtx: 16384, backends: [{ type: 'lemonade', healthy: true, modelsLoaded: [MODEL] }] }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(tooLong()).mockResolvedValueOnce(tooLong()).mockResolvedValue(ok());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', node: fqdn('node-3'), requestError: null });
      });

      it('stops once no node left to try runs a larger window than the two that agreed', async () => {
        ninePeers((id) => ({ maxNumCtx: id === 'node-1' || id === 'node-2' ? 131072 : 16384 }));
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => tooLong());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]?.requestError).toEqual({ signature: 'context-length', basis: 'confirmed', confirms: fqdn('node-1') });
      });

      /**
       * No window is known, so no two answers confirm each other and the walk reaches every node, as
       * it always did. What changed is the end: the ninth node's answer is the engine's sentence,
       * and the caller gets it rather than a 502 that says only that nine candidates failed.
       */
      it('walks the pool as before when no node states its window, then relays the last node’s answer', async () => {
        ninePeers();
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => tooLong());

        // No `num_ctx` on `/v1`, and no cap advertised: each node runs a window this Hub cannot see.
        const res = await proxy(createMockResponse(), '/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });

        expect(fetchMock).toHaveBeenCalledTimes(9);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(JSON.parse(Buffer.concat(res.chunks).toString()).error.message).toContain('exceeds the available context size');
        expect(routingLog.list()[0]).toMatchObject({
          node: fqdn('node-9'),
          attempt: 9,
          failedOverFrom: NODES.slice(0, 8).map(fqdn),
          outcome: 'failed',
          status: 500,
          requestError: { signature: 'context-length', basis: 'last-candidate', confirms: null },
        });
      });
    });

    /**
     * A verdict one node cannot vouch for waits for a second candidate to agree. On the only
     * candidate, or the last one reached, there is no second: until this the walk simply ran out with
     * the verdict held, and the caller got `502 All N … failed` with `requestError: null`. A pool whose
     * one node for a model is a Lemonade or llama-server answering `500 Missing 'content'` lost the
     * engine's message entirely, and the OpenAI SDKs retried the 502 into the same refusal.
     */
    describe('when no candidate is left to confirm a verdict', () => {
      const malformed = () =>
        engineError(500, {
          error: { code: 500, message: 'Missing \'content\' in message: {"role":"user"}', type: 'server_error' },
        });
      const onLemonade = (): Partial<PoolPeerCapabilities> => ({ backends: [{ type: 'lemonade', healthy: true, modelsLoaded: [MODEL] }] });
      const CHAT = { model: MODEL, messages: [{ role: 'user' }] };

      /** `count` peers holding the model, in this order, each running what `overrides` says. */
      function peersInOrder(count: number, overrides: (id: string) => Partial<PoolPeerCapabilities> = onLemonade): void {
        const peers = NODES.slice(0, count).map((id) =>
          mockPeer({
            id,
            nodeFqdn: fqdn(id),
            lastCapabilities: capabilitiesWithModel(MODEL, { inFlightRequests: 0, ...overrides(id) }) as unknown as Record<string, unknown>,
          }),
        );
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      }

      it('relays the only candidate’s refusal as the engine’s own body, and says it was not confirmed', async () => {
        peersInOrder(1);
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => malformed());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', CHAT);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The status a confirmed malformed message goes out under, for the same reason: a 400 is not retried.
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.status).toHaveBeenCalledTimes(1);
        expect(res.json).not.toHaveBeenCalled();
        expect(JSON.parse(Buffer.concat(res.chunks).toString()).error.message).toContain("Missing 'content' in message");
        const row = routingLog.list()[0];
        expect(headersSetOn(res)).toMatchObject({
          'x-hub-pool-served-by': fqdn('node-1'),
          'x-hub-pool-request-id': row?.id,
          'x-hub-pool-upstream-status': '500',
        });
        expect(row).toMatchObject({
          node: fqdn('node-1'),
          backend: 'lemonade',
          candidates: 1,
          attempt: 1,
          failedOverFrom: [],
          outcome: 'failed',
          status: 500,
          requestError: { signature: 'invalid-message', basis: 'last-candidate', confirms: null },
        });
        expect(routingLog.summary()).toMatchObject({ failed: 1, requestErrors: 1 });
      });

      it('relays the last candidate’s refusal after the others failed for reasons of their own', async () => {
        peersInOrder(3);
        const fetchMock = vi.mocked(global.fetch);
        fetchMock
          .mockRejectedValueOnce(new Error('ECONNREFUSED'))
          .mockResolvedValueOnce(engineError(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }))
          .mockResolvedValueOnce(malformed());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', CHAT);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]).toMatchObject({
          node: fqdn('node-3'),
          attempt: 3,
          // The node that answered is the row's node, not one more link in the chain behind it.
          failedOverFrom: [fqdn('node-1'), fqdn('node-2')],
          outcome: 'failed',
          status: 500,
          requestError: { signature: 'invalid-message', basis: 'last-candidate', confirms: null },
        });
      });

      it('keeps the engine’s 500 for a template on the last candidate, as for a confirmed one, and still charges the model', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async () => templateError());

        const res = await proxy();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(headersSetOn(res)).not.toHaveProperty('x-hub-pool-upstream-status');
        expect(JSON.parse(Buffer.concat(res.chunks).toString()).error).toContain('executing');
        expect(routingLog.list()[0]).toMatchObject({
          node: LOCAL_CANDIDATE_KEY,
          requestError: { signature: 'chat-template', basis: 'last-candidate', confirms: null },
        });
        expect(ollama.noteServingFailure).toHaveBeenCalledWith(MODEL, 'HTTP 500');
      });

      it('still answers 502 when the last candidate failed without a verdict, whatever an earlier one said', async () => {
        peersInOrder(2, (id) => (id === 'node-1' ? onLemonade() : {}));
        const fetchMock = vi.mocked(global.fetch);
        // An Ollama node that never answered could have parsed the message itself: nothing it said
        // ends the question, so the earlier refusal is not the whole story.
        fetchMock.mockResolvedValueOnce(malformed()).mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const res = await proxy(createMockResponse(), '/v1/chat/completions', CHAT);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.status).toHaveBeenCalledWith(502);
        expect(routingLog.list()[0]).toMatchObject({ node: null, outcome: 'failed', status: null, requestError: null });
      });

      it('serves from the last candidate when it can, so an earlier refusal is never relayed over an answer', async () => {
        peersInOrder(2);
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(malformed()).mockResolvedValueOnce(ok());

        const res = await proxy(createMockResponse(), '/v1/chat/completions', CHAT);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', node: fqdn('node-2'), requestError: null });
      });
    });

    it('does not count the verdict against the model when a peer forwarded the request here', async () => {
      vi.mocked(global.fetch).mockResolvedValue(promptError());
      const res = createMockResponse();

      await service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', NO_USER_TURN, res, 'peer.example.ts.net', MODEL);

      expect(ollama.noteServingFailure).not.toHaveBeenCalled();
      // The engine's answer still goes back to the sender whole, so the sender can read it too.
      expect(res.status).toHaveBeenCalledWith(500);
      expect(JSON.parse(Buffer.concat((res as Response & { chunks: Buffer[] }).chunks).toString())).toEqual({
        error: 'no user query found in messages',
      });
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

    /**
     * core-2, 2026-09-29: six rows read `outcome=served status=400`, each an engine refusing the
     * request (`gemma3:1b does not support tools`) in about 5 ms. The dashboard timed each one as a
     * 5 ms first byte and counted none of them in "Failed 30m". A 4xx is still passed straight
     * through — it is the request's fault, and another node would say the same — but it is not a
     * request served, and the row now says so the way an engine's 500 verdict already did.
     */
    describe('a 4xx passed through on its status', () => {
      const tools400 = () =>
        new Response(JSON.stringify({ error: `registry.ollama.ai/library/${MODEL} does not support tools` }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });

      it('settles as failed on the node that answered, with a client-error reason, and is counted as a refusal', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        const peer = servingPeer();
        peerService.listConnectedPeers.mockResolvedValue([peer]);
        vi.mocked(global.fetch).mockResolvedValueOnce(tools400());
        const res = createMockResponse();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL, stream: true }, model: MODEL, res });

        // The caller's answer is unchanged: the engine's own 400, from the one node asked.
        expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]).toMatchObject({
          node: LOCAL_CANDIDATE_KEY,
          attempt: 1,
          candidates: 2,
          failedOverFrom: [],
          outcome: 'failed',
          status: 400,
          requestError: { signature: 'client-error', basis: 'status', confirms: null },
        });
        expect(routingLog.summary()).toMatchObject({ recorded: 1, served: 0, failed: 1, requestErrors: 1, clientClosed: 0 });
      });

      it('records a peer’s 400 the same way, naming the peer', async () => {
        const peer = servingPeer();
        peerService.listConnectedPeers.mockResolvedValue([peer]);
        peerService.getPeerById.mockResolvedValue(peer);
        peerService.getPresentToken.mockResolvedValue('raw-token');
        vi.mocked(global.fetch).mockResolvedValueOnce(tools400());

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

        expect(routingLog.list()[0]).toMatchObject({
          node: 'peer-hub.tailxyz.ts.net',
          outcome: 'failed',
          status: 400,
          requestError: { signature: 'client-error', basis: 'status' },
        });
      });

      it('leaves a 2xx served with no reason, and a 4xx that failed over out of it', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        const peer = servingPeer();
        peerService.listConnectedPeers.mockResolvedValue([peer]);
        peerService.getPeerById.mockResolvedValue(peer);
        peerService.getPresentToken.mockResolvedValue('raw-token');
        // A local 429 is the engine's queue, not the request: it fails over, and the peer serves.
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(new Response('busy', { status: 429 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

        expect(routingLog.list()[0]).toMatchObject({ outcome: 'served', status: 200, requestError: null, failedOverFrom: [LOCAL_CANDIDATE_KEY] });
        expect(routingLog.summary()).toMatchObject({ served: 1, failed: 0, requestErrors: 0 });
      });

      it('records a peer’s request this node’s engine refused as failed, with its status and no reason', async () => {
        vi.mocked(global.fetch).mockResolvedValue(tools400());
        const res = createMockResponse();

        await service.forwardToLocalBackendAndRespond('ollama', '/v1/chat/completions', 'POST', { model: MODEL }, res, 'peer-hub.tailxyz.ts.net');

        // Relayed to the sender whole: the entry node is the one that records why its walk stopped.
        expect(res.status).toHaveBeenCalledWith(400);
        expect(routingLog.list()[0]).toMatchObject({ direction: 'inbound', outcome: 'failed', status: 400, requestError: null });
        expect(routingLog.summary()).toMatchObject({ served: 0, failed: 1, requestErrors: 0 });
      });
    });

    it('records a peer forward once even when the client dies mid-stream', async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      // Rejects: this mock fails the WRITE with an error, which is how a broken stream on our side
      // looks, and that must still surface. A real hang-up closes the socket without one and resolves
      // quietly; hub-pool-proxy-client-abort.test.ts pins both halves against real sockets.
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
      // Both models on disk from the start: the local inventory is read from a snapshot, so a
      // second `healthCheck` mock between the two rankings below would not be seen inside the TTL.
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL, 'other:1b'] });
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

  /**
   * The per-node prompt ceiling, with the fleet's own numbers: fzzy serves `qwen3-coder:30b` on CPU,
   * answered a 40 KB turn in 103 s, and never produced a first byte for a 184 KB one inside its 922 s
   * budget; core-6 (GPU) served that 184 KB turn in 268 s. Every test is one of the two questions the
   * feature has to get right: does a long prompt go first to a node that did not ask to avoid it, and
   * does everything else — short prompts, older peers, failover, a fleet with nowhere else to go —
   * still reach the nodes it reached before.
   */
  /**
   * Prefix affinity: the node and engine that last served a prompt prefix are preferred for its next
   * call while their queue is under `poolPrefixAffinityMaxInFlight`. Measured on core-2, 2026-09-20:
   * a 44k-token OpenClaw turn spent 67 s of its 100 s in prefill, and the same session's next call
   * re-prefilled 28,672 tokens because the pool did not know which node held the prefix.
   */
  describe('prefix affinity', () => {
    const MODEL = 'llama3.2:3b';
    const PEER = 'peer-idle';
    const PEER_FQDN = `${PEER}.tailxyz.ts.net`;
    const SYSTEM = { role: 'system', content: 'You are an agent with these tools: …' };
    /** Two calls of one session: the second has grown by a turn, and its head is unchanged. */
    const turn1 = { model: MODEL, stream: false, messages: [SYSTEM, { role: 'user', content: 'read the repo' }] };
    const turn2 = {
      model: MODEL,
      stream: false,
      messages: [...turn1.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now fix it' }],
    };

    /** A peer holding the model, reachable for a forward, reporting `inFlightRequests`. */
    function peerReporting(inFlightRequests: number): HubPoolPeer {
      const peer = peerServing(PEER, MODEL, { inFlightRequests });
      peerService.listConnectedPeers.mockResolvedValue([peer]);
      peerService.getPeerById.mockResolvedValue(peer);
      peerService.getPresentToken.mockResolvedValue('raw-token');
      return peer;
    }

    /** Route one call; returns the mock response so headers can be read. */
    async function route(body: Record<string, unknown>, options: { path?: string; sessionHeader?: string | string[] } = {}): Promise<Response> {
      const res = createMockResponse();
      await service.proxyRequest({
        path: options.path ?? '/v1/chat/completions',
        method: 'POST',
        body,
        model: MODEL,
        res,
        sessionHeader: options.sessionHeader,
      });
      return res;
    }

    /** Which upstream each forward went to, in order: `'local'` or the peer's FQDN. */
    function forwardedTo(): string[] {
      return vi
        .mocked(global.fetch)
        .mock.calls.map(([url]) => (String(url).includes('local-ollama') ? LOCAL_CANDIDATE_KEY : new URL(String(url)).hostname));
    }

    beforeEach(() => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      vi.mocked(global.fetch).mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    /** Local busy enough that the ranker sends the first call to the idle peer; then idle again, so the ranker alone would bring the next call home. */
    async function firstCallLandsOnPeer(body: Record<string, unknown> = turn1, options: { sessionHeader?: string } = {}): Promise<void> {
      peerReporting(0);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      await route(body, options);
      expect(forwardedTo()).toEqual([PEER_FQDN]);
      loadService.release(LOCAL_CANDIDATE_KEY);
      loadService.release(LOCAL_CANDIDATE_KEY);
    }

    describe('at the default (poolPrefixAffinityMaxInFlight = 0) nothing changes', () => {
      it('routes the next call by the ranker alone, stamps no header, and logs affinity as null', async () => {
        await firstCallLandsOnPeer();

        const res = await route(turn2);

        // Local is idle again and takes the exact tie on the affinity margin, exactly as before.
        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)).not.toHaveProperty(POOL_AFFINITY_HEADER.toLowerCase());
        expect(routingLog.list().map((row) => row.affinity)).toEqual([null, null]);
      });

      it('remembers nothing while off, so switching it on later starts from a miss rather than a stale placement', async () => {
        await firstCallLandsOnPeer();
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });

        const res = await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
        expect(routingLog.list()[0]?.affinity).toEqual({
          key: 'hashed',
          outcome: 'miss',
          qualified: false,
          remembered: null,
          inFlight: null,
          leastLoadedInFlight: null,
          maxInFlight: 2,
        });
      });
    });

    describe('with the limit set', () => {
      beforeEach(() => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
      });

      it('keeps the next call of a session on the node that served the last one, though the ranker would have brought it home', async () => {
        await firstCallLandsOnPeer();

        const res = await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, PEER_FQDN]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
        expect(headersSetOn(res)['x-hub-pool-served-by']).toBe(PEER_FQDN);
        const [second, first] = routingLog.list();
        expect(first?.affinity).toEqual({
          key: 'hashed',
          outcome: 'miss',
          qualified: false,
          remembered: null,
          inFlight: null,
          leastLoadedInFlight: null,
          maxInFlight: 2,
        });
        // Local idle again is the least-loaded alternative, which the row states beside the peer's own count.
        expect(second?.affinity).toEqual({
          key: 'hashed',
          outcome: 'hit',
          qualified: true,
          remembered: PEER_FQDN,
          inFlight: 0,
          leastLoadedInFlight: 0,
          maxInFlight: 2,
        });
      });

      /**
       * The herding bug, measured on core-2, 2026-09-21: six concurrent sessions behind one 25k-token
       * system prefix, differing only in their first user message, all keyed together — every
       * session's first turn was a `hit` on a node that had never served it, and when one session
       * moved they all followed, cold. Two sessions of one agent stand in for the six.
       */
      it('keeps two concurrent sessions of one agent apart, however long the system prompt they share', async () => {
        const sharedSystem = { role: 'system', content: `You are an agent with these tools: ${'…'.repeat(8_192)}` };
        const sessionA = { model: MODEL, stream: false, messages: [sharedSystem, { role: 'user', content: 'read the repo' }] };
        const sessionB = { model: MODEL, stream: false, messages: [sharedSystem, { role: 'user', content: 'write the tests' }] };
        // A's first turn goes to the peer because local is busy. Local is idle again for everything after.
        await firstCallLandsOnPeer(sessionA);

        // B's first turn: nothing has been served for THIS session, so the ranker decides — local, not A's peer.
        const bFirst = await route(sessionB);
        // A's second turn follows A to the peer; B's follows B, which stayed home.
        const aSecond = await route({
          ...sessionA,
          messages: [...sessionA.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now fix it' }],
        });
        const bSecond = await route({
          ...sessionB,
          messages: [...sessionB.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'run them' }],
        });

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY, PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(bFirst)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
        expect(headersSetOn(aSecond)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
        expect(headersSetOn(bSecond)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
        const [bSecondRow, aSecondRow, bFirstRow] = routingLog.list();
        expect(bFirstRow?.affinity).toEqual({
          key: 'hashed',
          outcome: 'miss',
          qualified: false,
          remembered: null,
          inFlight: null,
          leastLoadedInFlight: null,
          maxInFlight: 2,
        });
        expect(aSecondRow?.affinity).toMatchObject({ key: 'hashed', outcome: 'hit', remembered: PEER_FQDN });
        expect(bSecondRow?.affinity).toMatchObject({ key: 'hashed', outcome: 'hit', remembered: LOCAL_CANDIDATE_KEY });
      });

      it('falls through to the ranker once the remembered node has the limit in flight, and says so', async () => {
        await firstCallLandsOnPeer();
        // Two already queued there: this request would be its third, and waiting costs more than re-prefilling.
        peerReporting(2);

        const res = await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('skipped');
        expect(routingLog.list()[0]?.affinity).toEqual({
          key: 'hashed',
          outcome: 'skipped',
          qualified: false,
          remembered: PEER_FQDN,
          inFlight: 2,
          leastLoadedInFlight: 0,
          maxInFlight: 2,
        });
      });

      /**
       * The 2026-09-29 fleet test's labelling caveat: margin 0, limit 1, one in flight on the
       * remembered node, logged `hit` — but the ranker had put it first on its own, and affinity had
       * stood aside. The row still says where the session landed, and now says who put it there.
       */
      it('says affinity did not qualify a remembered node the ranker put first on its own', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 1 });
        // First call: both idle, local takes the tie, and the table remembers local.
        peerReporting(0);
        await route(turn1);
        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY]);
        // One in flight here, three on the peer: over the limit, but still the ranker's first choice.
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        peerReporting(3);

        await route(turn2);

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, LOCAL_CANDIDATE_KEY]);
        expect(routingLog.list()[0]?.affinity).toEqual({
          key: 'hashed',
          outcome: 'hit',
          qualified: false,
          remembered: LOCAL_CANDIDATE_KEY,
          inFlight: 1,
          leastLoadedInFlight: 3,
          maxInFlight: 1,
        });
      });

      it('still follows the prefix with one other request in flight there: the limit counts the request being placed', async () => {
        await firstCallLandsOnPeer();
        peerReporting(1);

        await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, PEER_FQDN]);
        expect(routingLog.list()[0]?.affinity).toMatchObject({ outcome: 'hit', inFlight: 1 });
      });

      it('forgets a placement after the TTL, so a session that went quiet ranks fresh', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          await firstCallLandsOnPeer();
          vi.setSystemTime(Date.now() + PREFIX_AFFINITY_TTL_MS + 1);

          const res = await route(turn2);

          expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
          expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
          expect(routingLog.list()[0]?.affinity).toMatchObject({ outcome: 'miss', remembered: null });
        } finally {
          vi.useRealTimers();
        }
      });

      it('still remembers a placement just inside the TTL', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          await firstCallLandsOnPeer();
          vi.setSystemTime(Date.now() + PREFIX_AFFINITY_TTL_MS - 1);

          await route(turn2);

          expect(forwardedTo()).toEqual([PEER_FQDN, PEER_FQDN]);
        } finally {
          vi.useRealTimers();
        }
      });

      /**
       * The header names the session; the hash only guesses at it. Two bodies with nothing in
       * common follow each other under one header, and one body under two headers does not.
       */
      it('keys on X-Hub-Pool-Session when the app sends one, over anything in the body', async () => {
        await firstCallLandsOnPeer(turn1, { sessionHeader: 'chat-42' });
        const unrelated = { model: MODEL, stream: false, messages: [{ role: 'user', content: 'a different conversation entirely' }] };

        const followed = await route(unrelated, { sessionHeader: 'chat-42' });
        const other = await route(turn2, { sessionHeader: 'chat-43' });

        expect(forwardedTo()).toEqual([PEER_FQDN, PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(followed)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
        expect(headersSetOn(other)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
        expect(routingLog.list().map((row) => row.affinity?.key)).toEqual(['header', 'header', 'header']);
      });

      it('falls back to the hashed key when the header is malformed, rather than keying every such app together', async () => {
        await firstCallLandsOnPeer();

        // Whitespace, a control character, and Express's array form with a bad first value: none is a session id.
        const res = await route(turn2, { sessionHeader: 'not a session id' });

        expect(forwardedTo()).toEqual([PEER_FQDN, PEER_FQDN]);
        expect(routingLog.list()[0]?.affinity).toMatchObject({ key: 'hashed', outcome: 'hit' });
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
      });

      it('keys a session per model: the same session on another model is a miss, because the cache it warmed is per model', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL, 'other:1b'] });
        await firstCallLandsOnPeer(turn1, { sessionHeader: 'chat-42' });
        const peer = peerServing(PEER, 'other:1b', { inFlightRequests: 0 });
        peerService.listConnectedPeers.mockResolvedValue([peer]);
        peerService.getPeerById.mockResolvedValue(peer);
        const res = createMockResponse();

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { ...turn2, model: 'other:1b' },
          model: 'other:1b',
          res,
          sessionHeader: 'chat-42',
        });

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
      });

      it('remembers the candidate that actually took the work after a failover, not the one tried first', async () => {
        peerReporting(0);
        // Local first (idle, affinity margin); it 500s, the peer serves.
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(new Response('server error', { status: 500 }))
          .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        await route(turn1);
        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, PEER_FQDN]);

        await route(turn2);

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, PEER_FQDN, PEER_FQDN]);
        expect(routingLog.list()[0]?.affinity).toMatchObject({ outcome: 'hit', remembered: PEER_FQDN });
      });

      it('forgets the prefix when every candidate failed, and says what it saw on the 502', async () => {
        await firstCallLandsOnPeer();
        vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));
        const failed = await route(turn2);
        expect(failed.status).toHaveBeenCalledWith(502);
        expect(headersSetOn(failed)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('hit');
        vi.mocked(global.fetch).mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

        const next = await route(turn2);

        // Nothing holds the prefix now, so the ranker decides: local, idle, on the affinity margin.
        expect(forwardedTo().at(-1)).toBe(LOCAL_CANDIDATE_KEY);
        expect(headersSetOn(next)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
      });

      it('yields to an operator pin, and records that the remembered node was under the limit but not placed first', async () => {
        await firstCallLandsOnPeer();
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2, poolPins: [{ scope: 'default', targetKind: 'local', mode: 'prefer' }] });

        const res = await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('skipped');
        // `qualified` on a `skipped` row is how an operator tells "a pin overrode it" from "its queue was full".
        expect(routingLog.list()[0]?.affinity).toEqual({
          key: 'hashed',
          outcome: 'skipped',
          qualified: true,
          remembered: PEER_FQDN,
          inFlight: 0,
          leastLoadedInFlight: 0,
          maxInFlight: 2,
        });
      });

      it('leaves the failover walk intact: the remembered node first, then every other candidate in ranked order', async () => {
        await firstCallLandsOnPeer();
        // Local idle; a second, busier peer behind it.
        const other = peerServing('peer-busy', MODEL, { inFlightRequests: 5 });
        const sticky = peerServing(PEER, MODEL, { inFlightRequests: 0 });
        peerService.listConnectedPeers.mockResolvedValue([other, sticky]);
        peerService.getPeerById.mockImplementation(async (id) => (id === PEER ? sticky : other));

        expect((await service.buildCandidateList(MODEL)).map((candidate) => candidate.peerId)).toEqual([null, PEER, 'peer-busy']);
        vi.mocked(global.fetch).mockClear();
        vi.mocked(global.fetch)
          .mockResolvedValueOnce(new Response('server error', { status: 500 }))
          .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

        await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(routingLog.list()[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, failedOverFrom: [PEER_FQDN], affinity: { outcome: 'hit' } });
      });

      it('does not judge an embeddings batch: no key, no header, affinity null in the log', async () => {
        peerReporting(0);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        loadService.acquire(LOCAL_CANDIDATE_KEY);

        const res = await route({ model: MODEL, input: ['a', 'b'] }, { path: '/v1/embeddings', sessionHeader: 'chat-42' });

        expect(headersSetOn(res)).not.toHaveProperty(POOL_AFFINITY_HEADER.toLowerCase());
        expect(routingLog.list()[0]?.affinity).toBeNull();
      });

      it('matches on the engine as well as the node: the same node offering the model from another engine is a miss', async () => {
        await firstCallLandsOnPeer();
        const peer = mockPeer({
          id: PEER,
          nodeFqdn: PEER_FQDN,
          lastCapabilities: capabilitiesWithModel(MODEL, {
            inFlightRequests: 0,
            backends: [{ type: 'vllm', healthy: true, modelsLoaded: [MODEL] }],
          }) as unknown as Record<string, unknown>,
        });
        peerService.listConnectedPeers.mockResolvedValue([peer]);
        peerService.getPeerById.mockResolvedValue(peer);

        const res = await route(turn2);

        expect(forwardedTo()).toEqual([PEER_FQDN, LOCAL_CANDIDATE_KEY]);
        expect(headersSetOn(res)[POOL_AFFINITY_HEADER.toLowerCase()]).toBe('miss');
        expect(routingLog.list()[0]?.affinity).toMatchObject({ outcome: 'miss', remembered: PEER_FQDN, inFlight: null });
      });
    });

    describe('the session key', () => {
      it('prefers a well-formed header, takes the first of a repeated one, and drops one that is not an id', () => {
        expect(normalizePoolSessionKey('chat-42')).toBe('chat-42');
        expect(normalizePoolSessionKey(['run:7/step=3', 'other'])).toBe('run:7/step=3');
        expect(normalizePoolSessionKey('has space')).toBeUndefined();
        expect(normalizePoolSessionKey('-leading-punctuation')).toBeUndefined();
        expect(normalizePoolSessionKey('x'.repeat(129))).toBeUndefined();
        expect(normalizePoolSessionKey('')).toBeUndefined();
        expect(normalizePoolSessionKey(undefined)).toBeUndefined();
      });

      it('hashes the head of the conversation, so a session keys the same as it grows and two sessions key apart', () => {
        const grown = derivePrefixKey(MODEL, turn2, undefined);
        expect(derivePrefixKey(MODEL, turn1, undefined)).toEqual(grown);
        expect(grown?.source).toBe('hashed');
        const other = derivePrefixKey(MODEL, { ...turn1, messages: [SYSTEM, { role: 'user', content: 'a different task' }] }, undefined);
        expect(other).not.toEqual(grown);
        // The model is part of the key: a cache is per loaded model.
        expect(derivePrefixKey('other:1b', turn1, undefined)).not.toEqual(grown);
      });

      it('includes every leading system message and the first message after them, and nothing later', () => {
        const twoSystem = [SYSTEM, { role: 'system', content: 'and also…' }, { role: 'user', content: 'go' }];
        expect(promptHead({ messages: [...twoSystem, { role: 'assistant', content: 'later' }] })).toEqual(twoSystem);
        expect(
          promptHead({
            messages: [
              { role: 'user', content: 'go' },
              { role: 'assistant', content: 'later' },
            ],
          }),
        ).toEqual([{ role: 'user', content: 'go' }]);
      });

      it('keys a completion or generate body on its system and prompt fields, and nothing on a body with neither', () => {
        expect(promptHead({ model: MODEL, prompt: 'Once upon' })).toEqual([null, 'Once upon']);
        expect(promptHead({ model: MODEL, system: 'Be brief', prompt: 'Once upon' })).toEqual(['Be brief', 'Once upon']);
        expect(promptHead({ model: MODEL, input: ['a'] })).toBeNull();
        expect(promptHead({ model: MODEL, messages: [] })).toBeNull();
        expect(derivePrefixKey(MODEL, { model: MODEL }, undefined)).toBeNull();
        expect(derivePrefixKey(MODEL, 'not an object', undefined)).toBeNull();
      });

      /**
       * The digest reads the whole head, never a window over it. An earlier 4 KB window keyed
       * every session of an agent together once the system prompt alone filled it (core-2,
       * 2026-09-21: six sessions behind one 25k-token prefix, one key), and the table then
       * remembered the node that last served any of them.
       */
      it('keys two sessions apart that share a system prompt longer than any window, and one session together as it grows', () => {
        // ~64 KB of system prompt, then a first user message that differs by a word.
        const longSystem = { role: 'system', content: 'x'.repeat(65_536) };
        const a1 = { messages: [longSystem, { role: 'user', content: 'task a' }] };
        const b1 = { messages: [longSystem, { role: 'user', content: 'task b' }] };
        const a = derivePrefixKey(MODEL, a1, undefined);
        const b = derivePrefixKey(MODEL, b1, undefined);
        expect(a).not.toBeNull();
        expect(a).not.toEqual(b);

        // Session A on its next turn: the head is unchanged, so is the key.
        const a2 = { messages: [...a1.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now b' }] };
        expect(derivePrefixKey(MODEL, a2, undefined)).toEqual(a);

        // A difference deep in the system prompt — past where any window would read — keys apart too.
        const edited = {
          messages: [
            { role: 'system', content: `${'x'.repeat(65_535)}y` },
            { role: 'user', content: 'task a' },
          ],
        };
        expect(derivePrefixKey(MODEL, edited, undefined)).not.toEqual(a);

        // The header still overrides the digest: two bodies that key apart follow one header.
        expect(derivePrefixKey(MODEL, a1, 'chat-42')).toEqual(derivePrefixKey(MODEL, b1, 'chat-42'));
        expect(derivePrefixKey(MODEL, a1, 'chat-42')?.source).toBe('header');
      });

      it('digests a completion body as two framed parts, so the same text split differently between system and prompt keys apart', () => {
        const a = derivePrefixKey(MODEL, { model: MODEL, system: 'Be brief.', prompt: ' Once upon' }, undefined);
        const b = derivePrefixKey(MODEL, { model: MODEL, system: 'Be brief. ', prompt: 'Once upon' }, undefined);
        expect(a).not.toBeNull();
        expect(a).not.toEqual(b);
        // And the whole prompt counts: a body that rebuilds the conversation into `prompt` keys each call apart.
        const grown = derivePrefixKey(MODEL, { model: MODEL, system: 'Be brief.', prompt: ' Once upon a time' }, undefined);
        expect(grown).not.toEqual(a);
      });

      it('never keys an embeddings body, however it is shaped', () => {
        expect(derivePrefixKey(MODEL, { model: MODEL, input: 'x'.repeat(65_536) }, undefined)).toBeNull();
        expect(derivePrefixKey(MODEL, { model: MODEL, input: ['a', 'b'] }, undefined)).toBeNull();
      });
    });

    describe('the store', () => {
      it('is bounded, dropping the least recently written prefix past capacity', () => {
        const store = new PrefixAffinityStore(60_000, 2);
        const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
        store.remember('a', local, 1_000);
        store.remember('b', local, 1_001);
        // Re-writing `a` makes it the most recent, so `b` is the one to go.
        store.remember('a', local, 1_002);
        store.remember('c', local, 1_003);

        expect(store.size).toBe(2);
        expect(store.get('a', 1_003)).toMatchObject({ nodeKey: LOCAL_CANDIDATE_KEY, node: LOCAL_CANDIDATE_KEY, backend: 'ollama' });
        expect(store.get('b', 1_003)).toBeNull();
        expect(store.get('c', 1_003)).not.toBeNull();
      });

      it('drops an expired entry on the read, and forget() drops one at once', () => {
        const store = new PrefixAffinityStore(1_000, 10);
        store.remember('a', { peerId: 'peer-1', nodeFqdn: 'peer-1.tailxyz.ts.net', backend: 'vllm' }, 5_000);

        expect(store.get('a', 6_000)).toMatchObject({ nodeKey: 'peer-1', node: 'peer-1.tailxyz.ts.net', backend: 'vllm' });
        expect(store.get('a', 6_001)).toBeNull();
        expect(store.size).toBe(0);

        store.remember('a', { peerId: 'peer-1', nodeFqdn: 'peer-1.tailxyz.ts.net', backend: 'vllm' }, 7_000);
        store.forget('a');
        expect(store.get('a', 7_000)).toBeNull();
      });
    });

    describe('applyPrefixAffinity', () => {
      const local = { candidate: { peerId: null, nodeFqdn: null, backend: 'ollama' } as PoolCandidate, inFlight: 0 };
      const peer = { candidate: { peerId: 'peer-1', nodeFqdn: 'peer-1.tailxyz.ts.net', backend: 'ollama' } as PoolCandidate, inFlight: 1 };
      const ranked = [local, peer];
      const remembered = { nodeKey: 'peer-1', backend: 'ollama' } as const;

      it('is the identity with nothing remembered', () => {
        expect(applyPrefixAffinity(ranked, null, 2)).toEqual({ ordered: ranked, sticky: null, qualified: false, leastLoadedInFlight: null });
      });

      it('moves the remembered candidate to the front while it is under the limit, and reports it', () => {
        expect(applyPrefixAffinity(ranked, remembered, 2)).toEqual({ ordered: [peer, local], sticky: peer, qualified: true, leastLoadedInFlight: 0 });
      });

      it('leaves the order alone at or over the limit, still reporting what it saw', () => {
        expect(applyPrefixAffinity(ranked, remembered, 1)).toEqual({ ordered: ranked, sticky: peer, qualified: false, leastLoadedInFlight: 0 });
        // 0 is the switch: nothing is ever under it.
        expect(applyPrefixAffinity(ranked, { nodeKey: LOCAL_CANDIDATE_KEY, backend: 'ollama' }, 0)).toEqual({
          ordered: ranked,
          sticky: local,
          qualified: false,
          leastLoadedInFlight: 1,
        });
      });

      /**
       * The labelling caveat from the 2026-09-29 fleet test: margin 0, limit 1, one in flight on the
       * remembered node, and the ranker still put it first. The order is the ranker's and the result
       * says affinity did not qualify, so the row cannot call it an affinity hit.
       */
      it('does not claim a remembered candidate the ranker already put first, when it is over the limit', () => {
        const busyLocal = { ...local, inFlight: 1 };
        const busierPeer = { ...peer, inFlight: 3 };
        const busyRanked = [busyLocal, busierPeer];

        expect(applyPrefixAffinity(busyRanked, { nodeKey: LOCAL_CANDIDATE_KEY, backend: 'ollama' }, 1, 0)).toEqual({
          ordered: busyRanked,
          sticky: busyLocal,
          qualified: false,
          leastLoadedInFlight: 3,
        });
      });

      it('holds the remembered candidate past the limit while its queue is within the margin of the least-loaded alternative', () => {
        const busyPeer = { candidate: { peerId: 'peer-1', nodeFqdn: 'peer-1.tailxyz.ts.net', backend: 'ollama' } as PoolCandidate, inFlight: 2 };
        const busyLocal = { candidate: { peerId: null, nodeFqdn: null, backend: 'ollama' } as PoolCandidate, inFlight: 2 };
        const busyRanked = [busyLocal, busyPeer];

        // At margin 0, with maxInFlight = 2 and inFlight = 2: not under the limit.
        expect(applyPrefixAffinity(busyRanked, remembered, 2, 0)).toEqual({
          ordered: busyRanked,
          sticky: busyPeer,
          qualified: false,
          leastLoadedInFlight: 2,
        });

        // At margin 1 the remembered queue is within one of the least-loaded alternative's, so affinity holds.
        expect(applyPrefixAffinity(busyRanked, remembered, 2, 1)).toEqual({
          ordered: [busyPeer, busyLocal],
          sticky: busyPeer,
          qualified: true,
          leastLoadedInFlight: 2,
        });
      });

      it('sheds load when the remembered candidate is further than the margin behind the least-loaded alternative', () => {
        const veryBusyPeer = { candidate: { peerId: 'peer-1', nodeFqdn: 'peer-1.tailxyz.ts.net', backend: 'ollama' } as PoolCandidate, inFlight: 4 };
        const idleLocal = { candidate: { peerId: null, nodeFqdn: null, backend: 'ollama' } as PoolCandidate, inFlight: 1 };
        const busyRanked = [idleLocal, veryBusyPeer];

        // inFlight=4 > min(1) + margin(1), so affinity does not hold.
        expect(applyPrefixAffinity(busyRanked, remembered, 2, 1)).toEqual({
          ordered: busyRanked,
          sticky: veryBusyPeer,
          qualified: false,
          leastLoadedInFlight: 1,
        });
      });

      it('does nothing with a margin while the limit is 0: the margin widens a limit, it does not switch affinity on', () => {
        expect(applyPrefixAffinity(ranked, remembered, 0, 3)).toEqual({ ordered: ranked, sticky: peer, qualified: false, leastLoadedInFlight: 0 });
      });

      it('matches node and engine together, and never re-admits a node that is not a candidate', () => {
        const none = { ordered: ranked, sticky: null, qualified: false, leastLoadedInFlight: null };
        expect(applyPrefixAffinity(ranked, { nodeKey: 'peer-1', backend: 'vllm' }, 2)).toEqual(none);
        expect(applyPrefixAffinity(ranked, { nodeKey: 'peer-gone', backend: 'ollama' }, 2)).toEqual(none);
      });
    });
  });

  describe('prompt ceiling', () => {
    const MODEL = 'qwen3-coder:30b';
    const LONG_PROMPT_BYTES = 184_000; // ~46k tokens
    const SHORT_PROMPT_BYTES = 40_000; // ~10k tokens
    const FZZY_CEILING = 16_000;

    /** A connected, idle peer holding MODEL, optionally advertising a ceiling. */
    function node(id: string, options: { maxPromptTokens?: unknown; inFlightRequests?: number; hardwareTier?: string } = {}): HubPoolPeer {
      return mockPeer({
        id,
        nodeFqdn: `${id}.tailxyz.ts.net`,
        lastCapabilities: capabilitiesWithModel(MODEL, {
          inFlightRequests: options.inFlightRequests ?? 0,
          ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
          ...('maxPromptTokens' in options ? { maxPromptTokens: options.maxPromptTokens as number } : {}),
        }) as unknown as Record<string, unknown>,
      });
    }

    /** fzzy idle and first by score; core-6 busier, so without a ceiling the ranker picks fzzy. */
    function fzzyAndCore6(): HubPoolPeer[] {
      return [node('fzzy', { maxPromptTokens: FZZY_CEILING, hardwareTier: 'cpu-only' }), node('core-6', { inFlightRequests: 2 })];
    }

    const ids = (candidates: { peerId: string | null }[]) => candidates.map((candidate) => candidate.peerId);

    it('puts a peer whose advertised ceiling is below a long prompt behind the rest, even though the ranker put it first', async () => {
      peerService.listConnectedPeers.mockResolvedValue(fzzyAndCore6());

      expect(ids(await service.buildCandidateList(MODEL))).toEqual(['fzzy', 'core-6']);
      // Last, not gone: removing it would leave a long prompt nowhere to fail over to if core-6 fails.
      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
    });

    it('leaves the ranked list untouched for a prompt under every ceiling', async () => {
      peerService.listConnectedPeers.mockResolvedValue(fzzyAndCore6());

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
    });

    it('keeps a candidate whose ceiling the estimate exactly meets — the ceiling is what it can take', async () => {
      peerService.listConnectedPeers.mockResolvedValue(fzzyAndCore6());

      expect(ids(await service.buildCandidateList(MODEL, FZZY_CEILING * 4))).toEqual(['fzzy', 'core-6']);
      expect(ids(await service.buildCandidateList(MODEL, FZZY_CEILING * 4 + 1))).toEqual(['core-6', 'fzzy']);
    });

    it('puts THIS node behind a peer for a long prompt when its own ceiling is below it', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([node('core-6')]);
      setPoolPreferences({ poolMaxPromptTokens: FZZY_CEILING });

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES))).toEqual([null, 'core-6']);
      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', null]);
    });

    it('honours HUB_POOL_MAX_PROMPT_TOKENS over an unset setting', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([node('core-6')]);
      vi.stubEnv('HUB_POOL_MAX_PROMPT_TOKENS', String(FZZY_CEILING));
      try {
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', null]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('keeps the whole list when every candidate is over its ceiling — a slow answer beats a 502', async () => {
      peerService.listConnectedPeers.mockResolvedValue([node('fzzy', { maxPromptTokens: FZZY_CEILING })]);

      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy']);
    });

    it('treats a peer on an older build, which sends no ceiling, as serving any prompt', async () => {
      peerService.listConnectedPeers.mockResolvedValue([node('fzzy-old-build'), node('core-6', { inFlightRequests: 2 })]);

      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy-old-build', 'core-6']);
    });

    it.each([
      ['a string', '16000'],
      ['a value below the floor', 16],
      ['a negative', -1],
    ])('lets a malformed advertised ceiling (%s) exclude nothing', async (_label, hostile) => {
      peerService.listConnectedPeers.mockResolvedValue([node('fzzy', { maxPromptTokens: hostile }), node('core-6', { inFlightRequests: 2 })]);

      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
    });

    it('judges nothing when the caller has no body to measure, so ranking-only callers see the old order', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue(fzzyAndCore6());
      setPoolPreferences({ poolMaxPromptTokens: FZZY_CEILING });

      expect(ids(await service.buildCandidateList(MODEL))).toEqual([null, 'fzzy', 'core-6']);
    });

    describe('with a pin', () => {
      it('does not let a pin at an over-ceiling node put the long prompt back at the front', async () => {
        peerService.listConnectedPeers.mockResolvedValue(fzzyAndCore6());
        setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'fzzy', mode: 'prefer' }] });

        // The pin still governs the ordinary case...
        expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        // ...and cannot lift fzzy out of the over-ceiling tail for the case the ceiling covers.
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
      });

      it('still reorders the nodes under their ceiling', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        peerService.listConnectedPeers.mockResolvedValue([...fzzyAndCore6(), node('core-7', { inFlightRequests: 5 })]);
        setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', null, 'core-6', 'fzzy']);
      });

      it('applies to the whole list when the ceiling was overridden', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('fzzy', { maxPromptTokens: FZZY_CEILING }),
          node('core-7', { maxPromptTokens: FZZY_CEILING, inFlightRequests: 3 }),
        ]);
        setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', 'fzzy']);
      });
    });

    describe('in the routing log', () => {
      const longTurn = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'x'.repeat(LONG_PROMPT_BYTES) }] };

      function answerWith200(): void {
        vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
      }

      it('says which node its ceiling moved back, at what ceiling, for what estimate — so a skip is not read as the ranker', async () => {
        const peers = fzzyAndCore6();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        answerWith200();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        // bytes / 4 of what actually went out — after the proxy's own usage opt-in — written out rather
        // than through `estimatePromptTokens`, so a change to the estimate cannot pass by agreeing with itself.
        const sent = String(vi.mocked(global.fetch).mock.calls[0]?.[1]?.body);
        const entry = routingLog.list()[0];
        // Two candidates: fzzy is still in the walk, behind core-6, and was simply never needed.
        expect(entry).toMatchObject({ node: 'core-6.tailxyz.ts.net', candidates: 2, attempt: 1, outcome: 'served', failedOverFrom: [] });
        expect(entry?.promptCeiling).toEqual({
          estimatedTokens: Math.ceil(sent.length / 4),
          excluded: [{ node: 'fzzy.tailxyz.ts.net', maxPromptTokens: FZZY_CEILING }],
          overridden: false,
        });
      });

      it('still fails over to the over-ceiling node when every node under a ceiling fails — a ceiling must never turn a served request into a 502', async () => {
        const peers = fzzyAndCore6();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        // core-6 cannot serve right now; fzzy is slow at long prompts but up. Before ceilings existed
        // this request failed over to fzzy and was answered, so it still has to be.
        vi.mocked(global.fetch).mockImplementation(async (url) =>
          String(url).includes('core-6') ? new Response('model not loaded', { status: 503 }) : new Response('data: [DONE]\n\n', { status: 200 }),
        );

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'fzzy.tailxyz.ts.net', outcome: 'served', status: 200, failedOverFrom: ['core-6.tailxyz.ts.net'] });
        // Placed over fzzy's ceiling after all, and the record says so instead of reading as a skip.
        expect(entry?.promptCeiling).toMatchObject({ excluded: [{ node: 'fzzy.tailxyz.ts.net', maxPromptTokens: FZZY_CEILING }], overridden: true });
      });

      it('does not call it an override when a node under its ceiling fails and another under one answers', async () => {
        const peers = [...fzzyAndCore6(), node('core-7', { inFlightRequests: 4 })];
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        vi.mocked(global.fetch).mockImplementation(async (url) =>
          String(url).includes('core-6') ? new Response('overloaded', { status: 503 }) : new Response('data: [DONE]\n\n', { status: 200 }),
        );

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-7.tailxyz.ts.net', outcome: 'served', failedOverFrom: ['core-6.tailxyz.ts.net'], candidates: 3 });
        expect(entry?.promptCeiling).toMatchObject({ overridden: false });
      });

      it.each([
        ['/v1/embeddings'],
        ['/api/embed'],
        ['/api/embeddings'],
      ])('leaves %s alone: an embeddings batch is many short inputs, not one long context', async (path) => {
        const peers = fzzyAndCore6();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        answerWith200();
        const batch = { model: MODEL, input: Array.from({ length: 400 }, () => 'x'.repeat(LONG_PROMPT_BYTES / 400)) };

        await service.proxyRequest({ path, method: 'POST', body: batch, model: MODEL, res: createMockResponse() });

        expect(routingLog.list()[0]).toMatchObject({ node: 'fzzy.tailxyz.ts.net', candidates: 2 });
        expect(routingLog.list()[0]?.promptCeiling).toBeNull();
      });

      it('marks the decision overridden when every candidate was over its ceiling, and still serves it', async () => {
        const fzzy = node('fzzy', { maxPromptTokens: FZZY_CEILING });
        peerService.listConnectedPeers.mockResolvedValue([fzzy]);
        peerService.getPeerById.mockResolvedValue(fzzy);
        answerWith200();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'fzzy.tailxyz.ts.net', outcome: 'served', status: 200 });
        expect(entry?.promptCeiling).toMatchObject({ excluded: [{ node: 'fzzy.tailxyz.ts.net', maxPromptTokens: FZZY_CEILING }], overridden: true });
      });

      it('records the estimate with nothing excluded when a ceiling was in play but the prompt was under it', async () => {
        const peers = fzzyAndCore6();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        answerWith200();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

        expect(routingLog.list()[0]).toMatchObject({ node: 'fzzy.tailxyz.ts.net' });
        expect(routingLog.list()[0]?.promptCeiling).toMatchObject({ excluded: [], overridden: false });
      });

      it('stays null on a fleet where no node has a ceiling', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        answerWith200();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        expect(routingLog.list()[0]?.promptCeiling).toBeNull();
      });

      it('logs one debug line for a request the ceiling changed, and none for one it did not', async () => {
        const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
        const peers = fzzyAndCore6();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        answerWith200();
        try {
          await service.proxyRequest({
            path: '/v1/chat/completions',
            method: 'POST',
            body: { model: MODEL },
            model: MODEL,
            res: createMockResponse(),
          });
          expect(debugSpy.mock.calls.filter(([line]) => String(line).includes('ceiling'))).toHaveLength(0);

          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });
          const lines = debugSpy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('ceiling'));
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain('put fzzy.tailxyz.ts.net (ceiling 16000) behind every candidate under its ceiling');
          // Sizes and names only: a routing decision's log line is never a place for the prompt.
          expect(lines[0]).not.toContain('xxxx');
        } finally {
          debugSpy.mockRestore();
        }
      });
    });

    describe('applyPromptCeiling', () => {
      const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
      const localVllm = { peerId: null, nodeFqdn: null, backend: 'vllm' } as const;
      const core6 = { peerId: 'core-6', nodeFqdn: 'core-6.tailxyz.ts.net', backend: 'ollama' } as const;

      it('returns the ranked list, and no decision, when no candidate has a ceiling', () => {
        const result = applyPromptCeiling([local, core6], () => null, 46_000);

        expect(result).toEqual({ preferred: [local, core6], overCeiling: [], decision: null });
      });

      it('keeps every over-ceiling candidate, in ranked order, for the failover tail', () => {
        const fzzy = { peerId: 'fzzy', nodeFqdn: 'fzzy.tailxyz.ts.net', backend: 'ollama' } as const;

        const result = applyPromptCeiling([fzzy, local, core6], (candidate) => (candidate.peerId === 'core-6' ? null : FZZY_CEILING), 46_000);

        expect(result.preferred).toEqual([core6]);
        expect(result.overCeiling).toEqual([fzzy, local]);
      });

      it('moves nothing, and says it was overridden, when every candidate is over its ceiling', () => {
        const result = applyPromptCeiling([local, core6], () => FZZY_CEILING, 46_000);

        expect(result.preferred).toEqual([local, core6]);
        expect(result.overCeiling).toEqual([]);
        expect(result.decision?.overridden).toBe(true);
      });

      it('names this node once however many of its engines the ceiling moved back', () => {
        const result = applyPromptCeiling([local, localVllm, core6], (candidate) => (candidate.peerId === null ? FZZY_CEILING : null), 46_000);

        expect(result.preferred).toEqual([core6]);
        expect(result.overCeiling).toEqual([local, localVllm]);
        expect(result.decision).toEqual({
          estimatedTokens: 46_000,
          excluded: [{ node: LOCAL_CANDIDATE_KEY, maxPromptTokens: FZZY_CEILING }],
          overridden: false,
        });
      });
    });
  });

  /**
   * Context caps at placement, with the fleet's own numbers (2026-09-21, `qwen3-coder:30b`): core-17
   * is a 4×16384 batch node and advertises `maxNumCtx: 16384`; beta-max runs 4×32768; the agent tier
   * (core-2/4/5/6) runs 4×65536 and advertises no cap. A Hermes turn carries `options.num_ctx: 65536`
   * on the native Ollama dialect. Placing it on core-17 reloads core-17's model at 65536 (the core-2
   * flip of 2026-09-20, on a smaller card), so the cap moves core-17 back the way a prompt ceiling
   * does — and that is what lets the handout stop using core-17's number for the whole fleet.
   */
  describe('context cap', () => {
    const MODEL = 'qwen3-coder:30b';
    const SHORT_PROMPT_BYTES = 8_000; // ~2k tokens
    const LONG_PROMPT_BYTES = 184_000; // ~46k tokens
    const CORE17_CAP = 16_384;

    /** A connected, idle peer holding MODEL, optionally advertising a context cap and a ceiling. */
    function node(id: string, options: { maxNumCtx?: unknown; maxPromptTokens?: number; inFlightRequests?: number } = {}): HubPoolPeer {
      return mockPeer({
        id,
        nodeFqdn: `${id}.tailxyz.ts.net`,
        lastCapabilities: capabilitiesWithModel(MODEL, {
          inFlightRequests: options.inFlightRequests ?? 0,
          ...('maxNumCtx' in options ? { maxNumCtx: options.maxNumCtx as number } : {}),
          ...('maxPromptTokens' in options ? { maxPromptTokens: options.maxPromptTokens } : {}),
        }) as unknown as Record<string, unknown>,
      });
    }

    /** core-17 idle and first by score; core-2 busier and uncapped, so without a cap the ranker picks core-17. */
    function core17AndCore2(): HubPoolPeer[] {
      return [node('core-17', { maxNumCtx: CORE17_CAP }), node('core-2', { inFlightRequests: 2 })];
    }

    const ids = (candidates: { peerId: string | null }[]) => candidates.map((candidate) => candidate.peerId);
    const setLocalCap = (maxNumCtx: number | null) => configuration.getInferencePreferences.mockReturnValue({ maxNumCtx } as never);

    it('puts a peer capped below the num_ctx a request carries behind the rest, even though the ranker put it first', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());

      expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-17', 'core-2']);
      // Last, not gone: a request still has somewhere to go if core-2 fails.
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-2', 'core-17']);
    });

    it('leaves the ranked list untouched for a num_ctx every cap can take', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 4096))).toEqual(['core-17', 'core-2']);
    });

    it('keeps a candidate whose cap the request exactly meets — the cap is the window its engine runs', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, CORE17_CAP))).toEqual(['core-17', 'core-2']);
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, CORE17_CAP + 1))).toEqual(['core-2', 'core-17']);
    });

    it('puts THIS node behind a peer for a num_ctx above its own cap', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([node('core-2')]);
      setLocalCap(CORE17_CAP);

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 4096))).toEqual([null, 'core-2']);
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-2', null]);
    });

    it('judges a request with no num_ctx by its prompt estimate: an engine runs it at the window the cap records', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());

      // ~2k tokens fits a 16384 window; ~46k does not, and core-17 would truncate it.
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES))).toEqual(['core-17', 'core-2']);
      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-2', 'core-17']);
    });

    it('believes an explicit num_ctx over the estimate, in both directions', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());

      // A long prompt that says it wants a small window is the app's business, not the proxy's...
      expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES, true, 4096))).toEqual(['core-17', 'core-2']);
      // ...and a short one asking for 65536 still reloads core-17's model at 65536.
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-2', 'core-17']);
    });

    it('keeps the whole list when every candidate is capped below the window — a reload beats a 502', async () => {
      peerService.listConnectedPeers.mockResolvedValue([
        node('core-17', { maxNumCtx: CORE17_CAP }),
        node('beta-max', { maxNumCtx: 32_768, inFlightRequests: 1 }),
      ]);

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-17', 'beta-max']);
    });

    it('treats a peer with no cap — none set, or an older build — as taking any window', async () => {
      peerService.listConnectedPeers.mockResolvedValue([node('core-2-old-build'), node('core-6', { inFlightRequests: 2 })]);

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 262_144))).toEqual(['core-2-old-build', 'core-6']);
    });

    it.each([
      ['a string', '16384'],
      ['a value below the floor', 16],
      ['a negative', -1],
      ['a fraction', 16_384.5],
    ])('lets a malformed advertised cap (%s) exclude nothing', async (_label, hostile) => {
      peerService.listConnectedPeers.mockResolvedValue([node('core-17', { maxNumCtx: hostile }), node('core-2', { inFlightRequests: 2 })]);

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-17', 'core-2']);
    });

    it('judges nothing when the caller has no body to measure, so ranking-only callers see the old order', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());
      setLocalCap(CORE17_CAP);

      expect(ids(await service.buildCandidateList(MODEL))).toEqual([null, 'core-17', 'core-2']);
    });

    it('is the outer split over the prompt ceiling: a node over its cap goes behind one merely over its ceiling', async () => {
      // core-17: under its 14000 ceiling for this prompt, but capped at 16384 — a 65536 request reloads it.
      // fzzy: over its ceiling (slow), but uncapped — it can take the window without a reload.
      peerService.listConnectedPeers.mockResolvedValue([
        node('core-17', { maxNumCtx: CORE17_CAP, maxPromptTokens: 14_000 }),
        node('fzzy', { maxPromptTokens: 1024, inFlightRequests: 1 }),
      ]);

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['fzzy', 'core-17']);
      // With a window core-17 can take, the ceiling decides as before.
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 4096))).toEqual(['core-17', 'fzzy']);
    });

    it('does not let a pin at an over-cap node put the request back at the front', async () => {
      peerService.listConnectedPeers.mockResolvedValue(core17AndCore2());
      setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'core-17', mode: 'prefer' }] });

      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 4096))).toEqual(['core-17', 'core-2']);
      expect(ids(await service.buildCandidateList(MODEL, SHORT_PROMPT_BYTES, true, 65_536))).toEqual(['core-2', 'core-17']);
    });

    describe('in the routing log', () => {
      const hermesTurn = {
        model: MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'x'.repeat(SHORT_PROMPT_BYTES) }],
        options: { num_ctx: 65_536 },
      };

      function answerWith200(): void {
        vi.mocked(global.fetch).mockImplementation(async () => new Response('{"done":true}\n', { status: 200 }));
      }

      function servePeers(peers: HubPoolPeer[]): void {
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
      }

      it('says which node its cap moved back, at what cap, for what window — so a skip is not read as the ranker', async () => {
        servePeers(core17AndCore2());
        answerWith200();

        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-2.tailxyz.ts.net', candidates: 2, attempt: 1, outcome: 'served', failedOverFrom: [] });
        expect(entry?.contextCap).toEqual({
          numCtx: 65_536,
          source: 'request',
          excluded: [{ node: 'core-17.tailxyz.ts.net', maxNumCtx: CORE17_CAP }],
          overridden: false,
        });
      });

      it('records the estimate as the window for a /v1 request, which cannot carry num_ctx', async () => {
        // core-2 carries a ceiling too, so the ceiling half of the record is present to compare against.
        servePeers([node('core-17', { maxNumCtx: CORE17_CAP }), node('core-2', { inFlightRequests: 2, maxPromptTokens: 100_000 })]);
        answerWith200();
        const longTurn = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'x'.repeat(LONG_PROMPT_BYTES) }] };

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

        // bytes / 4 of what actually went out — after the proxy's own usage opt-in — written out rather
        // than through `estimatePromptTokens`, so a change to the estimate cannot pass by agreeing with itself.
        const sent = String(vi.mocked(global.fetch).mock.calls[0]?.[1]?.body);
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-2.tailxyz.ts.net' });
        expect(entry?.contextCap).toEqual({
          numCtx: Math.ceil(sent.length / 4),
          source: 'estimated',
          excluded: [{ node: 'core-17.tailxyz.ts.net', maxNumCtx: CORE17_CAP }],
          overridden: false,
        });
        // The same estimate the ceiling and the deadline use, so a request is never judged small for one and large for another.
        expect(entry?.promptCeiling?.estimatedTokens).toBe(entry?.contextCap?.numCtx);
      });

      it('ignores options.num_ctx on a /v1 request, as Ollama does: it runs at the engine default all the same', async () => {
        servePeers(core17AndCore2());
        answerWith200();

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: MODEL, stream: true, options: { num_ctx: 65_536 }, messages: [{ role: 'user', content: 'hello' }] },
          model: MODEL,
          res: createMockResponse(),
        });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-17.tailxyz.ts.net' });
        expect(entry?.contextCap).toMatchObject({ source: 'estimated', excluded: [] });
      });

      it('still fails over to the capped node when every node that can take the window fails — a cap must never turn a served request into a 502', async () => {
        servePeers(core17AndCore2());
        vi.mocked(global.fetch).mockImplementation(async (url) =>
          String(url).includes('core-2') ? new Response('model not loaded', { status: 503 }) : new Response('{"done":true}\n', { status: 200 }),
        );

        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-17.tailxyz.ts.net', outcome: 'served', status: 200, failedOverFrom: ['core-2.tailxyz.ts.net'] });
        // Placed over core-17's cap after all, and the record says so instead of reading as a skip.
        expect(entry?.contextCap).toMatchObject({ excluded: [{ node: 'core-17.tailxyz.ts.net', maxNumCtx: CORE17_CAP }], overridden: true });
      });

      it('marks the decision overridden when every candidate was capped below the window, and still serves it', async () => {
        const core17 = node('core-17', { maxNumCtx: CORE17_CAP });
        servePeers([core17]);
        answerWith200();

        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesTurn, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-17.tailxyz.ts.net', outcome: 'served', status: 200 });
        expect(entry?.contextCap).toMatchObject({
          numCtx: 65_536,
          excluded: [{ node: 'core-17.tailxyz.ts.net', maxNumCtx: CORE17_CAP }],
          overridden: true,
        });
      });

      it('records the window with nothing excluded when a cap was in play but every node could take it', async () => {
        servePeers(core17AndCore2());
        answerWith200();

        await service.proxyRequest({
          path: '/api/chat',
          method: 'POST',
          body: { ...hermesTurn, options: { num_ctx: 4096 } },
          model: MODEL,
          res: createMockResponse(),
        });

        expect(routingLog.list()[0]).toMatchObject({ node: 'core-17.tailxyz.ts.net' });
        expect(routingLog.list()[0]?.contextCap).toEqual({ numCtx: 4096, source: 'request', excluded: [], overridden: false });
      });

      it('stays null on a fleet where no node has a cap, and on an embeddings batch', async () => {
        servePeers([node('core-2'), node('core-6', { inFlightRequests: 1 })]);
        answerWith200();

        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesTurn, model: MODEL, res: createMockResponse() });
        expect(routingLog.list()[0]?.contextCap).toBeNull();

        servePeers(core17AndCore2());
        await service.proxyRequest({
          path: '/v1/embeddings',
          method: 'POST',
          body: { model: MODEL, input: ['x'] },
          model: MODEL,
          res: createMockResponse(),
        });
        expect(routingLog.list()[0]?.contextCap).toBeNull();
      });

      it('logs one debug line for a request the cap changed, naming the window and the cap, and none for one it did not', async () => {
        const debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
        servePeers(core17AndCore2());
        answerWith200();
        try {
          await service.proxyRequest({
            path: '/api/chat',
            method: 'POST',
            body: { ...hermesTurn, options: { num_ctx: 4096 } },
            model: MODEL,
            res: createMockResponse(),
          });
          expect(debugSpy.mock.calls.filter(([line]) => String(line).includes('context cap') || String(line).includes('whose cap'))).toHaveLength(0);

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesTurn, model: MODEL, res: createMockResponse() });
          const lines = debugSpy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('whose cap'));
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain(
            'num_ctx 65536 for "qwen3-coder:30b" put core-17.tailxyz.ts.net (cap 16384) behind every candidate whose cap can take it',
          );
          expect(lines[0]).not.toContain('xxxx');
        } finally {
          debugSpy.mockRestore();
        }
      });
    });

    describe('requestedNumCtx', () => {
      it('reads a positive integer options.num_ctx and nothing else', () => {
        expect(requestedNumCtx({ options: { num_ctx: 65_536 } })).toBe(65_536);
        expect(requestedNumCtx({ options: { num_ctx: 0 } })).toBeNull();
        expect(requestedNumCtx({ options: { num_ctx: -1 } })).toBeNull();
        expect(requestedNumCtx({ options: { num_ctx: 16_384.5 } })).toBeNull();
        expect(requestedNumCtx({ options: { num_ctx: '65536' } })).toBeNull();
        expect(requestedNumCtx({ options: {} })).toBeNull();
        expect(requestedNumCtx({ num_ctx: 65_536 })).toBeNull();
        expect(requestedNumCtx({ options: null })).toBeNull();
        expect(requestedNumCtx(null)).toBeNull();
        expect(requestedNumCtx('options')).toBeNull();
      });
    });

    describe('applyContextCap', () => {
      const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
      const localVllm = { peerId: null, nodeFqdn: null, backend: 'vllm' } as const;
      const core2 = { peerId: 'core-2', nodeFqdn: 'core-2.tailxyz.ts.net', backend: 'ollama' } as const;
      const core17 = { peerId: 'core-17', nodeFqdn: 'core-17.tailxyz.ts.net', backend: 'ollama' } as const;
      const request = { numCtx: 65_536, source: 'request' as const };

      it('returns the ranked list, and no decision, when no candidate has a cap', () => {
        expect(applyContextCap([local, core2], () => null, request)).toEqual({ preferred: [local, core2], overCap: [], decision: null });
      });

      it('keeps every over-cap candidate, in ranked order, for the failover tail', () => {
        const result = applyContextCap([core17, local, core2], (candidate) => (candidate.peerId === 'core-2' ? null : CORE17_CAP), request);

        expect(result.preferred).toEqual([core2]);
        expect(result.overCap).toEqual([core17, local]);
      });

      it('moves nothing, and says it was overridden, when every candidate is capped below the window', () => {
        const result = applyContextCap([local, core2], () => CORE17_CAP, request);

        expect(result.preferred).toEqual([local, core2]);
        expect(result.overCap).toEqual([]);
        expect(result.decision?.overridden).toBe(true);
      });

      it('names this node once however many of its engines the cap moved back, and carries the source', () => {
        const result = applyContextCap([local, localVllm, core2], (candidate) => (candidate.peerId === null ? CORE17_CAP : null), {
          numCtx: 46_000,
          source: 'estimated',
        });

        expect(result.preferred).toEqual([core2]);
        expect(result.overCap).toEqual([local, localVllm]);
        expect(result.decision).toEqual({
          numCtx: 46_000,
          source: 'estimated',
          excluded: [{ node: LOCAL_CANDIDATE_KEY, maxNumCtx: CORE17_CAP }],
          overridden: false,
        });
      });
    });
  });

  /**
   * Slot-aware placement, with the fleet's own numbers (2026-09-21, fleet-qa B5 cell, 4-way bursts):
   * the batch-tier nodes moved to `OLLAMA_NUM_PARALLEL=2` queued requests behind Ollama for 5–10 s to
   * the first token — beta-max 0.47 s → 9.0 s — while 4-slot nodes sat idle, and the fleet aggregate at
   * c=4 fell 14–16 %. The ranker alone prefers the 2-slot node here when it has the shorter queue,
   * which is exactly the placement that queued. Every test is one of three questions: does a request
   * go first to a node with a free slot, does a fleet with the knob off — or with no slot count stated
   * — route exactly as before, and can a full slot ever turn a request that would have been served
   * into a 502.
   */
  describe('slot-aware placement', () => {
    const MODEL = 'qwen3-coder:30b';

    /** A connected peer holding MODEL on Ollama, with a queue depth and optionally a stated slot count. */
    function node(
      id: string,
      options: {
        inFlightRequests?: number;
        ollamaSlots?: unknown;
        maxPromptTokens?: number;
        hardwareTier?: string;
        backend?: 'ollama' | 'vllm';
      } = {},
    ): HubPoolPeer {
      return mockPeer({
        id,
        nodeFqdn: `${id}.tailxyz.ts.net`,
        lastCapabilities: {
          ...capabilitiesWithModel(MODEL, {
            inFlightRequests: options.inFlightRequests ?? 0,
            ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
            // `unknown`, as for the ceiling: this arrives as jsonb the peer controls.
            ...('ollamaSlots' in options ? { ollamaSlots: options.ollamaSlots as number } : {}),
            ...(options.maxPromptTokens === undefined ? {} : { maxPromptTokens: options.maxPromptTokens }),
          }),
          ...(options.backend && options.backend !== 'ollama' ? { backends: [{ type: options.backend, healthy: true, modelsLoaded: [MODEL] }] } : {}),
        } as unknown as Record<string, unknown>,
      });
    }

    /** beta-max: 2 slots, both busy, so the ranker likes its queue of 2. core-2: 4 slots, 3 busy, so one is free. */
    function betaMaxAndCore2(): HubPoolPeer[] {
      return [node('beta-max', { inFlightRequests: 2, ollamaSlots: 2 }), node('core-2', { inFlightRequests: 3, ollamaSlots: 4 })];
    }

    const ids = (candidates: { peerId: string | null }[]) => candidates.map((candidate) => candidate.peerId);

    describe('at the default (poolSlotAwareness = 0) nothing changes', () => {
      it('ranks a full 2-slot node ahead of a 4-slot node with a free slot, on queue depth alone — the pre-slots order', async () => {
        peerService.listConnectedPeers.mockResolvedValue(betaMaxAndCore2());

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['beta-max', 'core-2']);
      });

      it('reads no slot count at all: this node stays first however full its own engine is', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        configuration.getInferencePreferences.mockReturnValue({ ollamaSlots: 2 } as never);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        peerService.listConnectedPeers.mockResolvedValue([node('core-2', { inFlightRequests: 1, ollamaSlots: 4 })]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual([null, 'core-2']);
      });

      it('records no slot decision, so the routing log reads as it did before', async () => {
        const peers = betaMaxAndCore2();
        peerService.listConnectedPeers.mockResolvedValue(peers);
        peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
        vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: MODEL, stream: true },
          model: MODEL,
          res: createMockResponse(),
        });

        expect(routingLog.list()[0]).toMatchObject({ node: 'beta-max.tailxyz.ts.net', slots: null });
      });
    });

    describe('with the knob on', () => {
      beforeEach(() => {
        setPoolPreferences({ poolSlotAwareness: 1 });
      });

      it('puts a 2-slot peer with 2 in flight behind a 4-slot peer with 3 in flight, though the ranker scored it first', async () => {
        peerService.listConnectedPeers.mockResolvedValue(betaMaxAndCore2());

        // Behind, not gone: a burst that fills core-2 too still has beta-max to fail over to.
        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-2', 'beta-max']);
      });

      it('leaves a node with a free slot where the ranker put it', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('beta-max', { inFlightRequests: 1, ollamaSlots: 2 }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['beta-max', 'core-2']);
      });

      it('leaves a peer that states no slot count untouched — an older build, or an operator who never set one', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('old-build', { inFlightRequests: 2 }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['old-build', 'core-2']);
      });

      it('puts THIS node behind a peer with a free slot when its own slots are full', async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        configuration.getInferencePreferences.mockReturnValue({ ollamaSlots: 2 } as never);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        peerService.listConnectedPeers.mockResolvedValue([node('core-2', { inFlightRequests: 1, ollamaSlots: 4 })]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-2', null]);
      });

      it('keeps the whole list, in ranked order, when every candidate is full — a queued answer beats a 502', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('beta-max', { inFlightRequests: 2, ollamaSlots: 2 }),
          node('core-2', { inFlightRequests: 4, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['beta-max', 'core-2']);
      });

      it('leaves a vLLM candidate in rank order when the node states a full slot count', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('vllm-node', { inFlightRequests: 2, ollamaSlots: 2, backend: 'vllm' }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['vllm-node', 'core-2']);
      });

      it('counts the requests this node forwarded a peer since its snapshot, so a burst fills its slots here before the peer reports it', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('beta-max', { inFlightRequests: 0, ollamaSlots: 2 }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);
        loadService.acquire('beta-max');
        loadService.acquire('beta-max');

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-2', 'beta-max']);
      });

      it('treats a 1-slot peer whose snapshot is stale as full — an unmeasured node is never taken for an idle one', async () => {
        const stale = new Date(Date.now() - DEFAULT_POOL_HEALTH_POLL_SECONDS * 1000 * 4).toISOString();
        peerService.listConnectedPeers.mockResolvedValue([
          mockPeer({ ...node('one-slot', { inFlightRequests: 0, ollamaSlots: 1 }), lastSeenAt: stale }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-2', 'one-slot']);
      });

      it.each([
        ['a string', '2'],
        ['zero', 0],
        ['a negative', -1],
        ['past the bound', 65],
      ])('lets a malformed advertised slot count (%s) demote nothing', async (_label, hostile) => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('beta-max', { inFlightRequests: 2, ollamaSlots: hostile }),
          node('core-2', { inFlightRequests: 3, ollamaSlots: 4 }),
        ]);

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['beta-max', 'core-2']);
      });

      it('applies inside the ceiling: a full node under its ceiling still goes ahead of a free node over it', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          node('beta-max', { inFlightRequests: 2, ollamaSlots: 2 }),
          node('fzzy', { inFlightRequests: 0, ollamaSlots: 4, maxPromptTokens: MIN_POOL_MAX_PROMPT_TOKENS }),
        ]);

        // ~46k tokens: over fzzy's ceiling, so fzzy is the ceiling tail whatever its slots say.
        expect(ids(await service.buildCandidateList(MODEL, 184_000))).toEqual(['beta-max', 'fzzy']);
      });

      it('applies before a pin, so a pin at a full node cannot put it back in front of a free one', async () => {
        peerService.listConnectedPeers.mockResolvedValue(betaMaxAndCore2());
        setPoolPreferences({
          poolSlotAwareness: 1,
          poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'beta-max', mode: 'prefer' }],
        });

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['core-2', 'beta-max']);
      });

      describe('in the routing log', () => {
        const turn = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hello' }] };

        it('says which node its slots moved back, at what queue depth, against how many slots', async () => {
          const peers = betaMaxAndCore2();
          peerService.listConnectedPeers.mockResolvedValue(peers);
          peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'core-2.tailxyz.ts.net', candidates: 2, attempt: 1, outcome: 'served', failedOverFrom: [] });
          expect(entry?.slots).toEqual({
            demoted: [{ node: 'beta-max.tailxyz.ts.net', backend: 'ollama', inFlight: 2, slots: 2 }],
            overridden: false,
          });
        });

        it('records an empty decision when every stated node had a free slot, so the figures are visible for the requests that fit too', async () => {
          const peers = [node('beta-max', { inFlightRequests: 1, ollamaSlots: 2 }), node('core-2', { inFlightRequests: 3, ollamaSlots: 4 })];
          peerService.listConnectedPeers.mockResolvedValue(peers);
          peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn, model: MODEL, res: createMockResponse() });

          expect(routingLog.list()[0]?.slots).toEqual({ demoted: [], overridden: false });
        });

        it('still fails over to the full node when every node with a free slot fails, and says the demotion was overridden', async () => {
          const peers = betaMaxAndCore2();
          peerService.listConnectedPeers.mockResolvedValue(peers);
          peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
          vi.mocked(global.fetch).mockImplementation(async (url) =>
            String(url).includes('core-2') ? new Response('model not loaded', { status: 503 }) : new Response('data: [DONE]\n\n', { status: 200 }),
          );

          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'beta-max.tailxyz.ts.net', outcome: 'served', status: 200, failedOverFrom: ['core-2.tailxyz.ts.net'] });
          expect(entry?.slots).toMatchObject({ demoted: [{ node: 'beta-max.tailxyz.ts.net', inFlight: 2, slots: 2 }], overridden: true });
        });

        it('says the demotion was overridden when a prompt ceiling put every free node behind the full one, so the placement is not read as a skip', async () => {
          const peers = [
            node('beta-max', { inFlightRequests: 2, ollamaSlots: 2 }),
            node('fzzy', { inFlightRequests: 0, ollamaSlots: 4, maxPromptTokens: MIN_POOL_MAX_PROMPT_TOKENS }),
          ];
          peerService.listConnectedPeers.mockResolvedValue(peers);
          peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
          const longTurn = { model: MODEL, stream: true, messages: [{ role: 'user', content: 'x'.repeat(184_000) }] };

          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: longTurn, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'beta-max.tailxyz.ts.net', attempt: 1, failedOverFrom: [] });
          expect(entry?.promptCeiling).toMatchObject({ excluded: [{ node: 'fzzy.tailxyz.ts.net' }], overridden: false });
          expect(entry?.slots).toMatchObject({ demoted: [{ node: 'beta-max.tailxyz.ts.net', inFlight: 2, slots: 2 }], overridden: true });
        });

        it('judges an embedding too: slots queue every request, not only the ones a ceiling judges', async () => {
          const peers = betaMaxAndCore2();
          peerService.listConnectedPeers.mockResolvedValue(peers);
          peerService.getPeerById.mockImplementation(async (id: string) => peers.find((peer) => peer.id === id));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));

          await service.proxyRequest({
            path: '/v1/embeddings',
            method: 'POST',
            body: { model: MODEL, input: 'x' },
            model: MODEL,
            res: createMockResponse(),
          });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'core-2.tailxyz.ts.net', promptCeiling: null });
          expect(entry?.slots).toMatchObject({ demoted: [{ node: 'beta-max.tailxyz.ts.net' }], overridden: false });
        });
      });
    });

    describe('applySlotPlacement', () => {
      const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
      const betaMax = { peerId: 'beta-max', nodeFqdn: 'beta-max.tailxyz.ts.net', backend: 'ollama' } as const;
      const core2 = { peerId: 'core-2', nodeFqdn: 'core-2.tailxyz.ts.net', backend: 'ollama' } as const;

      it('demotes nothing, and records no decision, when no candidate states a slot count', () => {
        expect(applySlotPlacement([local, betaMax, core2], () => null)).toEqual({ demoted: new Set(), decision: null });
      });

      it('demotes exactly the candidates whose queue has reached their slots, and names them in ranked order', () => {
        const occupancy = { local: { inFlight: 4, slots: 4 }, 'beta-max': { inFlight: 2, slots: 2 }, 'core-2': { inFlight: 3, slots: 4 } } as const;

        const result = applySlotPlacement([betaMax, local, core2], (candidate) => occupancy[candidate.peerId ?? 'local']);

        expect([...result.demoted]).toEqual([betaMax, local]);
        expect(result.decision).toEqual({
          demoted: [
            { node: 'beta-max.tailxyz.ts.net', backend: 'ollama', inFlight: 2, slots: 2 },
            { node: LOCAL_CANDIDATE_KEY, backend: 'ollama', inFlight: 4, slots: 4 },
          ],
          overridden: false,
        });
        expect(splitDemoted([betaMax, local, core2], result.demoted)).toEqual([[core2], [betaMax, local]]);
      });

      it('demotes nothing, and says it was overridden, when every candidate is full', () => {
        const result = applySlotPlacement([betaMax, core2], () => ({ inFlight: 2, slots: 2 }));

        expect(result.demoted.size).toBe(0);
        expect(result.decision).toMatchObject({ overridden: true });
        expect(result.decision?.demoted).toHaveLength(2);
      });

      it('leaves an unstated candidate in place and still counts it as free, so a full node is demoted behind it', () => {
        const result = applySlotPlacement([betaMax, core2], (candidate) => (candidate.peerId === 'beta-max' ? { inFlight: 2, slots: 2 } : null));

        expect([...result.demoted]).toEqual([betaMax]);
        expect(result.decision?.overridden).toBe(false);
      });
    });
  });

  /**
   * Throughput-aware placement, with the fleet's own numbers (2026-09-17, `qwen3-coder:30b`): fzzy
   * serves it on CPU, read a ~10.6k-token turn at ~123 tok/s, and produced no first byte for a
   * ~46k-token one inside its 922 s budget; core-6 (GPU) prefilled that turn at ~496 tok/s. The ranker
   * alone prefers fzzy here — it is idle and core-6 is not — which is exactly the placement that burned
   * the budget. Every test is one of three questions: does a long prompt go first to a node measured
   * able to answer it in time, does everything unmeasured or short route exactly as before, and can a
   * measurement ever turn a request that would have been served into a 502.
   */
  describe('throughput placement', () => {
    const MODEL = 'qwen3-coder:30b';
    const LONG_PROMPT_BYTES = 184_000; // ~46k estimated tokens
    const MEDIUM_PROMPT_BYTES = 42_400; // ~10.6k
    const SMALL_PROMPT_BYTES = 20_000; // ~5k
    const FZZY = { nodeKey: 'fzzy', backend: 'ollama', model: MODEL } as const;
    const CORE_6 = { nodeKey: 'core-6', backend: 'ollama', model: MODEL } as const;

    /** A connected peer holding MODEL, idle unless told otherwise, optionally advertising throughput. */
    function node(
      id: string,
      options: { inFlightRequests?: number; hardwareTier?: string; maxPromptTokens?: number; ollamaSlots?: number; throughput?: unknown } = {},
    ): HubPoolPeer {
      return mockPeer({
        id,
        nodeFqdn: `${id}.tailxyz.ts.net`,
        lastCapabilities: capabilitiesWithModel(MODEL, {
          inFlightRequests: options.inFlightRequests ?? 0,
          ...(options.hardwareTier ? { hardwareTier: options.hardwareTier } : {}),
          ...(options.maxPromptTokens ? { maxPromptTokens: options.maxPromptTokens } : {}),
          ...(options.ollamaSlots ? { ollamaSlots: options.ollamaSlots } : {}),
          ...('throughput' in options ? { throughput: options.throughput as PoolThroughputEstimate[] } : {}),
        }) as unknown as Record<string, unknown>,
      });
    }

    /** fzzy idle and first by score; core-6 busier, so without measurements the ranker picks fzzy. */
    function fzzyAndCore6(): HubPoolPeer[] {
      return [node('fzzy', { hardwareTier: 'cpu-only' }), node('core-6', { inFlightRequests: 2 })];
    }

    /** Serve `peers()` fresh on every read, so a test that moves the clock never ages a snapshot into staleness. */
    function usePeers(peers: () => HubPoolPeer[]): void {
      peerService.listConnectedPeers.mockImplementation(async () => peers());
      peerService.getPeerById.mockImplementation(async (id: string) => peers().find((peer) => peer.id === id));
    }

    /** What the fleet measured on fzzy. */
    function recordFzzyOnTheFleet(now = Date.now()): void {
      throughput.recordPrefill(FZZY, { promptTokens: 10_600, ms: (10_600 / 123) * 1000, deadline: false }, now);
      throughput.recordPrefill(FZZY, { promptTokens: 46_000, ms: 922_000, deadline: true }, now);
    }

    const ids = (candidates: { peerId: string | null }[]) => candidates.map((candidate) => candidate.peerId);
    const turn = (bytes: number, extra: Record<string, unknown> = {}) => ({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'x'.repeat(bytes) }],
      ...extra,
    });

    describe('ranking', () => {
      it('moves a node measured too slow for a long prompt behind the rest — and only for a long prompt', async () => {
        usePeers(fzzyAndCore6);
        recordFzzyOnTheFleet();

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        // ~10.6k tokens at the ~123 tok/s fzzy managed is well inside the 300 s minimum budget.
        expect(ids(await service.buildCandidateList(MODEL, MEDIUM_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        // Below the smallest measured band nothing applies, so the ranker decides alone.
        expect(ids(await service.buildCandidateList(MODEL, SMALL_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
      });

      /**
       * The case the feature exists for. fzzy's only evidence is the 10.6k turn it served at ~123
       * tok/s — nothing has missed a deadline yet — and the next turn is the ~46k one that ran out of
       * its 922 s budget on the fleet. Reading the measurement forward is what places that FIRST turn
       * on core-6 instead of learning it the expensive way.
       */
      it('places the first long turn away from a node measured slow at a smaller prompt, before any deadline is missed', async () => {
        usePeers(fzzyAndCore6);
        throughput.recordPrefill(FZZY, { promptTokens: 10_600, ms: (10_600 / 123) * 1000, deadline: false });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        // The same measurement leaves the prompts it actually covers alone.
        expect(ids(await service.buildCandidateList(MODEL, MEDIUM_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
      });

      it('leaves a GPU node in front for that same turn: its measured rate has the headroom', async () => {
        usePeers(() => [node('beta-max', { hardwareTier: 'high' }), node('core-6', { inFlightRequests: 2 })]);
        // ~190 tok/s at 8k, where beta-max's 27B still is before the context grows.
        throughput.recordPrefill({ ...FZZY, nodeKey: 'beta-max' }, { promptTokens: 8_000, ms: (8_000 / 190) * 1000, deadline: false });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['beta-max', 'core-6']);
      });

      it('reads a node slow on small prompts as too slow for large ones, from the small measurement alone', async () => {
        usePeers(fzzyAndCore6);
        // `qwen3.6:27b` on fzzy and core-7: 27–37 tok/s. Prefill only gets slower as the prompt grows.
        throughput.recordPrefill(FZZY, { promptTokens: 5_000, ms: (5_000 / 30) * 1000, deadline: false });

        expect(ids(await service.buildCandidateList(MODEL, SMALL_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
      });

      it('puts a node nothing has measured behind one as busy measured to meet the budget, and ahead of one measured to miss it', async () => {
        usePeers(() => [
          node('fzzy', { hardwareTier: 'cpu-only' }),
          node('core-7', { inFlightRequests: 1 }),
          node('core-6', { inFlightRequests: 1 }),
        ]);
        recordFzzyOnTheFleet();
        throughput.recordPrefill(CORE_6, { promptTokens: 48_000, ms: (48_000 / 496) * 1000, deadline: false });

        // core-7 has no measurement, so it is not known to be fast; fzzy is known to be too slow.
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'core-7', 'fzzy']);
      });

      it('keeps the ranked order among nodes measured to meet the budget while none is three times as fast', async () => {
        usePeers(() => [node('core-7', { inFlightRequests: 1 }), node('core-6', { inFlightRequests: 2 })]);
        // ~264.5 s against ~92.7 s: 2.85 times as long, just under SLOWER_PLACEMENT_RATIO.
        throughput.recordPrefill({ ...CORE_6, nodeKey: 'core-7' }, { promptTokens: 40_000, ms: (40_000 / 200) * 1000, deadline: false });
        throughput.recordPrefill(CORE_6, { promptTokens: 48_000, ms: (48_000 / 496) * 1000, deadline: false });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', 'core-6']);
      });

      /**
       * Fleet, 2026-09-29, core-2 entering: a 7,731-token opencode turn, eight candidates, went to core-7
       * — nothing had timed it there, it advertised `high`, and its Ollama read the prompt on CPU — and
       * waited 169.8 s for a first byte, while the GPU peers beside it, idle and measured, were predicted
       * at ~32–36 s. An unmeasured node was being taken for a fast one.
       */
      describe('a node nothing has measured', () => {
        const OPENCODE_TURN_BYTES = 30_924; // ~7,731 estimated tokens
        const CORE_7 = { ...CORE_6, nodeKey: 'core-7' };
        /** ~230 tok/s at 7k: the ~34 s the measured GPU peers were predicted at for that turn. */
        function measureCore6AtTheFleetRate(): void {
          throughput.recordPrefill(CORE_6, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });
        }

        it('gives way to a node measured to meet the budget on the turn that waited 169.8 s', async () => {
          usePeers(() => [node('core-7'), node('core-6')]);
          measureCore6AtTheFleetRate();

          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-6', 'core-7']);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'core-7']);
        });

        it('still gets the small prompts, which is how it gets measured, and is then judged on what was timed', async () => {
          usePeers(() => [node('core-7'), node('core-6')]);
          measureCore6AtTheFleetRate();

          expect(ids(await service.buildCandidateList(MODEL, SMALL_PROMPT_BYTES))).toEqual(['core-7', 'core-6']);
          expect(ids(await service.buildCandidateList(MODEL, UNMEASURED_DEFER_MIN_PROMPT_TOKENS * 4 - 4))).toEqual(['core-7', 'core-6']);
          expect(ids(await service.buildCandidateList(MODEL, UNMEASURED_DEFER_MIN_PROMPT_TOKENS * 4))).toEqual(['core-6', 'core-7']);

          // Explored at ~5k tokens and found as fast as core-6: the long prompt goes back to the ranker.
          throughput.recordPrefill(CORE_7, { promptTokens: 5_000, ms: (5_000 / 250) * 1000, deadline: false });
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-7', 'core-6']);
        });

        it('stays where the ranker put it in a pool nothing has been measured on, a node advertising no GPU included', async () => {
          usePeers(() => [
            node('beta-ms-a2', { hardwareTier: 'cpu-only' }),
            node('core-7', { inFlightRequests: 1 }),
            node('core-6', { inFlightRequests: 2 }),
          ]);

          const ranked = ids(await service.buildCandidateList(MODEL));
          expect(ranked).toEqual(['beta-ms-a2', 'core-7', 'core-6']);
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(ranked);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(ranked);
        });

        it('stays where the ranker put it when every measured node is predicted to miss', async () => {
          usePeers(() => [
            node('fzzy', { hardwareTier: 'cpu-only' }),
            node('core-7', { inFlightRequests: 1 }),
            node('core-6', { inFlightRequests: 2 }),
          ]);
          recordFzzyOnTheFleet();

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', 'core-6', 'fzzy']);
        });

        it('goes last among the unmeasured for a large prompt when it advertises no GPU, and is still explored with a small one', async () => {
          usePeers(() => [
            node('beta-ms-a2', { hardwareTier: 'cpu-only', inFlightRequests: 1 }),
            node('fzzy', { hardwareTier: 'cpu-only' }),
            node('core-7', { inFlightRequests: 1 }),
            node('core-6', { inFlightRequests: 1 }),
          ]);
          recordFzzyOnTheFleet();
          measureCore6AtTheFleetRate();

          // Measured-fast, then unmeasured, then unmeasured with no GPU, all equally busy; then measured too slow.
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'core-7', 'beta-ms-a2', 'fzzy']);

          // A hint orders the ones that give way; it does not stop a node being measured.
          usePeers(() => [
            node('beta-ms-a2', { hardwareTier: 'cpu-only' }),
            node('core-7', { inFlightRequests: 1 }),
            node('core-6', { inFlightRequests: 1 }),
          ]);
          expect(ids(await service.buildCandidateList(MODEL, SMALL_PROMPT_BYTES))).toEqual(['beta-ms-a2', 'core-7', 'core-6']);
        });

        it("leaves this node's own engine in place: its evidence is forgotten on a restart that its prefix cache survives", async () => {
          ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
          usePeers(() => [node('core-6', { inFlightRequests: 2 })]);
          measureCore6AtTheFleetRate();

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual([null, 'core-6']);
        });

        it('leaves a pinned node in front: the pin is a statement, and unmeasured is only a prior', async () => {
          usePeers(() => [node('core-7'), node('core-6')]);
          measureCore6AtTheFleetRate();
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-6', 'core-7']);

          setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-7', 'core-6']);
        });

        it('is not deferred behind a measured node whose slots are full, so a burst still spreads onto it', async () => {
          setPoolPreferences({ poolSlotAwareness: 1 });
          usePeers(() => [node('core-6', { inFlightRequests: 2, ollamaSlots: 2 }), node('core-7', { inFlightRequests: 3 })]);
          measureCore6AtTheFleetRate();

          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-7', 'core-6']);
        });

        it('gives way only to a measured node in its own ceiling group, since it can never be moved past that group', async () => {
          usePeers(() => [
            node('beta-ms-a2', { hardwareTier: 'cpu-only' }),
            node('core-7', { inFlightRequests: 1 }),
            node('core-6', { inFlightRequests: 1, maxPromptTokens: 16_000 }),
          ]);
          throughput.recordPrefill(CORE_6, { promptTokens: 48_000, ms: (48_000 / 496) * 1000, deadline: false });

          // core-6 is as busy as core-7 but behind it on its ceiling, so there is nothing measured for core-7 to give way to.
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['beta-ms-a2', 'core-7', 'core-6']);
        });

        /**
         * The ranker's first key is queue depth, and on this fleet's `-np 1` engines each request queued
         * ahead is a whole turn, ~300 s for a large one. A measured node with eight queued is not a
         * better bet than an idle one nothing has timed, and taking it for one piled every large turn
         * onto the few measured nodes while idle GPU peers waited.
         */
        it('is not held back by a measured node with a queue, so a burst of large turns still spreads by queue depth', async () => {
          const idle = Array.from({ length: 12 }, (_, index) => node(`gpu-${index}`));
          usePeers(() => [node('core-6', { inFlightRequests: 8 }), ...idle]);
          measureCore6AtTheFleetRate();

          const ranked = [...idle.map((peer) => peer.id), 'core-6'];
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(ranked);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(ranked);
        });

        it('gives way only to a measured node the ranker holds level with it, not to one with a request more', async () => {
          usePeers(() => [node('core-7'), node('core-6', { inFlightRequests: 1 })]);
          measureCore6AtTheFleetRate();
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-7', 'core-6']);

          usePeers(() => [node('core-7', { inFlightRequests: 1 }), node('core-6', { inFlightRequests: 1 })]);
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-6', 'core-7']);
        });

        it('stays ahead of a busier measured node in the failover order', async () => {
          usePeers(() => [node('core-7'), node('core-5', { inFlightRequests: 3 }), node('core-6')]);
          measureCore6AtTheFleetRate();
          throughput.recordPrefill({ ...CORE_6, nodeKey: 'core-5' }, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });

          // Behind core-6, which is as free as it; ahead of core-5, which has three queued.
          expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-6', 'core-7', 'core-5']);
        });

        describe("beside this node's own engine while it is generating another model", () => {
          const OTHER = 'qwen3.6:27b';
          const LOCAL = { ...CORE_6, nodeKey: LOCAL_CANDIDATE_KEY };

          /** This node's Ollama holds both models and is generating OTHER: one in flight here, level with an idle peer. */
          function generatingAnotherModelHere(): void {
            ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL, OTHER] });
            loadService.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: OTHER, numCtx: null });
          }

          /**
           * Contention moves that engine behind the peers no busier than it. A measurement of the same
           * engine must not undo that by holding those peers back first: it would keep a large turn
           * waiting on an engine that is busy with another model, while a peer sat idle.
           */
          it('does not give way to it, however fast it has been measured', async () => {
            generatingAnotherModelHere();
            usePeers(() => [node('core-2')]);
            expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-2', null]);

            throughput.recordPrefill(LOCAL, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });
            expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-2', null]);
          });

          it('lets it give way to an unmeasured peer that gave way to a measured one', async () => {
            generatingAnotherModelHere();
            usePeers(() => [node('core-2'), node('core-6')]);
            measureCore6AtTheFleetRate();
            throughput.recordPrefill(LOCAL, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });

            expect(ids(await service.buildCandidateList(MODEL, OPENCODE_TURN_BYTES))).toEqual(['core-6', 'core-2', null]);
          });
        });
      });

      /**
       * Fleet re-bank, 2026-09-30, core-2 entering with 15 leaves. Budget demotion only asks whether a
       * node answers in time, and core-7, reading on CPU, did: a 35,809-token OpenClaw turn went to it
       * at a predicted 162,910 ms while beta-1, beta-max and beta-red, as idle, were predicted at
       * 22–39 s; and a 14.5k-token Hermes turn, this node's engine moved aside for contention, went to
       * it at 54,854 ms predicted — 57 s to its first byte — while beta-1 was predicted at 8,959 ms.
       */
      describe('a node predicted much slower than another as free', () => {
        const OPENCLAW_TURN_TOKENS = 35_809;
        const HERMES_TURN_TOKENS = 14_500;
        const OTHER = 'qwen3.6:27b';
        const bytesOf = (tokens: number) => tokens * 4;

        /** Timed at exactly the turn's size, so the prediction for that turn is `ms` itself. */
        function measure(nodeKey: string, promptTokens: number, ms: number): void {
          throughput.recordPrefill({ ...CORE_6, nodeKey }, { promptTokens, ms, deadline: false });
        }

        function measureTheOpenClawTurn(): void {
          measure('core-7', OPENCLAW_TURN_TOKENS, 162_910);
          measure('beta-1', OPENCLAW_TURN_TOKENS, 22_080);
          measure('beta-max', OPENCLAW_TURN_TOKENS, 34_651);
          measure('beta-red', OPENCLAW_TURN_TOKENS, 38_973);
        }

        function measureTheHermesTurn(): void {
          measure('core-7', HERMES_TURN_TOKENS, 54_854);
          measure('beta-1', HERMES_TURN_TOKENS, 8_959);
        }

        /** This node's Ollama holds both models and is generating OTHER: one in flight here, level with an idle peer. */
        function generatingAnotherModelHere(): void {
          ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL, OTHER] });
          loadService.acquire(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: OTHER, numCtx: null });
        }

        it('puts the idle GPU nodes ahead of the idle CPU node on the OpenClaw turn of 2026-09-30', async () => {
          usePeers(() => [node('core-7'), node('beta-max'), node('beta-red'), node('beta-1')]);
          measureTheOpenClawTurn();

          // core-7 goes behind all three, which keep the ranker's order: beta-max's ~35 s is not three times beta-1's ~22 s.
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(OPENCLAW_TURN_TOKENS)))).toEqual(['beta-max', 'beta-red', 'beta-1', 'core-7']);
        });

        it("puts beta-1 ahead of core-7 on the Hermes turn this node's contended engine gave way on", async () => {
          generatingAnotherModelHere();
          usePeers(() => [node('core-7'), node('beta-1')]);
          measureTheHermesTurn();

          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['beta-1', 'core-7', null]);

          // The order contention alone left, with a ratio no prediction reaches turning the rule off.
          vi.stubEnv(HUB_POOL_SLOWER_PLACEMENT_RATIO_ENV_VAR, '1000');
          try {
            expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1', null]);
          } finally {
            vi.unstubAllEnvs();
          }
        });

        it('never brings a contended engine back to the front, however much faster it is predicted', async () => {
          generatingAnotherModelHere();
          usePeers(() => [node('core-7')]);
          measure('core-7', HERMES_TURN_TOKENS, 54_854);
          measure(LOCAL_CANDIDATE_KEY, HERMES_TURN_TOKENS, 8_959);

          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', null]);

          // With no head start core-7 ranks first on its own and the engine, with nothing after it to
          // give way to, stays beside it with one request more: this rule is all that could move it.
          setPoolPreferences({ poolLocalAffinity: 0 });
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', null]);
        });

        it('leaves the order alone while the first is under three times as slow', async () => {
          usePeers(() => [node('core-7'), node('beta-1')]);
          // 2.5 times as long, 30 s more: a GPU node slower than another, not a CPU read.
          measure('core-7', HERMES_TURN_TOKENS, 50_000);
          measure('beta-1', HERMES_TURN_TOKENS, 20_000);

          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1']);
        });

        it('leaves the order alone when the first is many times slower by under SLOWER_PLACEMENT_FLOOR_MS, until the floor is lowered', async () => {
          usePeers(() => [node('core-7'), node('beta-1')]);
          // Seven times as long, but 15.5 s: less than the move is worth against a prefix the ranker's choice may hold.
          measure('core-7', HERMES_TURN_TOKENS, 18_000);
          measure('beta-1', HERMES_TURN_TOKENS, 2_500);
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1']);

          vi.stubEnv(HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS_ENV_VAR, '10000');
          try {
            expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['beta-1', 'core-7']);
          } finally {
            vi.unstubAllEnvs();
          }
        });

        it.each([
          ['a word', 'three'],
          ['below 1', '0.5'],
          ['blank', ' '],
        ])('reads a ratio that is %s, and a negative floor, as the defaults rather than a guess', async (_label, raw) => {
          usePeers(() => [node('core-7'), node('beta-1')]);
          measureTheHermesTurn();
          vi.stubEnv(HUB_POOL_SLOWER_PLACEMENT_RATIO_ENV_VAR, raw);
          vi.stubEnv(HUB_POOL_SLOWER_PLACEMENT_FLOOR_MS_ENV_VAR, '-1');
          try {
            expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['beta-1', 'core-7']);
          } finally {
            vi.unstubAllEnvs();
          }
        });

        it('does not send the turn to a faster node with more than one request more in flight', async () => {
          usePeers(() => [node('core-7'), node('beta-1', { inFlightRequests: 2 })]);
          measureTheHermesTurn();
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1']);

          // One more is a request it may be nearly done with, and all the ranker's order rested on.
          usePeers(() => [node('core-7'), node('beta-1', { inFlightRequests: 1 })]);
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['beta-1', 'core-7']);
        });

        it('does not bring forward a faster node whose slots are full', async () => {
          setPoolPreferences({ poolSlotAwareness: 1 });
          usePeers(() => [node('core-7'), node('beta-1', { inFlightRequests: 1, ollamaSlots: 1 })]);
          measureTheHermesTurn();

          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1']);
        });

        it('leaves a pinned node in front: a pin is a statement, and a prediction an inference', async () => {
          usePeers(() => [node('core-7'), node('beta-1')]);
          measureTheHermesTurn();
          setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });

          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-7', 'beta-1']);
        });

        it('leaves prompts under UNMEASURED_DEFER_MIN_PROMPT_TOKENS alone, where a node measured slow gets measured again', async () => {
          usePeers(() => [node('core-7'), node('beta-1')]);
          // 30 against 230 tok/s at ~5k tokens: over seven times as slow, and over 140 s longer, at every size below.
          throughput.recordPrefill({ ...CORE_6, nodeKey: 'core-7' }, { promptTokens: 5_000, ms: (5_000 / 30) * 1000, deadline: false });
          throughput.recordPrefill({ ...CORE_6, nodeKey: 'beta-1' }, { promptTokens: 5_000, ms: (5_000 / 230) * 1000, deadline: false });

          expect(ids(await service.buildCandidateList(MODEL, SMALL_PROMPT_BYTES))).toEqual(['core-7', 'beta-1']);
          expect(ids(await service.buildCandidateList(MODEL, UNMEASURED_DEFER_MIN_PROMPT_TOKENS * 4 - 4))).toEqual(['core-7', 'beta-1']);
          expect(ids(await service.buildCandidateList(MODEL, UNMEASURED_DEFER_MIN_PROMPT_TOKENS * 4))).toEqual(['beta-1', 'core-7']);
        });

        it('judges no node nothing has measured: an idler unmeasured one keeps the front, and the rule does not reach past it', async () => {
          usePeers(() => [node('core-5'), node('core-7', { inFlightRequests: 1 }), node('beta-1', { inFlightRequests: 1 })]);
          measureTheHermesTurn();

          // No measured node is as free as core-5, so it is not deferred; and it has no prediction to compare.
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['core-5', 'core-7', 'beta-1']);
        });

        it('leaves an unmeasured peer where its deferral put it, behind both measured nodes', async () => {
          usePeers(() => [node('core-7'), node('core-5'), node('beta-1')]);
          measureTheHermesTurn();

          // core-5 gives way to the measured nodes as free as it; then core-7 goes behind beta-1, and core-5 stays last.
          expect(ids(await service.buildCandidateList(MODEL, bytesOf(HERMES_TURN_TOKENS)))).toEqual(['beta-1', 'core-7', 'core-5']);
        });

        it('leaves the engine prefix affinity holds in front, where the session prefix is warm', async () => {
          setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
          usePeers(() => [node('core-7'), node('beta-1')]);
          peerService.getPresentToken.mockResolvedValue('raw-token');
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
          const head = [
            { role: 'system', content: 'You are a coding agent.' },
            { role: 'user', content: 'read the repo' },
          ];

          // A short first turn: placed by the ranker on core-7, and too short to measure it.
          await service.proxyRequest({
            path: '/v1/chat/completions',
            method: 'POST',
            body: { model: MODEL, stream: true, messages: head },
            model: MODEL,
            res: createMockResponse(),
          });
          expect(routingLog.list()[0]).toMatchObject({ node: 'core-7.tailxyz.ts.net' });
          // 45 against 230 tok/s at 7k tokens: ~190 s against ~37 s for the grown turn.
          throughput.recordPrefill({ ...CORE_6, nodeKey: 'core-7' }, { promptTokens: 7_000, ms: (7_000 / 45) * 1000, deadline: false });
          throughput.recordPrefill({ ...CORE_6, nodeKey: 'beta-1' }, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });

          const grown = {
            model: MODEL,
            stream: true,
            messages: [...head, { role: 'assistant', content: 'done' }, { role: 'user', content: 'x'.repeat(30_700) }],
          };
          await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: grown, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'core-7.tailxyz.ts.net', affinity: expect.objectContaining({ outcome: 'hit', qualified: true }) });
          expect(entry?.throughput?.estimatedTokens).toBeGreaterThanOrEqual(UNMEASURED_DEFER_MIN_PROMPT_TOKENS);
          expect(entry?.throughput?.slowerDemoted).toEqual([]);
          // The same turn with no session to hold goes to beta-1.
          expect(ids(await service.buildCandidateList(MODEL, JSON.stringify(grown).length))).toEqual(['beta-1', 'core-7']);
        });

        it('names both nodes and both predictions in the routing log, and serves the turn from the faster', async () => {
          usePeers(() => [node('core-7'), node('beta-max'), node('beta-red'), node('beta-1')]);
          measureTheOpenClawTurn();
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({
            path: '/v1/chat/completions',
            method: 'POST',
            body: turn(bytesOf(OPENCLAW_TURN_TOKENS) - 400),
            model: MODEL,
            res: createMockResponse(),
          });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'beta-max.tailxyz.ts.net', candidates: 4, attempt: 1, outcome: 'served', failedOverFrom: [] });
          const predictedFor = (id: string) => entry?.throughput?.estimates.find((estimate) => estimate.node === `${id}.tailxyz.ts.net`)?.predictedMs;
          expect(predictedFor('core-7')).toBeGreaterThan(160_000);
          expect(predictedFor('beta-max')).toBeLessThan(36_000);
          expect(entry?.throughput?.slowerDemoted).toEqual([
            {
              node: 'core-7.tailxyz.ts.net',
              backend: 'ollama',
              predictedMs: predictedFor('core-7'),
              inFlight: 0,
              fasterNode: 'beta-max.tailxyz.ts.net',
              fasterBackend: 'ollama',
              fasterMs: predictedFor('beta-max'),
              fasterInFlight: 0,
            },
          ]);
          expect(entry?.throughput?.overridden).toBe(false);
        });
      });

      it('keeps the ranked order when every candidate is predicted to miss its budget', async () => {
        usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only' }), node('core-7', { inFlightRequests: 1 })]);
        recordFzzyOnTheFleet();
        throughput.recordPrefill({ ...FZZY, nodeKey: 'core-7' }, { promptTokens: 40_000, ms: (40_000 / 30) * 1000, deadline: false });

        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-7']);
      });

      it("judges this node's own engine by what it timed serving locally", async () => {
        ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        usePeers(() => [node('core-6', { inFlightRequests: 2 })]);
        throughput.recordPrefill({ ...FZZY, nodeKey: LOCAL_CANDIDATE_KEY }, { promptTokens: 46_000, ms: 922_000, deadline: true });

        expect(ids(await service.buildCandidateList(MODEL, MEDIUM_PROMPT_BYTES))).toEqual([null, 'core-6']);
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', null]);
      });

      it('judges nothing when there is no body to measure', async () => {
        usePeers(fzzyAndCore6);
        recordFzzyOnTheFleet();

        expect(ids(await service.buildCandidateList(MODEL))).toEqual(['fzzy', 'core-6']);
      });

      it('keeps measuring but stops reordering under HUB_POOL_THROUGHPUT_PLACEMENT=off', async () => {
        usePeers(fzzyAndCore6);
        recordFzzyOnTheFleet();
        vi.stubEnv('HUB_POOL_THROUGHPUT_PLACEMENT', 'off');
        try {
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        } finally {
          vi.unstubAllEnvs();
        }
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
      });

      describe('advertised throughput', () => {
        const advertisedDeadline = [
          {
            model: MODEL,
            backend: 'ollama',
            prefill: [{ fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 49.8, deadline: true, ageMs: 60_000 }],
            decode: null,
          },
        ];
        const advertisedFast = [
          {
            model: MODEL,
            backend: 'ollama',
            prefill: [{ fromTokens: 32_768, promptTokens: 46_000, tokensPerSec: 496, deadline: false, ageMs: 0 }],
            decode: null,
          },
        ];

        it('demotes a peer on its own report, which is how an entry node that never sent it a long prompt learns', async () => {
          usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only', throughput: advertisedDeadline }), node('core-6', { inFlightRequests: 2 })]);

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        });

        it('believes what it timed over a faster advert, so a peer cannot talk its way out of a missed deadline', async () => {
          usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only', throughput: advertisedFast }), node('core-6', { inFlightRequests: 2 })]);
          recordFzzyOnTheFleet();

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        });

        it('matches the advert to the engine and model being ranked', async () => {
          const otherModel = [{ ...advertisedDeadline[0], model: 'qwen3.6:27b' }];
          const otherEngine = [{ ...advertisedDeadline[0], backend: 'vllm' }];
          usePeers(() => [
            node('fzzy', { hardwareTier: 'cpu-only', throughput: [...otherModel, ...otherEngine] }),
            node('core-6', { inFlightRequests: 2 }),
          ]);

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        });

        it.each([
          ['not an array', { model: MODEL }],
          ['a string rate', [{ ...advertisedDeadline[0], prefill: [{ ...advertisedDeadline[0]?.prefill[0], tokensPerSec: '49.8' }] }]],
          ['a negative age', [{ ...advertisedDeadline[0], prefill: [{ ...advertisedDeadline[0]?.prefill[0], ageMs: -5 }] }]],
          ['an unknown backend', [{ ...advertisedDeadline[0], backend: 'something-else' }]],
        ])('lets a malformed advert (%s) demote nothing', async (_label, hostile) => {
          usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only', throughput: hostile }), node('core-6', { inFlightRequests: 2 })]);

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        });

        it('ages an advert by how old the snapshot carrying it is', async () => {
          const staleSnapshot = new Date(Date.now() - THROUGHPUT_FORGET_AFTER_MS).toISOString();
          usePeers(() => [
            { ...node('fzzy', { hardwareTier: 'cpu-only', throughput: advertisedDeadline }), lastSeenAt: staleSnapshot },
            node('core-6', { inFlightRequests: 2 }),
          ]);

          // The evidence outlived its forget time on our clock, so fzzy is unmeasured again. (The stale
          // snapshot also makes fzzy's load unknown, which is why it still ranks behind core-6 here.)
          const list = await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES);
          const ranked = await service.buildCandidateList(MODEL);
          expect(ids(list)).toEqual(ids(ranked));
        });
      });

      describe('decay', () => {
        it('forgets evidence after THROUGHPUT_FORGET_AFTER_MS, so a node that was too slow is tried again', async () => {
          usePeers(fzzyAndCore6);
          recordFzzyOnTheFleet(Date.now() - THROUGHPUT_FORGET_AFTER_MS);

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        });

        it('still demotes on evidence just short of its forget time', async () => {
          usePeers(fzzyAndCore6);
          recordFzzyOnTheFleet(Date.now() - THROUGHPUT_FORGET_AFTER_MS + 60_000);

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        });

        it('holds a fresh missed deadline against fast cache-hit turns, and lets an old one give way to them', async () => {
          usePeers(fzzyAndCore6);
          const fastTurn = { promptTokens: 46_500, ms: 20_000, deadline: false };

          recordFzzyOnTheFleet(Date.now() - 60_000);
          for (let index = 0; index < 5; index += 1) throughput.recordPrefill(FZZY, fastTurn);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);

          throughput = new HubPoolThroughputService();
          service = buildService();
          // Past its hold by two half-lives: a quarter of its weight left, and the fast turn carries the rest.
          recordFzzyOnTheFleet(Date.now() - THROUGHPUT_HOLD_MS - 2 * THROUGHPUT_HALF_LIFE_MS);
          throughput.recordPrefill(FZZY, fastTurn);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        });
      });

      describe('with a pin', () => {
        it('does not let a pin at a node measured too slow put a long prompt back at the front', async () => {
          usePeers(fzzyAndCore6);
          recordFzzyOnTheFleet();
          setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'peer', peerId: 'fzzy', mode: 'prefer' }] });

          expect(ids(await service.buildCandidateList(MODEL, MEDIUM_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy']);
        });

        it('still reorders the candidates expected to meet the budget', async () => {
          ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
          usePeers(() => [...fzzyAndCore6(), node('core-7', { inFlightRequests: 5 })]);
          recordFzzyOnTheFleet();
          setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', null, 'core-6', 'fzzy']);
        });

        it('applies to the whole list when every candidate is predicted to miss', async () => {
          usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only' }), node('core-7', { inFlightRequests: 3 })]);
          recordFzzyOnTheFleet();
          throughput.recordPrefill({ ...FZZY, nodeKey: 'core-7' }, { promptTokens: 46_000, ms: 922_000, deadline: true });
          setPoolPreferences({ poolPins: [{ scope: 'default', targetKind: 'peer', peerId: 'core-7', mode: 'prefer' }] });

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-7', 'fzzy']);
        });
      });

      describe('with prompt ceilings', () => {
        it('demotes within each ceiling group, never across them', async () => {
          usePeers(() => [
            node('fzzy', { hardwareTier: 'cpu-only' }),
            node('core-6', { inFlightRequests: 2 }),
            node('core-7', { maxPromptTokens: 16_000, inFlightRequests: 3 }),
            node('core-8', { maxPromptTokens: 16_000, inFlightRequests: 4 }),
          ]);
          recordFzzyOnTheFleet();
          throughput.recordPrefill({ ...FZZY, nodeKey: 'core-7' }, { promptTokens: 46_000, ms: 922_000, deadline: true });

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['core-6', 'fzzy', 'core-8', 'core-7']);
        });

        it("keeps the ceiling as the outer order: it is an operator's statement, and a measurement is an inference", async () => {
          usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only' }), node('core-6', { inFlightRequests: 2, maxPromptTokens: 16_000 })]);
          recordFzzyOnTheFleet();

          expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
        });
      });
    });

    describe('in the routing log', () => {
      function answerWith200(): void {
        vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
      }

      it('records the estimate, the budget and the node it moved, so a skip reads as a measurement and not the ranker', async () => {
        usePeers(fzzyAndCore6);
        recordFzzyOnTheFleet();
        answerWith200();

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });

        const sent = String(vi.mocked(global.fetch).mock.calls[0]?.[1]?.body);
        const estimatedTokens = Math.ceil(sent.length / 4);
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-6.tailxyz.ts.net', candidates: 2, attempt: 1, outcome: 'served', failedOverFrom: [] });
        expect(entry?.throughput).toEqual({
          estimatedTokens,
          budgetMs: firstByteBudgetMs(sent.length),
          estimates: [
            {
              node: 'fzzy.tailxyz.ts.net',
              backend: 'ollama',
              tokensPerSec: 49.8,
              fromPromptTokens: 46_000,
              // A hair past the measured size, so the growth factor barely applies.
              extrapolated: true,
              predictedMs: Math.round(estimatedTokens * (922_000 / 46_000) * (estimatedTokens / 46_000)),
              source: 'observed',
              deadline: true,
              slow: true,
            },
          ],
          // core-6 is unmeasured, but nothing is measured to meet the budget, so it kept its place.
          unmeasured: [],
          slowerDemoted: [],
          overridden: false,
        });
      });

      it('names the unmeasured node a large prompt went past, and the prior it was judged on', async () => {
        usePeers(() => [node('beta-ms-a2', { hardwareTier: 'cpu-only' }), node('core-7'), node('core-6')]);
        throughput.recordPrefill(CORE_6, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });
        answerWith200();

        // The opencode turn from the fleet, 2026-09-29: ~7.7k tokens.
        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn(30_700), model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-6.tailxyz.ts.net', candidates: 3, attempt: 1, outcome: 'served', failedOverFrom: [] });
        expect(entry?.throughput?.estimatedTokens).toBeGreaterThanOrEqual(UNMEASURED_DEFER_MIN_PROMPT_TOKENS);
        expect(entry?.throughput?.estimates).toEqual([expect.objectContaining({ node: 'core-6.tailxyz.ts.net', slow: false })]);
        expect(entry?.throughput?.unmeasured).toEqual([
          { node: 'core-7.tailxyz.ts.net', backend: 'ollama', prior: 'unknown' },
          { node: 'beta-ms-a2.tailxyz.ts.net', backend: 'ollama', prior: 'cpu-only' },
        ]);
        expect(entry?.throughput?.overridden).toBe(false);
      });

      it('lists no unmeasured node for a prompt small enough to explore one with', async () => {
        usePeers(() => [node('core-7'), node('core-6')]);
        throughput.recordPrefill(CORE_6, { promptTokens: 4_500, ms: (4_500 / 230) * 1000, deadline: false });
        answerWith200();

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn(18_000), model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-7.tailxyz.ts.net', attempt: 1 });
        expect(entry?.throughput).toMatchObject({ estimates: [expect.objectContaining({ node: 'core-6.tailxyz.ts.net' })], unmeasured: [] });
      });

      it('still fails over to an unmeasured node when the measured one fails', async () => {
        usePeers(() => [node('core-7'), node('core-6')]);
        throughput.recordPrefill(CORE_6, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });
        vi.mocked(global.fetch).mockImplementation(async (url) =>
          String(url).includes('core-6') ? new Response('model not loaded', { status: 503 }) : new Response('data: [DONE]\n\n', { status: 200 }),
        );

        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: turn(30_700), model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-7.tailxyz.ts.net', outcome: 'served', status: 200, failedOverFrom: ['core-6.tailxyz.ts.net'] });
        expect(entry?.throughput?.unmeasured).toEqual([{ node: 'core-7.tailxyz.ts.net', backend: 'ollama', prior: 'unknown' }]);
      });

      it('leaves the engine prefix affinity holds in place, where the session prefix is warm', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        usePeers(() => [node('core-7'), node('core-6')]);
        peerService.getPresentToken.mockResolvedValue('raw-token');
        answerWith200();
        const head = [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'user', content: 'read the repo' },
        ];

        // A short first turn: placed by the ranker on core-7, and too short to measure it.
        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: MODEL, stream: true, messages: head },
          model: MODEL,
          res: createMockResponse(),
        });
        expect(routingLog.list()[0]).toMatchObject({ node: 'core-7.tailxyz.ts.net' });
        throughput.recordPrefill(CORE_6, { promptTokens: 7_000, ms: (7_000 / 230) * 1000, deadline: false });

        const grown = {
          model: MODEL,
          stream: true,
          messages: [...head, { role: 'assistant', content: 'done' }, { role: 'user', content: 'x'.repeat(30_700) }],
        };
        await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: grown, model: MODEL, res: createMockResponse() });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-7.tailxyz.ts.net', affinity: expect.objectContaining({ outcome: 'hit', qualified: true }) });
        expect(entry?.throughput?.unmeasured).toEqual([]);
      });

      it('still fails over to the slow node when every faster one fails, and says it was placed there anyway', async () => {
        usePeers(fzzyAndCore6);
        recordFzzyOnTheFleet();
        vi.mocked(global.fetch).mockImplementation(async (url) =>
          String(url).includes('core-6') ? new Response('model not loaded', { status: 503 }) : new Response('data: [DONE]\n\n', { status: 200 }),
        );

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'fzzy.tailxyz.ts.net', outcome: 'served', status: 200, failedOverFrom: ['core-6.tailxyz.ts.net'] });
        expect(entry?.throughput).toMatchObject({ overridden: true });
      });

      it('marks the decision overridden when every candidate is predicted to miss, and still serves it', async () => {
        usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only' })]);
        recordFzzyOnTheFleet();
        answerWith200();

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });

        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'fzzy.tailxyz.ts.net', outcome: 'served', status: 200 });
        expect(entry?.throughput).toMatchObject({ estimates: [{ node: 'fzzy.tailxyz.ts.net', slow: true }], overridden: true });
      });

      it('stays null where nothing applicable has been measured, and on embeddings', async () => {
        usePeers(fzzyAndCore6);
        answerWith200();

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });
        expect(routingLog.list()[0]?.throughput).toBeNull();

        recordFzzyOnTheFleet();
        const batch = { model: MODEL, input: Array.from({ length: 400 }, () => 'x'.repeat(LONG_PROMPT_BYTES / 400)) };
        await service.proxyRequest({ path: '/v1/embeddings', method: 'POST', body: batch, model: MODEL, res: createMockResponse() });
        expect(routingLog.list()[0]).toMatchObject({ node: 'fzzy.tailxyz.ts.net' });
        expect(routingLog.list()[0]?.throughput).toBeNull();
      });
    });

    describe('measuring', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('times a streamed turn to its first byte and places the next, longer prompt on that', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        usePeers(fzzyAndCore6);
        vi.mocked(global.fetch).mockImplementation(async (url) => {
          // fzzy takes 250 s to start answering ~10.6k tokens: ~42 tok/s, as `qwen3.6:27b` does on CPU.
          if (String(url).includes('fzzy')) vi.setSystemTime(Date.now() + 250_000);
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
        });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(MEDIUM_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });
        expect(routingLog.list()[0]).toMatchObject({ node: 'fzzy.tailxyz.ts.net', throughput: null });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-6.tailxyz.ts.net', attempt: 1 });
        expect(entry?.throughput?.estimates).toEqual([
          expect.objectContaining({ node: 'fzzy.tailxyz.ts.net', source: 'observed', deadline: false, slow: true }),
        ]);
        expect(entry?.throughput?.estimates[0]?.tokensPerSec).toBeCloseTo(42.5, 0);
      });

      it('records a missed deadline, and the next long prompt skips that node without waiting it out again', async () => {
        usePeers(fzzyAndCore6);
        vi.mocked(global.fetch).mockImplementation(async (url, init) => {
          if (String(url).includes('fzzy')) {
            const budget = firstByteBudgetMs(String(init?.body).length);
            throw new PoolForwardDeadlineError(`No response headers within ${budget}ms`, budget);
          }
          return new Response('data: [DONE]\n\n', { status: 200 });
        });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });
        expect(routingLog.list()[0]).toMatchObject({ node: 'core-6.tailxyz.ts.net', failedOverFrom: ['fzzy.tailxyz.ts.net'] });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: 'core-6.tailxyz.ts.net', attempt: 1, failedOverFrom: [] });
        expect(entry?.throughput?.estimates).toEqual([expect.objectContaining({ node: 'fzzy.tailxyz.ts.net', deadline: true, slow: true })]);
      });

      it('does not time a node that had other work in flight, so a queue is never recorded as slow hardware', async () => {
        usePeers(() => [node('fzzy', { hardwareTier: 'cpu-only', inFlightRequests: 1 }), node('core-6', { inFlightRequests: 2 })]);
        vi.mocked(global.fetch).mockImplementation(async (url, init) => {
          if (String(url).includes('fzzy')) {
            const budget = firstByteBudgetMs(String(init?.body).length);
            throw new PoolForwardDeadlineError(`No response headers within ${budget}ms`, budget);
          }
          return new Response('data: [DONE]\n\n', { status: 200 });
        });

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(LONG_PROMPT_BYTES),
          model: MODEL,
          res: createMockResponse(),
        });

        expect(throughput.prefillPoints(FZZY)).toEqual([]);
      });

      it("prefers the engine's own prefill time, which leaves out a cold model load", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        usePeers(fzzyAndCore6);
        const trailer = { done: true, prompt_eval_count: 10_600, prompt_eval_duration: 20_000_000_000, eval_count: 64, eval_duration: 4_000_000_000 };
        vi.mocked(global.fetch).mockImplementation(async (url) => {
          // 250 s to the first byte, but 230 s of it was loading weights: prefill itself took 20 s.
          if (String(url).includes('fzzy')) vi.setSystemTime(Date.now() + 250_000);
          return new Response(`{"done":false}\n${JSON.stringify(trailer)}\n`, { status: 200 });
        });

        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: turn(MEDIUM_PROMPT_BYTES), model: MODEL, res: createMockResponse() });

        const [estimate] = throughput.estimatesFor('fzzy');
        expect(estimate?.prefill).toEqual([expect.objectContaining({ fromTokens: 8_192, deadline: false })]);
        expect(estimate?.prefill[0]?.tokensPerSec).toBeGreaterThan(500);
        expect(estimate?.decode).toEqual(expect.objectContaining({ tokensPerSec: 16 }));
        expect(ids(await service.buildCandidateList(MODEL, LONG_PROMPT_BYTES))).toEqual(['fzzy', 'core-6']);
      });

      it('learns nothing about prefill from a non-streamed response that carries no engine timings', async () => {
        usePeers(fzzyAndCore6);
        vi.mocked(global.fetch).mockImplementation(
          async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 10_600 } }), { status: 200 }),
        );

        await service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: turn(MEDIUM_PROMPT_BYTES, { stream: false }),
          model: MODEL,
          res: createMockResponse(),
        });

        expect(throughput.prefillPoints(FZZY)).toEqual([]);
      });

      describe('work a peer forwarded here', () => {
        const LOCAL = { ...FZZY, nodeKey: LOCAL_CANDIDATE_KEY };

        it("records its missed deadline as this node's own, which is what this node then advertises", async () => {
          vi.mocked(global.fetch).mockImplementation(async (_url, init) => {
            const budget = firstByteBudgetMs(String(init?.body).length);
            throw new PoolForwardDeadlineError(`No response headers within ${budget}ms`, budget);
          });

          await expect(
            service.forwardToLocalBackendAndRespond(
              'ollama',
              '/v1/chat/completions',
              'POST',
              turn(LONG_PROMPT_BYTES),
              createMockResponse(),
              'entry.tailxyz.ts.net',
              MODEL,
            ),
          ).rejects.toBeInstanceOf(PoolForwardDeadlineError);

          expect(throughput.estimatesFor(LOCAL_CANDIDATE_KEY)).toEqual([
            expect.objectContaining({ model: MODEL, backend: 'ollama', prefill: [expect.objectContaining({ fromTokens: 32_768, deadline: true })] }),
          ]);
        });

        it("records the engine's timings from a served forward", async () => {
          const trailer = {
            done: true,
            prompt_eval_count: 46_000,
            prompt_eval_duration: 92_000_000_000,
            eval_count: 128,
            eval_duration: 8_000_000_000,
          };
          vi.mocked(global.fetch).mockImplementation(async () => new Response(`${JSON.stringify(trailer)}\n`, { status: 200 }));

          const res = createMockResponse();
          await service.forwardToLocalBackendAndRespond('ollama', '/api/chat', 'POST', turn(LONG_PROMPT_BYTES), res, 'entry.tailxyz.ts.net', MODEL);

          expect(Buffer.concat(res.chunks).toString()).toBe(`${JSON.stringify(trailer)}\n`);
          const [point] = throughput.prefillPoints(LOCAL);
          expect(point?.deadline).toBe(false);
          expect(1000 / (point?.msPerToken ?? 1)).toBeCloseTo(Math.ceil(String(vi.mocked(global.fetch).mock.calls[0]?.[1]?.body).length / 4) / 92, 1);
        });

        it('records nothing while this node is already busy, or when the peer did not say which model', async () => {
          vi.mocked(global.fetch).mockImplementation(async (_url, init) => {
            const budget = firstByteBudgetMs(String(init?.body).length);
            throw new PoolForwardDeadlineError(`No response headers within ${budget}ms`, budget);
          });
          const forward = (model?: string) =>
            service
              .forwardToLocalBackendAndRespond(
                'ollama',
                '/api/chat',
                'POST',
                turn(LONG_PROMPT_BYTES),
                createMockResponse(),
                'entry.tailxyz.ts.net',
                model,
              )
              .catch(() => undefined);

          loadService.acquire(LOCAL_CANDIDATE_KEY);
          await forward(MODEL);
          loadService.release(LOCAL_CANDIDATE_KEY);
          await forward(undefined);

          expect(throughput.estimatesFor(LOCAL_CANDIDATE_KEY)).toEqual([]);
        });
      });
    });

    describe('applyThroughputPlacement', () => {
      const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
      const fzzy = { peerId: 'fzzy', nodeFqdn: 'fzzy.tailxyz.ts.net', backend: 'ollama' } as const;
      const core6 = { peerId: 'core-6', nodeFqdn: 'core-6.tailxyz.ts.net', backend: 'ollama' } as const;
      const slow: PrefillPrediction = {
        predictedMs: 1_000_000,
        tokensPerSec: 46,
        fromPromptTokens: 46_000,
        extrapolated: false,
        deadline: false,
        source: 'observed',
      };
      const fast: PrefillPrediction = {
        predictedMs: 93_000,
        tokensPerSec: 496,
        fromPromptTokens: 46_000,
        extrapolated: false,
        deadline: false,
        source: 'advertised',
      };
      /** Every candidate scored the same by the ranker. */
      const LEVEL = () => 0;

      it('returns no decision, and demotes nothing, when no candidate has a measurement', () => {
        expect(applyThroughputPlacement([fzzy, core6], () => null, 46_000, 920_000)).toEqual({
          demoted: new Set(),
          deferred: new Map(),
          measured: new Map(),
          decision: null,
        });
      });

      it('names every measured candidate and demotes only the ones predicted to miss', () => {
        const result = applyThroughputPlacement(
          [fzzy, local, core6],
          (candidate) => (candidate === fzzy ? slow : candidate === core6 ? fast : null),
          46_000,
          920_000,
        );

        expect([...result.demoted]).toEqual([fzzy]);
        expect(result.decision).toEqual({
          estimatedTokens: 46_000,
          budgetMs: 920_000,
          estimates: [
            {
              node: 'fzzy.tailxyz.ts.net',
              backend: 'ollama',
              tokensPerSec: 46,
              fromPromptTokens: 46_000,
              extrapolated: false,
              predictedMs: 1_000_000,
              source: 'observed',
              deadline: false,
              slow: true,
            },
            {
              node: 'core-6.tailxyz.ts.net',
              backend: 'ollama',
              tokensPerSec: 496,
              fromPromptTokens: 46_000,
              extrapolated: false,
              predictedMs: 93_000,
              source: 'advertised',
              deadline: false,
              slow: false,
            },
          ],
          unmeasured: [],
          // Filled in by the caller, once contention and pins have fixed which candidate goes first.
          slowerDemoted: [],
          overridden: false,
        });
        expect([...result.measured]).toEqual([
          [fzzy, { prediction: slow, slow: true }],
          [core6, { prediction: fast, slow: false }],
        ]);
        expect(splitDemoted([fzzy, local, core6], result.demoted)).toEqual([[local, core6], [fzzy]]);
        expect(splitByThroughput([fzzy, local, core6], result, LEVEL)).toEqual([[local, core6], [fzzy]]);
      });

      it('demotes nothing, and says it was overridden, when every candidate is predicted to miss', () => {
        const result = applyThroughputPlacement([fzzy, local], () => slow, 46_000, 920_000);

        expect(result.demoted.size).toBe(0);
        expect(result.decision?.overridden).toBe(true);
        expect(splitDemoted([fzzy, local], result.demoted)).toEqual([[fzzy, local]]);
        expect(splitByThroughput([fzzy, local], result, LEVEL)).toEqual([[fzzy, local]]);
      });

      describe('candidates nothing has measured', () => {
        const core7 = { peerId: 'core-7', nodeFqdn: 'core-7.tailxyz.ts.net', backend: 'ollama' } as const;
        const core5 = { peerId: 'core-5', nodeFqdn: 'core-5.tailxyz.ts.net', backend: 'ollama' } as const;
        const betaMsA2 = { peerId: 'beta-ms-a2', nodeFqdn: 'beta-ms-a2.tailxyz.ts.net', backend: 'ollama' } as const;
        const LARGE = UNMEASURED_DEFER_MIN_PROMPT_TOKENS;
        const BUDGET = 300_000;
        /**
         * Priors for the named candidates; any other candidate keeps its place unmeasured. Every candidate
         * is in one group, scored the same by the ranker, and left in place by contention, unless `layout`
         * says otherwise.
         */
        function priors(
          entries: [PoolCandidate, UnmeasuredPrior][],
          layout: { groups?: [PoolCandidate, number][]; scores?: [PoolCandidate, number][]; contended?: PoolCandidate[] } = {},
        ): UnmeasuredPlacement {
          const prior = new Map(entries);
          const group = new Map(layout.groups ?? []);
          const score = new Map(layout.scores ?? []);
          const contended = new Set(layout.contended ?? []);
          return {
            priorOf: (candidate) => prior.get(candidate) ?? null,
            groupOf: (candidate) => group.get(candidate) ?? 0,
            scoreOf: (candidate) => score.get(candidate) ?? 0,
            staysInPlace: (candidate) => !contended.has(candidate),
          };
        }
        const measured = (predictions: [PoolCandidate, PrefillPrediction][]) => {
          const map = new Map<PoolCandidate, PrefillPrediction>(predictions);
          return (candidate: PoolCandidate) => map.get(candidate) ?? null;
        };

        it('defers one behind a candidate measured to meet the budget from UNMEASURED_DEFER_MIN_PROMPT_TOKENS up, and names it', () => {
          const unmeasured = priors([[core7, 'unknown']]);
          const large = applyThroughputPlacement([core7, core6], measured([[core6, fast]]), LARGE, BUDGET, unmeasured);

          expect([...large.deferred]).toEqual([[core7, 'unknown']]);
          expect(large.decision?.unmeasured).toEqual([{ node: 'core-7.tailxyz.ts.net', backend: 'ollama', prior: 'unknown' }]);
          // One part: contention, applied within it, can still move a contended engine behind both.
          expect(splitByThroughput([core7, core6], large, LEVEL)).toEqual([[core6, core7]]);

          const small = applyThroughputPlacement([core7, core6], measured([[core6, fast]]), LARGE - 1, BUDGET, unmeasured);
          expect(small.deferred.size).toBe(0);
          expect(small.decision?.unmeasured).toEqual([]);
          expect(splitByThroughput([core7, core6], small, LEVEL)).toEqual([[core7, core6]]);
        });

        it('orders the measured-fast first, then an unknown prior, then cpu-only, then the ones predicted to miss', () => {
          const ordered = [betaMsA2, fzzy, core7, local, core6];
          const result = applyThroughputPlacement(
            ordered,
            measured([
              [fzzy, slow],
              [core6, fast],
            ]),
            46_000,
            920_000,
            priors([
              [betaMsA2, 'cpu-only'],
              [core7, 'unknown'],
            ]),
          );

          // `local` has no prior: it keeps its place beside the measured-fast candidate, and is not listed.
          expect(splitByThroughput(ordered, result, LEVEL)).toEqual([[local, core6, core7, betaMsA2], [fzzy]]);
          expect(result.decision?.unmeasured).toEqual([
            { node: 'beta-ms-a2.tailxyz.ts.net', backend: 'ollama', prior: 'cpu-only' },
            { node: 'core-7.tailxyz.ts.net', backend: 'ollama', prior: 'unknown' },
          ]);
        });

        it('defers nothing when no candidate is measured to meet the budget', () => {
          const ordered = [core7, fzzy, betaMsA2];
          const result = applyThroughputPlacement(
            ordered,
            measured([[fzzy, slow]]),
            46_000,
            920_000,
            priors([
              [betaMsA2, 'cpu-only'],
              [core7, 'unknown'],
            ]),
          );

          expect(result.deferred.size).toBe(0);
          expect(result.decision?.unmeasured).toEqual([]);
          expect(splitByThroughput(ordered, result, LEVEL)).toEqual([[core7, betaMsA2], [fzzy]]);
        });

        it('defers only where a candidate measured to meet the budget is ranked in the same group', () => {
          const ordered = [betaMsA2, core7, core6];
          const unmeasured: [PoolCandidate, UnmeasuredPrior][] = [
            [betaMsA2, 'cpu-only'],
            [core7, 'unknown'],
          ];
          const elsewhere = applyThroughputPlacement(
            ordered,
            measured([[core6, fast]]),
            46_000,
            920_000,
            priors(unmeasured, { groups: [[core6, 1]] }),
          );
          expect(elsewhere.deferred.size).toBe(0);
          expect(elsewhere.decision?.unmeasured).toEqual([]);

          const beside = applyThroughputPlacement(
            ordered,
            measured([[core6, fast]]),
            46_000,
            920_000,
            priors(unmeasured, {
              groups: [
                [core6, 1],
                [core7, 1],
              ],
            }),
          );
          expect([...beside.deferred]).toEqual([[core7, 'unknown']]);
        });

        it('defers only behind a candidate the ranker scored the same, never a busier one', () => {
          const ordered = [core7, core6];
          const busier = priors([[core7, 'unknown']], { scores: [[core6, 8]] });
          const queued = applyThroughputPlacement(ordered, measured([[core6, fast]]), LARGE, BUDGET, busier);
          expect(queued.deferred.size).toBe(0);
          expect(queued.decision?.unmeasured).toEqual([]);
          expect(splitByThroughput(ordered, queued, busier.scoreOf)).toEqual([[core7, core6]]);

          const level = applyThroughputPlacement(ordered, measured([[core6, fast]]), LARGE, BUDGET, priors([[core7, 'unknown']]));
          expect([...level.deferred]).toEqual([[core7, 'unknown']]);
        });

        it('places one just behind the last candidate scored the same, and ahead of every busier one', () => {
          const ordered = [core7, core6, betaMsA2, core5];
          const unmeasured = priors(
            [
              [core7, 'unknown'],
              [betaMsA2, 'cpu-only'],
            ],
            {
              scores: [
                [betaMsA2, 3],
                [core5, 3],
              ],
            },
          );
          const result = applyThroughputPlacement(
            ordered,
            measured([
              [core6, fast],
              [core5, fast],
            ]),
            LARGE,
            BUDGET,
            unmeasured,
          );

          // core-7 gives way to core-6 and stays ahead of core-5, which has three more in flight.
          expect(splitByThroughput(ordered, result, unmeasured.scoreOf)).toEqual([[core6, core7, core5, betaMsA2]]);
        });

        it('does not defer behind a measured candidate that contention will move', () => {
          const ordered = [local, core7, core6];
          const contended = priors([[core7, 'unknown']], { contended: [local] });

          const alone = applyThroughputPlacement([local, core7], measured([[local, fast]]), LARGE, BUDGET, contended);
          expect(alone.deferred.size).toBe(0);
          expect(alone.decision?.unmeasured).toEqual([]);

          // Behind core-6, which stays in place; in one part with the local engine, so contention can still move it behind both.
          const beside = applyThroughputPlacement(
            ordered,
            measured([
              [local, fast],
              [core6, fast],
            ]),
            LARGE,
            BUDGET,
            contended,
          );
          expect([...beside.deferred]).toEqual([[core7, 'unknown']]);
          expect(splitByThroughput(ordered, beside, LEVEL)).toEqual([[local, core6, core7]]);
        });

        it('keeps every unmeasured candidate in place when the caller gives no priors', () => {
          const result = applyThroughputPlacement([core7, core6], measured([[core6, fast]]), 46_000, 920_000);

          expect(result.deferred.size).toBe(0);
          expect(splitByThroughput([core7, core6], result, LEVEL)).toEqual([[core7, core6]]);
        });
      });
    });

    describe('applySlowerPlacement', () => {
      const peer = (id: string): PoolCandidate => ({ peerId: id, nodeFqdn: `${id}.tailxyz.ts.net`, backend: 'ollama' });
      const core7 = peer('core-7');
      const core5 = peer('core-5');
      const beta1 = peer('beta-1');
      const betaMax = peer('beta-max');
      const betaRed = peer('beta-red');
      const local: PoolCandidate = { peerId: null, nodeFqdn: null, backend: 'ollama' };
      const TOKENS = 35_809;

      /** A prediction measured to meet the budget, unless `measured` says otherwise. */
      function predicted(predictedMs: number, measured: { slow?: boolean; deadline?: boolean } = {}): MeasuredPrefill {
        return {
          prediction: {
            predictedMs,
            tokensPerSec: Math.floor((TOKENS / predictedMs) * 1000),
            fromPromptTokens: TOKENS,
            extrapolated: false,
            deadline: measured.deadline ?? false,
            source: 'observed',
          },
          slow: measured.slow ?? false,
        };
      }

      /** Every candidate idle, none holding the front, every one free to go ahead, at the default thresholds, unless told otherwise. */
      function placement(
        predictions: [PoolCandidate, MeasuredPrefill][],
        options: Partial<Omit<SlowerPlacement, 'measuredOf' | 'inFlightOf'>> & { inFlight?: [PoolCandidate, number][] } = {},
      ): SlowerPlacement {
        const { inFlight = [], ...rest } = options;
        const measured = new Map(predictions);
        const queue = new Map(inFlight);
        return {
          estimatedTokens: TOKENS,
          measuredOf: (candidate) => measured.get(candidate),
          inFlightOf: (candidate) => queue.get(candidate) ?? 0,
          holdsFront: () => false,
          mayGoAhead: () => true,
          ratio: SLOWER_PLACEMENT_RATIO,
          floorMs: SLOWER_PLACEMENT_FLOOR_MS,
          ...rest,
        };
      }

      const OPENCLAW_TURN: [PoolCandidate, MeasuredPrefill][] = [
        [core7, predicted(162_910)],
        [betaMax, predicted(34_651)],
        [betaRed, predicted(38_973)],
        [beta1, predicted(22_080)],
      ];

      it("puts every node predicted much faster ahead of the first, in the ranker's order, on the OpenClaw turn's numbers", () => {
        const result = applySlowerPlacement([core7, betaMax, betaRed, beta1], placement(OPENCLAW_TURN));

        expect(result.ordered).toEqual([betaMax, betaRed, beta1, core7]);
        expect(result.demoted).toEqual([
          {
            node: 'core-7.tailxyz.ts.net',
            backend: 'ollama',
            predictedMs: 162_910,
            inFlight: 0,
            fasterNode: 'beta-max.tailxyz.ts.net',
            fasterBackend: 'ollama',
            fasterMs: 34_651,
            fasterInFlight: 0,
          },
        ]);
      });

      it('judges the new first the same way, until nothing is predicted to beat the first by that much', () => {
        const result = applySlowerPlacement(
          [core7, betaRed, beta1],
          placement([
            [core7, predicted(300_000)],
            [betaRed, predicted(90_000)],
            [beta1, predicted(10_000)],
          ]),
        );

        expect(result.ordered).toEqual([beta1, betaRed, core7]);
        expect(result.demoted.map((entry) => [entry.node, entry.fasterNode])).toEqual([
          ['core-7.tailxyz.ts.net', 'beta-red.tailxyz.ts.net'],
          ['beta-red.tailxyz.ts.net', 'beta-1.tailxyz.ts.net'],
        ]);
      });

      it('moves at exactly the ratio and the floor, and not a millisecond short of either', () => {
        const at = (first: number, second: number) =>
          applySlowerPlacement(
            [core7, beta1],
            placement([
              [core7, predicted(first)],
              [beta1, predicted(second)],
            ]),
          ).ordered;

        expect(at(60_000, 20_000)).toEqual([beta1, core7]);
        expect(at(59_999, 20_000)).toEqual([core7, beta1]);
        expect(at(24_000, 4_000)).toEqual([beta1, core7]);
        expect(at(23_999, 4_000)).toEqual([core7, beta1]);
      });

      it('takes its thresholds from the caller', () => {
        const pair: [PoolCandidate, MeasuredPrefill][] = [
          [core7, predicted(50_000)],
          [beta1, predicted(20_000)],
        ];
        expect(applySlowerPlacement([core7, beta1], placement(pair)).ordered).toEqual([core7, beta1]);
        expect(applySlowerPlacement([core7, beta1], placement(pair, { ratio: 2 })).ordered).toEqual([beta1, core7]);
        expect(applySlowerPlacement([core7, beta1], placement(pair, { ratio: 2, floorMs: 40_000 })).ordered).toEqual([core7, beta1]);
      });

      it('never moves a candidate predicted the same, so a ratio of 1 with no floor still ends', () => {
        const result = applySlowerPlacement(
          [core7, beta1, betaMax],
          placement(
            [
              [core7, predicted(30_000)],
              [beta1, predicted(30_000)],
              [betaMax, predicted(20_000)],
            ],
            { ratio: 1, floorMs: 0 },
          ),
        );

        expect(result.ordered).toEqual([betaMax, core7, beta1]);
        expect(result.demoted).toHaveLength(1);
      });

      it('lets a faster candidate with one request more go ahead, and not one with two', () => {
        const pair: [PoolCandidate, MeasuredPrefill][] = [
          [core7, predicted(54_854)],
          [beta1, predicted(8_959)],
        ];
        const oneMore = applySlowerPlacement([core7, beta1], placement(pair, { inFlight: [[beta1, SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT]] }));
        expect(oneMore.ordered).toEqual([beta1, core7]);
        expect(oneMore.demoted[0]).toMatchObject({ inFlight: 0, fasterInFlight: 1 });

        const twoMore = applySlowerPlacement([core7, beta1], placement(pair, { inFlight: [[beta1, SLOWER_PLACEMENT_MAX_EXTRA_IN_FLIGHT + 1]] }));
        expect(twoMore.ordered).toEqual([core7, beta1]);
        expect(twoMore.demoted).toEqual([]);

        // Measured from the first's own queue: a busy first is passed by a node as busy as it.
        const bothBusy = applySlowerPlacement(
          [core7, beta1],
          placement(pair, {
            inFlight: [
              [core7, 3],
              [beta1, 4],
            ],
          }),
        );
        expect(bothBusy.ordered).toEqual([beta1, core7]);
      });

      it('leaves the group whole when the first holds the front: a pinned node, or the engine affinity holds', () => {
        const group = [core7, beta1];
        const result = applySlowerPlacement(
          group,
          placement(
            [
              [core7, predicted(54_854)],
              [beta1, predicted(8_959)],
            ],
            { holdsFront: (candidate) => candidate === core7 },
          ),
        );

        expect(result.ordered).toBe(group);
        expect(result.demoted).toEqual([]);
      });

      it('never puts a candidate that may not go ahead in front, however fast: a local engine contention moves', () => {
        const result = applySlowerPlacement(
          [core7, local, beta1],
          placement(
            [
              [core7, predicted(54_854)],
              [local, predicted(2_000)],
              [beta1, predicted(8_959)],
            ],
            { mayGoAhead: (candidate) => candidate !== local },
          ),
        );

        expect(result.ordered).toEqual([beta1, core7, local]);
        expect(result.demoted[0]).toMatchObject({ fasterNode: 'beta-1.tailxyz.ts.net' });
      });

      it('does not read a missed deadline, a lower bound, as a faster prediction', () => {
        const result = applySlowerPlacement(
          [core7, beta1],
          placement([
            [core7, predicted(162_910)],
            [beta1, predicted(22_080, { deadline: true })],
          ]),
        );

        expect(result.ordered).toEqual([core7, beta1]);
      });

      it('moves nothing when every candidate is predicted to miss the budget', () => {
        const result = applySlowerPlacement(
          [core7, beta1],
          placement([
            [core7, predicted(2_000_000, { slow: true })],
            [beta1, predicted(400_000, { slow: true })],
          ]),
        );

        expect(result.ordered).toEqual([core7, beta1]);
        expect(result.demoted).toEqual([]);
      });

      it('judges no unmeasured candidate: one first leaves the group alone, and one behind keeps its place', () => {
        const measuredPair: [PoolCandidate, MeasuredPrefill][] = [
          [core7, predicted(54_854)],
          [beta1, predicted(8_959)],
        ];
        const ledByUnmeasured = [core5, core7, beta1];
        expect(applySlowerPlacement(ledByUnmeasured, placement(measuredPair)).ordered).toBe(ledByUnmeasured);

        expect(applySlowerPlacement([core7, core5, beta1], placement(measuredPair)).ordered).toEqual([beta1, core7, core5]);
      });

      it('moves nothing for a prompt under UNMEASURED_DEFER_MIN_PROMPT_TOKENS', () => {
        const pair: [PoolCandidate, MeasuredPrefill][] = [
          [core7, predicted(200_000)],
          [beta1, predicted(20_000)],
        ];
        const small = applySlowerPlacement([core7, beta1], placement(pair, { estimatedTokens: UNMEASURED_DEFER_MIN_PROMPT_TOKENS - 1 }));
        expect(small.ordered).toEqual([core7, beta1]);
        expect(small.demoted).toEqual([]);

        const large = applySlowerPlacement([core7, beta1], placement(pair, { estimatedTokens: UNMEASURED_DEFER_MIN_PROMPT_TOKENS }));
        expect(large.ordered).toEqual([beta1, core7]);
      });
    });
  });

  /**
   * beta-max, 2026-09-26 ~23:50Z. Its Ollama was prefilling OpenClaw's 39,668-token `qwen3.8:27b`
   * turn — 362 s at ~110 tok/s, because it shared the engine with 35b — when a Hermes turn asked for
   * `qwen3.6:35b` at `num_ctx` 65536, a model it held at its 32768 default for two Hermes `/v1`
   * requests. The turn waited for those, then for Ollama to evict 27b, and sat out its whole 327 s
   * budget before failing over to core-2, which answered a second later. Queue depth could not see
   * it: three in flight here did not outscore core-2's last snapshot plus the local head start. The
   * tie below is the closest case.
   */
  describe('local engine contention', () => {
    const MODEL = 'qwen3.6:35b';
    const OTHER = 'qwen3.8:27b';
    const HERMES_TURN_BYTES = 65_586;
    const HERMES_NUM_CTX = 65_536;
    /** beta-max's `OLLAMA_CONTEXT_LENGTH`: the window a `/v1` request, which cannot name one, runs at there. */
    const ENGINE_DEFAULT = 32_768;

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** What Ollama's `/api/ps` said, through `listResident`. */
    function residency(...models: [id: string, contextLength: number | null][]): BackendResidency {
      return {
        backend: 'ollama',
        source: 'measured',
        models: models.map(([id, contextLength]) => ({
          id,
          engineGpuBytes: null,
          totalBytes: null,
          expiresAt: null,
          contextLength,
          quantization: null,
        })),
      };
    }

    function core2(inFlightRequests: number): HubPoolPeer {
      return peerServing('core-2', MODEL, { inFlightRequests });
    }

    /** A generation this node's Ollama is running, as `proxyRequest` or a peer's forward records it. */
    function generating(model: string, numCtx: number | null, backend: 'ollama' | 'vllm' | 'lemonade' = 'ollama'): void {
      loadService.acquire(LOCAL_CANDIDATE_KEY, { backend, model, numCtx });
    }

    /** beta-max's Ollama at 23:50:22Z, `/api/ps` included: 35b at the default window, 27b at OpenClaw's. */
    function holdsBoth(): void {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL, OTHER] });
      ollama.listResident.mockResolvedValue(residency([MODEL, ENGINE_DEFAULT], [OTHER, HERMES_NUM_CTX]));
    }

    const setLocalCap = (maxNumCtx: number | null) => configuration.getInferencePreferences.mockReturnValue({ maxNumCtx } as never);

    /**
     * beta-max when the Hermes turn arrived: OpenClaw's 27b turn at 65536 and two Hermes `/v1`
     * requests for 35b on its Ollama, and core-2 tied with it on score — three here, against a
     * snapshot of two plus the one-request local head start.
     */
    function betaMaxMidPrefill(): void {
      holdsBoth();
      generating(OTHER, HERMES_NUM_CTX);
      generating(MODEL, null);
      generating(MODEL, null);
      peerService.listConnectedPeers.mockResolvedValue([core2(2)]);
    }

    /** One request here for this model, and core-2 idle: tied at one each, and a tie goes local. */
    function oneTurnHere(numCtx: number | null): void {
      holdsBoth();
      generating(MODEL, numCtx);
      peerService.listConnectedPeers.mockResolvedValue([core2(0)]);
    }

    const ids = (candidates: { peerId: string | null }[]) => candidates.map((candidate) => candidate.peerId);
    const hermesTurn = () => service.buildCandidateList(MODEL, HERMES_TURN_BYTES, true, HERMES_NUM_CTX);
    /** A `/v1` request: no window of its own. */
    const hermesV1 = () => service.buildCandidateList(MODEL, HERMES_TURN_BYTES, true, null);

    describe('ranking', () => {
      it('puts this node behind a peer no busier than it when its engine is generating for another model', async () => {
        betaMaxMidPrefill();

        // Behind, not gone: if core-2 fails, the turn still waits here rather than 502ing.
        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
      });

      it('moves this node even when its engine holds the model at the window asked for: the turn would share the engine with the other one', async () => {
        // beta-max, 16:52:31 PDT: a 7359-token 35b prompt read at 174 tok/s beside 27b's prefill, 1019 alone.
        betaMaxMidPrefill();
        ollama.listResident.mockResolvedValue(residency([MODEL, HERMES_NUM_CTX], [OTHER, HERMES_NUM_CTX]));

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
        // The engine is not asked: nothing it could say would keep this node first.
        expect(ollama.listResident).not.toHaveBeenCalled();
      });

      it('moves this node for a request that names no window, whatever window the engine holds the model at', async () => {
        betaMaxMidPrefill();
        ollama.listResident.mockResolvedValue(residency([MODEL, HERMES_NUM_CTX], [OTHER, HERMES_NUM_CTX]));

        expect(ids(await hermesV1())).toEqual(['core-2', null]);
      });

      it('moves this node for a request with no window when this model is generating here at another: Ollama reloads it at its default', async () => {
        // beta-max, 15:47–15:51 PDT: 35b relaunched six times, -c 65536 after each native turn and -c 32768 after each /v1 one.
        setLocalCap(ENGINE_DEFAULT);
        oneTurnHere(HERMES_NUM_CTX);

        expect(ids(await hermesV1())).toEqual(['core-2', null]);
      });

      it('keeps this node first for a request with no window when this model is generating here at the default this node states', async () => {
        setLocalCap(ENGINE_DEFAULT);
        oneTurnHere(ENGINE_DEFAULT);

        expect(ids(await hermesV1())).toEqual([null, 'core-2']);
      });

      it('reads a /v1 request in flight as running at the stated default, so a native turn asking for exactly that joins it', async () => {
        setLocalCap(ENGINE_DEFAULT);
        oneTurnHere(null);

        expect(ids(await service.buildCandidateList(MODEL, HERMES_TURN_BYTES, true, ENGINE_DEFAULT))).toEqual([null, 'core-2']);
      });

      it('counts an unstated default as a different window from any named one, but the same as itself', async () => {
        oneTurnHere(HERMES_NUM_CTX);

        expect(ids(await hermesV1())).toEqual(['core-2', null]);

        loadService.release(LOCAL_CANDIDATE_KEY, { backend: 'ollama', model: MODEL, numCtx: HERMES_NUM_CTX });
        generating(MODEL, null);

        // Both run at the engine's default, whatever it is: no reload between them.
        expect(ids(await hermesV1())).toEqual([null, 'core-2']);
      });

      it('moves this node when this model is generating here at another window: the reload waits for those requests', async () => {
        // beta-max, 16:52:31 PDT: the 65536 load waited for the second /v1 request to finish. beta-max
        // states no cap, so the context cap could not move this turn; only the window in flight can.
        holdsBoth();
        generating(MODEL, null);
        generating(MODEL, null);
        peerService.listConnectedPeers.mockResolvedValue([core2(1)]);

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
      });

      it('moves this node for a window inside its cap when this model is generating here at another one', async () => {
        // The cap takes 32768 here, so only contention can see that the /v1 requests hold 65536.
        setLocalCap(HERMES_NUM_CTX);
        oneTurnHere(null);

        expect(ids(await service.buildCandidateList(MODEL, HERMES_TURN_BYTES, true, ENGINE_DEFAULT))).toEqual(['core-2', null]);
      });

      it('keeps this node first when this model is generating here at the window asked for: that is a queue, which the ranker already counts', async () => {
        oneTurnHere(HERMES_NUM_CTX);

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
        expect(ollama.listResident).not.toHaveBeenCalled();
      });

      it('judges windows on Ollama only: another engine runs the window it was started with, whatever a request names', async () => {
        ollama.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
        lemonade.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        generating(MODEL, null, 'lemonade');
        peerService.listConnectedPeers.mockResolvedValue([core2(0)]);

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('judges nothing when the other work here is not a generation: an embedding holds no runner for minutes', async () => {
        holdsBoth();
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        peerService.listConnectedPeers.mockResolvedValue([core2(0)]);

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it("judges nothing when the other model is generating on another of this node's engines", async () => {
        holdsBoth();
        generating(OTHER, HERMES_NUM_CTX, 'vllm');
        peerService.listConnectedPeers.mockResolvedValue([core2(0)]);

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('keeps this node ahead of a peer with a deeper queue: contention costs it the head start, not its place', async () => {
        // Both fleet models run -np 1, so core-2's eight are eight turns in a row.
        holdsBoth();
        generating(OTHER, HERMES_NUM_CTX);
        peerService.listConnectedPeers.mockResolvedValue([core2(8)]);

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('moves this node behind only the peers no busier than it, and stops at the first one that is', async () => {
        holdsBoth();
        generating(OTHER, HERMES_NUM_CTX);
        peerService.listConnectedPeers.mockResolvedValue([core2(0), peerServing('core-6', MODEL, { inFlightRequests: 5 })]);

        expect(ids(await hermesTurn())).toEqual(['core-2', null, 'core-6']);
      });

      it('gives way to a peer exactly as busy as it: a contended engine loses the ties it would have won', async () => {
        holdsBoth();
        generating(OTHER, HERMES_NUM_CTX);
        generating(OTHER, HERMES_NUM_CTX);
        peerService.listConnectedPeers.mockResolvedValue([core2(2)]);

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
      });

      it('judges within a context-cap group: a peer capped below the window stays behind this node, contended or not', async () => {
        holdsBoth();
        generating(OTHER, HERMES_NUM_CTX);
        peerService.listConnectedPeers.mockResolvedValue([
          mockPeer({
            id: 'core-17',
            nodeFqdn: 'core-17.tailxyz.ts.net',
            lastCapabilities: capabilitiesWithModel(MODEL, { inFlightRequests: 0, maxNumCtx: 16_384 }) as unknown as Record<string, unknown>,
          }),
        ]);

        expect(ids(await hermesTurn())).toEqual([null, 'core-17']);
      });

      it('moves nothing when there is no peer to put ahead of this node', async () => {
        betaMaxMidPrefill();
        peerService.listConnectedPeers.mockResolvedValue([]);

        expect(ids(await hermesTurn())).toEqual([null]);
      });

      it('leaves a request with no prompt to judge where the ranker put it', async () => {
        betaMaxMidPrefill();

        expect(ids(await service.buildCandidateList(MODEL))).toEqual([null, 'core-2']);
      });

      it('stops reordering under HUB_POOL_CONTENTION_PLACEMENT=off', async () => {
        betaMaxMidPrefill();
        vi.stubEnv('HUB_POOL_CONTENTION_PLACEMENT', 'off');

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('keeps this node ahead of a peer measured too slow for the prompt: that peer misses its whole budget, a contended engine may not', async () => {
        betaMaxMidPrefill();
        throughput.recordPrefill({ nodeKey: 'core-2', backend: 'ollama', model: MODEL }, { promptTokens: 16_400, ms: 400_000, deadline: true });

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('applies before a pin, so a pin at this node cannot put it back in front of a peer it gave way to', async () => {
        betaMaxMidPrefill();
        setPoolPreferences({ poolPins: [{ scope: 'model', model: MODEL, targetKind: 'local', mode: 'prefer' }] });

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
      });
    });

    describe('what the engine is busy with', () => {
      const hermesBody = { model: MODEL, stream: true, options: { num_ctx: HERMES_NUM_CTX }, messages: [{ role: 'user', content: 'hello' }] };

      /** Upstream answers that wait until released, so a request stays in flight while another is ranked. */
      function holdUpstream(): { release: () => void } {
        const waiting: Array<() => void> = [];
        vi.mocked(global.fetch).mockImplementation(
          () =>
            new Promise((resolve) => {
              waiting.push(() => resolve(new Response('data: [DONE]\n\n', { status: 200 })));
            }),
        );
        return {
          release: () => {
            for (const answer of waiting.splice(0)) answer();
          },
        };
      }

      beforeEach(() => {
        holdsBoth();
        // Idle, so the ranker alone would tie it with this node at one in flight, and a tie goes local.
        peerService.listConnectedPeers.mockResolvedValue([core2(0)]);
      });

      it('counts a turn this node placed on its own engine, until its response finishes', async () => {
        const upstream = holdUpstream();
        const openClaw = service.proxyRequest({
          path: '/api/chat',
          method: 'POST',
          body: { model: OTHER, stream: true, messages: [{ role: 'user', content: 'hi' }] },
          model: OTHER,
          res: createMockResponse(),
        });
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);

        upstream.release();
        await openClaw;
        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('counts a turn a peer forwarded here, by the model its header named', async () => {
        const upstream = holdUpstream();
        const forwarded = service.forwardToLocalBackendAndRespond(
          'ollama',
          '/api/chat',
          'POST',
          { model: OTHER, stream: true, messages: [{ role: 'user', content: 'hi' }] },
          createMockResponse(),
          'core-6.tailxyz.ts.net',
          OTHER,
        );
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        expect(ids(await hermesTurn())).toEqual(['core-2', null]);

        upstream.release();
        await forwarded;
        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);
      });

      it('records a /v1 turn at the engine default even when its body names a window: Ollama drops `options` there', async () => {
        const upstream = holdUpstream();
        const v1 = service.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: MODEL, stream: true, options: { num_ctx: HERMES_NUM_CTX }, messages: [{ role: 'user', content: 'hi' }] },
          model: MODEL,
          res: createMockResponse(),
        });
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        // Recorded at 65536, the native turn would have joined it; at the default, which this node
        // does not state, it cannot be shown to.
        expect(ids(await hermesTurn())).toEqual(['core-2', null]);
        expect(ids(await hermesV1())).toEqual([null, 'core-2']);

        upstream.release();
        await v1;
      });

      it('does not count an embedding placed here', async () => {
        const upstream = holdUpstream();
        const embedding = service.proxyRequest({
          path: '/v1/embeddings',
          method: 'POST',
          body: { model: OTHER, input: 'x' },
          model: OTHER,
          res: createMockResponse(),
        });
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

        expect(ids(await hermesTurn())).toEqual([null, 'core-2']);

        upstream.release();
        await embedding;
      });

      describe('in the routing log', () => {
        it('names the engine it moved, the generations there this request could not join, and the nodes it moved behind', async () => {
          betaMaxMidPrefill();
          peerService.getPeerById.mockResolvedValue(core2(2));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: 'core-2.tailxyz.ts.net', attempt: 1, candidates: 2, failedOverFrom: [], outcome: 'served' });
          // No context cap here, so the /v1 requests' window is unknown, and unknown is not 65536.
          expect(entry?.contention).toEqual({
            numCtx: HERMES_NUM_CTX,
            demoted: [
              {
                node: LOCAL_CANDIDATE_KEY,
                backend: 'ollama',
                busyWith: [
                  { model: OTHER, numCtx: HERMES_NUM_CTX },
                  { model: MODEL, numCtx: null },
                ],
                runsAt: HERMES_NUM_CTX,
                behind: ['core-2.tailxyz.ts.net'],
                overriddenBy: null,
              },
            ],
            overridden: false,
          });
        });

        it('states each window as the engine runs it: a /v1 request at the default this node states', async () => {
          setLocalCap(ENGINE_DEFAULT);
          betaMaxMidPrefill();
          peerService.getPeerById.mockResolvedValue(core2(2));
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          expect(routingLog.list()[0]?.contention?.demoted[0]?.busyWith).toEqual([
            { model: OTHER, numCtx: HERMES_NUM_CTX },
            { model: MODEL, numCtx: ENGINE_DEFAULT },
          ]);
        });

        it('still fails over to this node when every peer fails, and says the demotion was overridden', async () => {
          betaMaxMidPrefill();
          peerService.getPeerById.mockResolvedValue(core2(2));
          vi.mocked(global.fetch).mockImplementation(async (url) =>
            String(url).includes('core-2')
              ? new Response('model failed to load', { status: 503 })
              : new Response('data: [DONE]\n\n', { status: 200 }),
          );

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: LOCAL_CANDIDATE_KEY, outcome: 'served', status: 200, failedOverFrom: ['core-2.tailxyz.ts.net'] });
          expect(entry?.contention).toMatchObject({
            demoted: [{ node: LOCAL_CANDIDATE_KEY, behind: ['core-2.tailxyz.ts.net'] }],
            overridden: true,
          });
        });

        it('says a contended engine kept its place, and was placed on, when every peer was busier', async () => {
          generating(OTHER, HERMES_NUM_CTX);
          peerService.listConnectedPeers.mockResolvedValue([core2(8)]);
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          const entry = routingLog.list()[0];
          expect(entry).toMatchObject({ node: LOCAL_CANDIDATE_KEY, attempt: 1, failedOverFrom: [] });
          expect(entry?.contention).toMatchObject({ demoted: [{ node: LOCAL_CANDIDATE_KEY, behind: [] }], overridden: true });
        });

        it('records nothing when the only work here is this model at the window asked for', async () => {
          generating(MODEL, HERMES_NUM_CTX);
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          expect(routingLog.list()[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, contention: null });
        });

        it('records nothing when nothing else is generating here', async () => {
          vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));

          await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });

          expect(routingLog.list()[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, contention: null });
        });
      });
    });

    /**
     * Contention runs after prefix affinity, and until this it overruled every affinity hit: on
     * core-2, a ~30k-token Hermes turn for 35b arriving while OpenClaw's 27b was generating was moved
     * to an idle leaf and prefilled there cold (~100 s at ~300 tok/s), and the table then remembered
     * the leaf, so the session stayed migrated. An engine affinity qualified now keeps its place; one
     * affinity stood aside from, or with affinity off, is judged exactly as before.
     */
    describe('with prefix affinity', () => {
      const hermesBody = { model: MODEL, stream: true, options: { num_ctx: HERMES_NUM_CTX }, messages: [{ role: 'user', content: 'hello' }] };
      const CORE_2_FQDN = 'core-2.tailxyz.ts.net';

      function forwardedTo(): string[] {
        return vi
          .mocked(global.fetch)
          .mock.calls.map(([url]) => (String(url).includes('local-ollama') ? LOCAL_CANDIDATE_KEY : new URL(String(url)).hostname));
      }

      async function hermes(): Promise<void> {
        await service.proxyRequest({ path: '/api/chat', method: 'POST', body: hermesBody, model: MODEL, res: createMockResponse() });
      }

      /** The session's first turn, served here with nothing else running, so the table remembers this node's Ollama. */
      async function sessionWarmHere(): Promise<void> {
        await hermes();
        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY]);
      }

      beforeEach(() => {
        holdsBoth();
        const core2Peer = core2(0);
        peerService.listConnectedPeers.mockResolvedValue([core2Peer]);
        peerService.getPeerById.mockResolvedValue(core2Peer);
        peerService.getPresentToken.mockResolvedValue('raw-token');
        vi.mocked(global.fetch).mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
      });

      it('keeps the engine the session is warm on when affinity qualifies it under the limit, and says affinity held it', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        // OpenClaw's 27b turn: another model on this Ollama, which alone would put core-2 first.
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, LOCAL_CANDIDATE_KEY]);
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: LOCAL_CANDIDATE_KEY, failedOverFrom: [], outcome: 'served' });
        expect(entry?.affinity).toMatchObject({ outcome: 'hit', qualified: true, remembered: LOCAL_CANDIDATE_KEY, inFlight: 1 });
        expect(entry?.contention).toEqual({
          numCtx: HERMES_NUM_CTX,
          demoted: [
            {
              node: LOCAL_CANDIDATE_KEY,
              backend: 'ollama',
              busyWith: [{ model: OTHER, numCtx: HERMES_NUM_CTX }],
              runsAt: HERMES_NUM_CTX,
              behind: [],
              overriddenBy: 'affinity',
            },
          ],
          // Placed on the contended engine, which is what `overridden` has always recorded.
          overridden: true,
        });
      });

      it('keeps it when affinity qualifies it by the margin, past the limit', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 1, poolPrefixAffinityMargin: 1 });
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, LOCAL_CANDIDATE_KEY]);
        const entry = routingLog.list()[0];
        expect(entry?.affinity).toMatchObject({ outcome: 'hit', qualified: true, inFlight: 1, leastLoadedInFlight: 0, affinityMargin: 1 });
        expect(entry?.contention?.demoted[0]).toMatchObject({ behind: [], overriddenBy: 'affinity' });
      });

      it('moves it as before with affinity off (the default)', async () => {
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        const entry = routingLog.list()[0];
        expect(entry?.affinity).toBeNull();
        expect(entry?.contention?.demoted[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, behind: [CORE_2_FQDN], overriddenBy: null });
      });

      it('moves it as before when affinity stood aside because the engine was over the limit', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 1 });
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        const entry = routingLog.list()[0];
        expect(entry?.affinity).toMatchObject({ outcome: 'skipped', qualified: false, remembered: LOCAL_CANDIDATE_KEY, inFlight: 1 });
        expect(entry?.contention?.demoted[0]).toMatchObject({ behind: [CORE_2_FQDN], overriddenBy: null });
      });

      it('credits affinity with nothing when the engine would have kept its place anyway', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);
        // Eight in flight on core-2: contention alone would not have moved this node behind it.
        peerService.listConnectedPeers.mockResolvedValue([core2(8)]);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, LOCAL_CANDIDATE_KEY]);
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({ behind: [], overriddenBy: null });
      });

      /**
       * The engine is held only while the session's prefix can still be warm on it. Both cases
       * below are beta-max's 2026-09-26 wait — a 35b turn at 65536 behind a reload, then an
       * eviction, for its whole 327 s budget — which contention placement exists to prevent. A
       * reload discards the prefix, so holding the engine for it would buy the wait and nothing else.
       */
      it('moves it as before when this model is generating here at another window: that reload discarded the prefix', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        // A Hermes `/v1` request for 35b: Ollama reloaded it at its default, and must reload it again for 65536.
        generating(MODEL, null);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        const entry = routingLog.list()[0];
        expect(entry).toMatchObject({ node: CORE_2_FQDN, failedOverFrom: [], outcome: 'served' });
        // Affinity still qualified the engine; contention, not affinity, placed core-2 first.
        expect(entry?.affinity).toMatchObject({ outcome: 'skipped', qualified: true, remembered: LOCAL_CANDIDATE_KEY });
        expect(entry?.contention?.demoted[0]).toMatchObject({
          node: LOCAL_CANDIDATE_KEY,
          busyWith: [{ model: MODEL, numCtx: null }],
          runsAt: HERMES_NUM_CTX,
          behind: [CORE_2_FQDN],
          overriddenBy: null,
        });
        // Judged from this node's own records: the engine is not asked.
        expect(ollama.listResident).not.toHaveBeenCalled();
      });

      it('moves it as before when the model is no longer resident here: the prefix went with it, and the turn waits for an eviction', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        // 27b's load evicted 35b, and 27b is generating.
        ollama.listResident.mockResolvedValue(residency([OTHER, HERMES_NUM_CTX]));
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        const entry = routingLog.list()[0];
        expect(entry?.affinity).toMatchObject({ outcome: 'skipped', qualified: true, remembered: LOCAL_CANDIDATE_KEY });
        expect(entry?.contention?.demoted[0]).toMatchObject({
          node: LOCAL_CANDIDATE_KEY,
          busyWith: [{ model: OTHER, numCtx: HERMES_NUM_CTX }],
          behind: [CORE_2_FQDN],
          overriddenBy: null,
        });
      });

      it('moves it as before when the engine cannot say what is resident: a warm prefix has to be shown, not assumed', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        ollama.listResident.mockResolvedValue({ backend: 'ollama', source: 'unreachable', models: null, error: 'connect ECONNREFUSED' });
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({ behind: [CORE_2_FQDN], overriddenBy: null });
      });

      it('moves it as before when the residency read throws', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        ollama.listResident.mockRejectedValue(new Error('socket hang up'));
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({ behind: [CORE_2_FQDN], overriddenBy: null });
      });

      it('moves it as before when the residency read outlasts the placement budget, rather than holding the turn for it', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          // `/api/ps` behind a DROP rule: it would answer only at the transport's 5 s timeout.
          ollama.listResident.mockReturnValue(new Promise(() => {}));

          const turn = hermes();
          await vi.advanceTimersByTimeAsync(PLACEMENT_PROBE_BUDGET_MS);
          await turn;
        } finally {
          vi.useRealTimers();
        }

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, CORE_2_FQDN]);
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({ behind: [CORE_2_FQDN], overriddenBy: null });
      });

      it('holds an engine with no residency to read: it serves what it was started with, which is what made it a candidate', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        ollama.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
        vllm.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
        vllm.getBaseUrl.mockReturnValue('http://local-vllm:8000');
        // VllmBackend declares no `listResident`; the mock would otherwise answer for any name.
        Object.assign(vllm, { listResident: undefined });
        const v1Turn = () =>
          service.proxyRequest({
            path: '/v1/chat/completions',
            method: 'POST',
            body: { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hello' }] },
            model: MODEL,
            res: createMockResponse(),
          });
        await v1Turn();
        generating(OTHER, null, 'vllm');

        await v1Turn();

        expect(forwardedTo()).toEqual(['local-vllm', 'local-vllm']);
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({
          node: LOCAL_CANDIDATE_KEY,
          backend: 'vllm',
          behind: [],
          overriddenBy: 'affinity',
        });
      });

      it('asks the engine what is resident only when the answer could hold it: never with affinity off', async () => {
        await sessionWarmHere();
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(ollama.listResident).not.toHaveBeenCalled();
      });

      it('leaves the same model at the same window alone, as before: that is a queue, not contention', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        await sessionWarmHere();
        generating(MODEL, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([LOCAL_CANDIDATE_KEY, LOCAL_CANDIDATE_KEY]);
        expect(routingLog.list()[0]).toMatchObject({ contention: null, affinity: { outcome: 'hit', qualified: true } });
      });

      it('still judges another contended engine here that affinity did not remember', async () => {
        setPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
        // The session is warm on core-2, not here, so this node's busy Ollama is judged as ever.
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        loadService.acquire(LOCAL_CANDIDATE_KEY);
        await hermes();
        loadService.release(LOCAL_CANDIDATE_KEY);
        loadService.release(LOCAL_CANDIDATE_KEY);
        expect(forwardedTo()).toEqual([CORE_2_FQDN]);
        generating(OTHER, HERMES_NUM_CTX);

        await hermes();

        expect(forwardedTo()).toEqual([CORE_2_FQDN, CORE_2_FQDN]);
        expect(routingLog.list()[0]?.affinity).toMatchObject({ outcome: 'hit', qualified: true, remembered: CORE_2_FQDN });
        expect(routingLog.list()[0]?.contention?.demoted[0]).toMatchObject({ node: LOCAL_CANDIDATE_KEY, overriddenBy: null });
      });
    });

    describe('applyLocalContention', () => {
      const local = { peerId: null, nodeFqdn: null, backend: 'ollama' } as const;
      const localLemonade = { peerId: null, nodeFqdn: null, backend: 'lemonade' } as const;
      const core2Candidate = { peerId: 'core-2', nodeFqdn: 'core-2.tailxyz.ts.net', backend: 'ollama' } as const;
      const core6Candidate = { peerId: 'core-6', nodeFqdn: 'core-6.tailxyz.ts.net', backend: 'ollama' } as const;
      const HEAD_START = 1;
      /** Ranker scores: a peer's carries the head start, this node's does not. */
      const scores = new Map<PoolCandidate, number>([
        [local, 1],
        [localLemonade, 1],
        [core2Candidate, 0 + HEAD_START],
        [core6Candidate, 5 + HEAD_START],
      ]);
      const scoreOf = (candidate: PoolCandidate) => scores.get(candidate) ?? 0;
      const contended =
        (...engines: PoolCandidate[]) =>
        (candidate: PoolCandidate) =>
          engines.includes(candidate);

      it('moves nothing, and names nothing, when no candidate is contended', () => {
        const group = [local, core2Candidate, core6Candidate];

        expect(applyLocalContention(group, contended(), scoreOf, HEAD_START)).toEqual({ pieces: [group], behind: new Map() });
      });

      it('moves a contended engine behind the candidates after it that are no busier once its head start is set aside, up to the first that is', () => {
        const result = applyLocalContention([local, core2Candidate, core6Candidate], contended(local), scoreOf, HEAD_START);

        // Two pieces, so a pin applied within each cannot put this node back in front of core-2.
        expect(result.pieces).toEqual([[core2Candidate], [local, core6Candidate]]);
        expect(result.behind).toEqual(new Map([[local, [core2Candidate]]]));
      });

      it('keeps a contended engine where it was, behind nobody, when every candidate after it is busier', () => {
        const busy = new Map<PoolCandidate, number>([
          [local, 1],
          [core2Candidate, 8 + HEAD_START],
        ]);

        expect(applyLocalContention([local, core2Candidate], contended(local), (candidate) => busy.get(candidate) ?? 0, HEAD_START)).toEqual({
          pieces: [[local, core2Candidate]],
          behind: new Map([[local, []]]),
        });
      });

      it('gives way to a free engine on this node as it would to a peer', () => {
        const result = applyLocalContention([local, localLemonade, core2Candidate], contended(local), scoreOf, HEAD_START);

        expect(result.pieces.flat()).toEqual([localLemonade, core2Candidate, local]);
      });

      it('moves nothing when every candidate is contended, and keeps them in ranked order', () => {
        const result = applyLocalContention([local, localLemonade], contended(local, localLemonade), scoreOf, HEAD_START);

        expect(result.pieces).toEqual([[local, localLemonade]]);
        expect(result.behind).toEqual(
          new Map<PoolCandidate, PoolCandidate[]>([
            [local, []],
            [localLemonade, []],
          ]),
        );
      });
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
    // route. Confirms the pool proxy never conflates the two. The listing paths are built as a
    // body rather than streamed (see `serveMergedListing`), so the answer is read off `res.json`.
    it('keeps Ollama’s native /api/tags shape, distinct from the /v1/models shape', async () => {
      const nativeTags = { models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2019393189 }] };
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(nativeTags), { status: 200 }));

      const res = createMockResponse();
      await service.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);

      const [url] = vi.mocked(global.fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://local-ollama:11434/api/tags');
      const body = vi.mocked(res.json).mock.calls[0]?.[0];
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
      expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual(nativeTags);
    });

    /*
     * The listing used to answer for this node while every generation path already answered for the
     * pool, so a client was told one set of models and then found another one served. These pin the
     * merge: peer-held models appear, local metadata is untouched, and a duplicate never does.
     */
    describe('merging what peers hold into the listing', () => {
      it('adds a peer-only model to /v1/models, marked as the pool’s', async () => {
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', 'qwen3.6:27b')]);
        const localModels = { object: 'list', data: [{ id: 'llama3.2:3b', object: 'model', created: 1, owned_by: 'library' }] };
        vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(localModels), { status: 200 }));

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual({
          object: 'list',
          data: [
            { id: 'llama3.2:3b', object: 'model', created: 1, owned_by: 'library' },
            { id: 'qwen3.6:27b', object: 'model', created: 0, owned_by: 'hub-pool' },
          ],
        });
      });

      it('adds a peer-only model to /api/tags in Ollama’s shape', async () => {
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', 'qwen3.6:27b')]);
        vi.mocked(global.fetch).mockResolvedValue(
          new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b', model: 'llama3.2:3b' }] }), { status: 200 }),
        );

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);

        const body = vi.mocked(res.json).mock.calls[0]?.[0] as { models: Array<Record<string, unknown>> };
        expect(body.models).toHaveLength(2);
        expect(body.models[1]).toMatchObject({ name: 'qwen3.6:27b', model: 'qwen3.6:27b', size: 0 });
      });

      /* A model both nodes hold must appear once, with the local row's real metadata. */
      it('never lists a model twice when a peer holds it too', async () => {
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', 'llama3.2:3b')]);
        const localModels = { object: 'list', data: [{ id: 'llama3.2:3b', object: 'model', created: 1, owned_by: 'library' }] };
        vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(localModels), { status: 200 }));

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);

        expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual(localModels);
      });

      /*
       * A Hub with no local engine is a legitimate pool member — it exists to send work out. It
       * used to answer 502 here while its peers held a dozen models.
       */
      it('answers from peers alone when no local backend can', async () => {
        peerService.listConnectedPeers.mockResolvedValue([peerServing('peer-a', 'qwen3.6:27b')]);
        vi.mocked(global.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual({
          object: 'list',
          data: [{ id: 'qwen3.6:27b', object: 'model', created: 0, owned_by: 'hub-pool' }],
        });
      });

      it('still answers 502 when neither this node nor any peer has anything', async () => {
        vi.mocked(global.fetch).mockResolvedValue(new Response('not found', { status: 404 }));

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);

        expect(res.status).toHaveBeenCalledWith(502);
      });

      /* A peer that has switched inbound off is not offering anything, and must not be listed. */
      it('leaves out a peer that is not accepting work', async () => {
        peerService.listConnectedPeers.mockResolvedValue([
          mockPeer({
            lastCapabilities: capabilitiesWithModel('qwen3.6:27b', { acceptingWork: false }) as unknown as Record<string, unknown>,
          }),
        ]);
        const localModels = { object: 'list', data: [{ id: 'llama3.2:3b', object: 'model' }] };
        vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify(localModels), { status: 200 }));

        const res = createMockResponse();
        await service.proxyLocalOnlyRequest('/v1/models', 'GET', undefined, res);

        expect(vi.mocked(res.json).mock.calls[0]?.[0]).toEqual(localModels);
      });
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
        new InferenceBackendRegistry(ollama, vllm, lemonade, omlx),
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

      // #1480 gave every node a prompt ceiling and made `rankCandidates` demote a node whose ceiling
      // is under the request's estimate. A ceiling is a statement about how long a TURN a node will
      // prefill, and this lookup is not a turn — the peer answers it from metadata already on disk,
      // in under 0.3 s on every node measured, whatever the body says.
      //
      // Ollama's `/api/show` accepts `template` and `system` alongside the model name, so a caller
      // that overrides either sends a body big enough to cross a ceiling. Measured against one, the
      // node best placed to answer instantly would be walked past over a number describing work it
      // is not being asked to do. `peer-careful` sits at MIN_POOL_MAX_PROMPT_TOKENS, the lowest
      // ceiling a peer can advertise (anything lower is clamped to "no ceiling"), and the body below
      // is over it — so this fails the moment any ceiling logic reaches this path.
      it('exempts the lookup from the prompt ceiling, even when the show body is over it', async () => {
        const withCatalog = serviceWithCatalog();
        localHas('nomic-embed-text:latest');
        // Idle, so the ranker puts it first; `peer-spare` is busier and carries no ceiling at all,
        // which is what makes a demotion observable rather than an `overridden` no-op that moves nothing.
        peersAre(
          peerServing('peer-careful', 'qwen3.6:27b', { inFlightRequests: 0, maxPromptTokens: MIN_POOL_MAX_PROMPT_TOKENS }),
          peerServing('peer-spare', 'qwen3.6:27b', { inFlightRequests: 2 }),
        );
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async (url) =>
          String(url).includes('tailxyz.ts.net')
            ? new Response(JSON.stringify({ details: { parameter_size: '27B' } }), { status: 200 })
            : new Response('model not found', { status: 404 }),
        );
        const res = createMockResponse();
        // ~1.5k estimated tokens, comfortably over the 1024 ceiling above.
        const system = 'x'.repeat(6_000);

        await withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { model: AUTO_MODEL, system }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(headersSetOn(res)[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe('peer-careful.tailxyz.ts.net');
        // The spare was never needed: the ceiling did not push the lookup down the list.
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('peer-spare'))).toHaveLength(0);
      });

      // Slot-aware placement is the third decision this lookup is exempt from, for the same reason
      // as the ceiling: a full node is demoted because a forwarded request would queue behind its
      // engine, and `/api/show` joins no queue — the daemon answers it from metadata on disk whether
      // or not a model is busy. `peer-full` has the shorter queue, so the ranker puts it first, and
      // its 2 in flight fill its 2 slots, so the slot pass would move it behind `peer-spare` — which
      // is what makes the exemption observable rather than a no-op. The embedding case stays judged
      // ("judges an embedding too", under slot-aware placement): an embedding occupies a slot.
      it('exempts the lookup from slot-aware placement, so a full node the ranker chose is still asked first', async () => {
        setPoolPreferences({ poolSlotAwareness: 1 });
        const withCatalog = serviceWithCatalog();
        localHas('nomic-embed-text:latest');
        peersAre(
          peerServing('peer-full', 'qwen3.6:27b', { inFlightRequests: 2, ollamaSlots: 2 }),
          peerServing('peer-spare', 'qwen3.6:27b', { inFlightRequests: 3, ollamaSlots: 4 }),
        );
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockImplementation(async (url) =>
          String(url).includes('tailxyz.ts.net')
            ? new Response(JSON.stringify({ details: { parameter_size: '27B' } }), { status: 200 })
            : new Response('model not found', { status: 404 }),
        );
        const res = createMockResponse();

        await withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { model: AUTO_MODEL }, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(headersSetOn(res)[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe('peer-full.tailxyz.ts.net');
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('peer-spare'))).toHaveLength(0);
        // Still not a turn: no row, no queue depth.
        expect(routingLog.list()).toHaveLength(0);
        expect(loadService.get('peer-full')).toBe(0);

        // The same fleet, and a request that does occupy a slot: the full node goes behind the spare.
        const chat = createMockResponse();
        fetchMock.mockImplementation(async () => new Response('data: [DONE]\n\n', { status: 200 }));
        await withCatalog.proxyRequest({
          path: '/v1/chat/completions',
          method: 'POST',
          body: { model: 'qwen3.6:27b', stream: true },
          model: 'qwen3.6:27b',
          res: chat,
        });
        expect(routingLog.list()[0]).toMatchObject({ node: 'peer-spare.tailxyz.ts.net', attempt: 1, failedOverFrom: [] });
        expect(routingLog.list()[0]?.slots).toMatchObject({
          demoted: [{ node: 'peer-full.tailxyz.ts.net', inFlight: 2, slots: 2 }],
          overridden: false,
        });
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

      // The lookup used to inherit the completion budget (300 s) per peer. The engine answers /api/show
      // in under 0.3 s on every node measured, so a peer that takes the connection and stalls is broken,
      // and the app's lookup must move on long before OpenClaw gives up on its model.
      it('moves past a peer that accepts the lookup and never answers, instead of holding the app for the completion budget', async () => {
        vi.useFakeTimers();
        try {
          const withCatalog = serviceWithCatalog();
          localHas('nomic-embed-text:latest');
          peersAre(
            peerServing('peer-stalled', 'qwen3.6:27b', { inFlightRequests: 0 }),
            peerServing('peer-ok', 'qwen3.6:27b', { inFlightRequests: 0 }),
          );
          vi.mocked(global.fetch).mockImplementation((url, init) => {
            if (String(url).includes('peer-ok')) {
              return Promise.resolve(new Response(JSON.stringify({ details: {} }), { status: 200 }));
            }
            if (String(url).includes('peer-stalled')) {
              const signal = init?.signal as AbortSignal;
              return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
            }
            return Promise.resolve(new Response('model not found', { status: 404 }));
          });
          const res = createMockResponse();

          const lookup = withCatalog.proxyLocalOnlyRequest('/api/show', 'POST', { model: AUTO_MODEL }, res);
          await vi.advanceTimersByTimeAsync(20_000);
          await lookup;

          expect(res.status).toHaveBeenCalledWith(200);
          expect(headersSetOn(res)[POOL_SERVED_BY_HEADER.toLowerCase()]).toBe('peer-ok.tailxyz.ts.net');
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // The fleet measurement behind these: on four of fifteen nodes ufw DROPped the Hub container's
  // SYN to an engine port, so every pooled request entering the node waited out a 5 s health probe
  // for an engine that was never going to be a candidate — 5035–5200 ms pool TTFT against 22–100 ms
  // once the port answered. The proxy now ranks from a per-backend snapshot; the request path pays
  // at most PLACEMENT_PROBE_BUDGET_MS, and only on a cold read.
  describe('local health snapshot', () => {
    const MODEL = 'llama3.2:3b';
    /** The TTL the canary runs at. The default is 0 — the live-probe path — and one test below pins that. */
    const SNAPSHOT_TTL_MS = 10_000;

    beforeEach(() => {
      setPoolPreferences({ poolProbeSnapshotTtlMs: SNAPSHOT_TTL_MS });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A backend whose probe never answers — what a DROP rule looks like until axios's 5 s timeout. */
    function hangs(backend: MockProxy<OllamaBackend> | MockProxy<VllmBackend>): void {
      backend.healthCheck.mockImplementation(() => new Promise(() => {}));
    }

    it('ranks within the placement budget when a local probe hangs, instead of waiting out its 5 s timeout', async () => {
      vi.useFakeTimers();
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      hangs(vllm);

      const ranking = service.buildCandidateList(MODEL);
      // Nothing settles before the budget: the hung probe holds the cold read...
      let settled = false;
      void ranking.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(PLACEMENT_PROBE_BUDGET_MS - 1);
      expect(settled).toBe(false);
      // ...and the budget, not the 5 s transport timeout, is what releases it.
      await vi.advanceTimersByTimeAsync(1);
      expect(await ranking).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('does not make the next request wait for a probe the last one gave up on', async () => {
      vi.useFakeTimers();
      hangs(vllm);
      const first = service.buildCandidateList(MODEL);
      await vi.advanceTimersByTimeAsync(PLACEMENT_PROBE_BUDGET_MS);
      await first;
      vllm.healthCheck.mockClear();

      // Settles without the clock moving: the hung engine is on record as not answering, and it is
      // the background refresh that will ask again, not this request.
      const second = service.buildCandidateList(MODEL);
      await vi.advanceTimersByTimeAsync(0);
      expect(await second).toEqual([]);
      expect(vllm.healthCheck).not.toHaveBeenCalled();
    });

    it('reports how old each probe was on the no-candidate 502', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['other:1b'] });
      // Warm the snapshot, then ask again 4 s later: the second body must say it is reading a
      // 4 s-old answer, which is what tells an operator who just fixed a firewall rule that the
      // `running: false` they are looking at predates the fix.
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });
      vi.setSystemTime(Date.now() + 4_000);
      const res = createMockResponse();

      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      expect(res.status).toHaveBeenCalledWith(502);
      const body = vi.mocked(res.json).mock.calls[0]?.[0] as { localBackends: Array<{ type: string; probedMsAgo: number }> };
      expect(body.localBackends.find((probe) => probe.type === 'ollama')?.probedMsAgo).toBe(4_000);
      expect(ollama.healthCheck).toHaveBeenCalledTimes(1);
    });

    it('offers a backend that came up once the snapshot has been refreshed, and not before', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(await service.buildCandidateList(MODEL)).toEqual([]);
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });

      // Inside the TTL the snapshot is served as is: the engine coming up is not yet visible.
      expect(await service.buildCandidateList(MODEL)).toEqual([]);

      // Past it the stale answer is served once more while the refresh runs behind the caller...
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 1);
      expect(await service.buildCandidateList(MODEL)).toEqual([]);
      // ...and the request after that reads what the refresh found.
      expect(await service.buildCandidateList(MODEL)).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);
    });

    it('drops a model the node just failed on the very next request, not on the next TTL', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      expect(await service.buildCandidateList(MODEL)).toEqual([{ peerId: null, nodeFqdn: null, backend: 'ollama' }]);

      // The 500 is the strike that withholds the model; the backend says so, and its next
      // healthCheck reports the quarantine.
      ollama.noteServingFailure.mockReturnValue(true);
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL], unservableModels: [MODEL] });
      vi.mocked(global.fetch).mockResolvedValue(new Response('model failed to load', { status: 500 }));
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });

      expect(await service.buildCandidateList(MODEL)).toEqual([]);
    });

    it('keeps the snapshot across a serving verdict that changed nothing', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      await service.buildCandidateList(MODEL);
      // A first strike, or a success on a model that was never withheld: `unservableModels` is
      // what it was, so re-probing would only spend the request on a health check for nothing.
      ollama.noteServingFailure.mockReturnValue(false);
      vi.mocked(global.fetch).mockResolvedValue(new Response('model failed to load', { status: 500 }));
      await service.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res: createMockResponse() });
      ollama.healthCheck.mockClear();

      await service.buildCandidateList(MODEL);

      expect(ollama.healthCheck).not.toHaveBeenCalled();
    });

    it('probes live on every request at the default, which is 0 — the pre-snapshot build', async () => {
      expect(DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS).toBe(0);
      setPoolPreferences({ poolProbeSnapshotTtlMs: DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS });
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      await service.buildCandidateList(MODEL);
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['other:1b'] });

      expect(await service.buildCandidateList(MODEL)).toEqual([]);
      expect(ollama.healthCheck).toHaveBeenCalledTimes(2);
    });

    it('resolves the auto alias from the same snapshot placement ranks on', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      await service.buildCandidateList(MODEL);
      ollama.healthCheck.mockClear();

      expect(await service.resolveModelAlias(AUTO_MODEL)).toBe(MODEL);
      // Twelve probes per request used to be the cost of `auto`; the snapshot answers both reads.
      expect(ollama.healthCheck).not.toHaveBeenCalled();
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

    /**
     * The field report this came from: beta-max's `cihub pool log` showed four rows reading
     * `qwen3-coder:30b  -  1/14  30031  x failed`, which an operator reads as "placement returned
     * no candidate and then timed out" — nothing in the NODE column, and a duration suspiciously
     * close to a 30 s deadline. Placement had in fact succeeded: fourteen candidates were ranked,
     * the first was being tried, and the *caller* gave up 30 s later. Settling the row with a null
     * node threw away the one fact that distinguishes the two, and it is the same null the
     * dashboard buckets as `Unplaced`. Nothing else in the log tells them apart: `attempt` is 1 on
     * a hang-up and `candidates.length` when every candidate really did fail, which is far too
     * subtle to hang a diagnosis on.
     */
    it('keeps the node it was waiting on, so a hang-up cannot be read as "placement found nothing"', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
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

      // Local is first at the default affinity with nothing in flight, so this is the node that was
      // holding the request: named on the row, with the engine that had it.
      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'failed',
        status: null,
        node: LOCAL_CANDIDATE_KEY,
        peerId: null,
        backend: 'ollama',
        attempt: 1,
        candidates: 3,
        clientClosed: true,
      });
    });

    it('names the peer, not nothing, when the hang-up happened while a peer forward was in flight', async () => {
      // Local busier than the affinity margin, so the peer ranks first and is the node being tried.
      const peers = [peerServing('peer-a', MODEL, { inFlightRequests: 0 })];
      peerService.listConnectedPeers.mockResolvedValue(peers);
      peerService.getPeerById.mockImplementation(async (id) => peers.find((peer) => peer.id === id));
      peerService.peerAuthHeaders.mockResolvedValue({ Authorization: 'Bearer raw-token' });
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      loadService.acquire(LOCAL_CANDIDATE_KEY);
      const signals: AbortSignal[] = [];
      fetchThatWaitsForever(signals);
      const res = createMockResponse();

      const inFlight = service.proxyRequest({ path: '/api/chat', method: 'POST', body: { model: MODEL, stream: true }, model: MODEL, res });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      res.destroy();
      await inFlight;

      expect(routingLog.list()[0]).toMatchObject({
        outcome: 'failed',
        node: 'peer-a.tailxyz.ts.net',
        peerId: 'peer-a',
        backend: 'ollama',
        attempt: 1,
        clientClosed: true,
      });
    });

    /**
     * The counterpart, and the reason `clientClosed` is a field rather than a reading of `node`: a
     * request that genuinely exhausted every candidate settles with no node too, and that one IS a
     * routing failure. The flag is what separates the two on a row an operator is scanning.
     */
    it('still settles with no node, and without the flag, when every candidate really did fail', async () => {
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([]);
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      await service.proxyRequest({
        path: '/api/chat',
        method: 'POST',
        body: { model: MODEL, stream: true },
        model: MODEL,
        res: createMockResponse(),
      });

      expect(routingLog.list()[0]).toMatchObject({ outcome: 'failed', node: null, clientClosed: false, attempt: 1, candidates: 1 });
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

  // Every app's inference crosses `forward()` on its way to this node's engine, so it is where the
  // Hub's residency arbitration reaches apps that call the engine's native routes by tag.
  describe('residency arbitration before a local generation request', () => {
    const MODEL = 'llama3.2:3b';
    let router: MockProxy<InferenceRouterService>;
    let withRouter: PoolProxyService;

    beforeEach(() => {
      router = mock<InferenceRouterService>();
      router.prepareTrackedModel.mockResolvedValue(null);
      withRouter = new PoolProxyService(
        new InferenceBackendRegistry(ollama, vllm, lemonade, omlx),
        peerService,
        tailscaleService,
        loadService,
        configuration,
        routingLog,
        pressureService,
        // Three `undefined`s: `router` is appended after `modelRegistry`, `throughput` and the
        // local-health snapshot, because #1483 dropped the old router slot that used to sit before
        // them (see the note in `makeService`). Passing it positionally here would land it in the
        // model-registry slot.
        undefined,
        undefined,
        undefined,
        router,
      );
      ollama.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [MODEL] });
      peerService.listConnectedPeers.mockResolvedValue([]);
      vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ done: true }), { status: 200 }));
    });

    it('asks the router to prepare the model before /api/chat reaches the local engine', async () => {
      const res = createMockResponse();

      await withRouter.proxyRequest({ path: '/api/chat', method: 'POST', body: { model: MODEL, messages: [] }, model: MODEL, res });

      expect(router.prepareTrackedModel).toHaveBeenCalledWith(MODEL);
      expect(router.prepareTrackedModel.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(global.fetch).mock.invocationCallOrder[0]);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('still forwards when the arbitration itself fails: it is advice to the engine, not a gate', async () => {
      router.prepareTrackedModel.mockRejectedValue(new Error('registry unavailable'));
      const res = createMockResponse();

      await withRouter.proxyRequest({ path: '/v1/chat/completions', method: 'POST', body: { model: MODEL }, model: MODEL, res });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('does not arbitrate read-only natives, which never spend GPU time', async () => {
      const res = createMockResponse();

      await withRouter.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);

      expect(router.prepareTrackedModel).not.toHaveBeenCalled();
    });

    // Both halves of what #1483 brought in, together: a client hanging up aborts the upstream
    // engine, and arbitration is the most expensive step on this path — it is what loads or evicts
    // a model. Arbitrating for a request nobody is waiting for would reload a model for no one.
    it('does not arbitrate for a client that has already hung up', async () => {
      const res = createMockResponse();
      res.destroy();

      await withRouter.proxyRequest({ path: '/api/chat', method: 'POST', body: { model: MODEL, messages: [] }, model: MODEL, res });

      expect(router.prepareTrackedModel).not.toHaveBeenCalled();
    });

    // Every harness in this file builds the service positionally, and the router has already moved
    // once: it used to sit before the model registry, and #1483 removed that slot while #1497 added
    // another after it. A positional argument that lands on the wrong parameter is silent here —
    // the arbitration above simply stops happening and every other assertion still passes, because
    // a missing router is a legitimate configuration. `tsc` cannot catch it either: this package's
    // tsconfig excludes `**/__tests__`. So assert the shape itself.
    it('takes the router in the last constructor slot, so a new parameter cannot silently displace it', () => {
      const selfDeclared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PoolProxyService) ?? []) as Array<{
        index: number;
        param: { forwardRef?: () => unknown };
      }>;
      const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, PoolProxyService) ?? []) as number[];
      const lastSlot = PoolProxyService.length - 1;

      expect(selfDeclared.find((dep) => dep.index === lastSlot)?.param.forwardRef?.()).toBe(InferenceRouterService);
      expect(optional).toContain(lastSlot);
    });
  });
});
