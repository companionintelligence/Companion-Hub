/**
 * The load path's context window, end to end on fleet numbers: the real router, memory manager,
 * residency service and catalog, against engines that behave as the fleet's do.
 *
 * Every scenario here was refused, mis-sized or double-loaded by the build that merged #1679
 * (dev 6c064c85d), as the audit of that PR reproduced against these same numbers:
 *
 * - beta-1 (RX 7900 XTX, 24,560 MB; 24,048 for models): an empty card refused qwen3.8:27b at 24,371 MB
 *   because the window was sized against the whole card and checked against the budget.
 * - beta-red (RTX 3080, 10,240 MB) and beta-3-glass (RTX 3070, 8,192 MB): gemma4:e4b, the fleet's
 *   default app model, was refused at the catalog's 10,813 MB while beta-red served it in 5,550 MiB.
 * - Lemonade saved a window below Hermes' 64000 floor while Hermes was still told 64000.
 * - An Ollama load the Hub made for a `/v1` request was at the Hub's window, so that very request
 *   reloaded it at Ollama's default.
 * - Lemonade's speech models were loaded with an 8192 ctx_size and charged 2 GB of KV cache.
 * - On unified memory, an eviction that worked was reported as a refusal: the re-measure reused
 *   the MemAvailable read before the unload.
 *
 * And, from the review of the fix itself:
 *
 * - gemma4:e4b still could not be pinned or loaded on a fresh 8 or 10 GB card: a measurement of it
 *   lived only in memory, so every Hub restart put the catalog's 10,813 MB back, and a card that had
 *   never served it could not get one.
 * - A Lemonade load sized its window to what was free beside an idle Ollama model, so beta-1 saved a
 *   window below Hermes' floor that an empty card holds.
 *
 * Geometry is `/api/show` `model_info` and sizes `/api/tags`, `/api/ps` and nvidia-smi/rocm-smi as
 * read on the fleet 2026-09-29 (Ollama 0.34.0).
 */
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { BackendResidency, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import { handoutContextLength } from '../app-model-handout';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { InferenceBackend } from '../backends/backend.interface';
import type { CloudFallbackService } from '../cloud-fallback.service';
import { probeLocalSizing } from '../context-cost.util';
import type { GpuProcessSamplerService } from '../gpu-process-sampler.service';
import type { HardwareInspectorService } from '../hardware-inspector.service';
import { InferenceRouterService } from '../inference-router.service';
import { MemoryManagerService, modelMemoryCeilingMb } from '../memory-manager.service';
import { estimateContextCost, parseModelGeometry } from '../model-geometry.util';
import type { ModelPullerService } from '../model-puller.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelResidencyService } from '../model-residency.service';

const MiB = 1024 * 1024;

/** `/api/show` `model_info` for gemma4:e4b, as the fleet's Ollama 0.34.0 returns it. */
const GEMMA4_E4B_INFO = {
  'general.architecture': 'gemma4',
  'gemma4.attention.head_count': 8,
  'gemma4.attention.head_count_kv': 2,
  'gemma4.attention.key_length': 512,
  'gemma4.attention.key_length_swa': 256,
  'gemma4.attention.shared_kv_layers': 18,
  'gemma4.attention.sliding_window': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.value_length_swa': 256,
  'gemma4.block_count': 42,
  'gemma4.context_length': 131072,
  'gemma4.embedding_length': 2560,
};
/** `/api/show` `model_info` for qwen3.8:27b (a `qwen35`: Ollama runs it on one slot). */
const QWEN38_27B_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.attention.head_count': 24,
  'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.block_count': 65,
  'qwen35.context_length': 262144,
  'qwen35.embedding_length': 5120,
  'qwen35.full_attention_interval': 4,
};
const OLLAMA_MODELS: Record<string, { info: Record<string, unknown>; tagBytes: number }> = {
  'gemma4:e4b': { info: GEMMA4_E4B_INFO, tagBytes: 9_608_350_718 },
  'qwen3.8:27b': { info: QWEN38_27B_INFO, tagBytes: 17_741_872_154 },
};

/** `gpuMb` below `psMb` is a model Ollama put partly in system RAM (`size_vram` < `size`). */
type Resident = { id: string; ctx: number; psMb: number; processMb: number; gpuMb?: number };

/**
 * Ollama as the scheduler behaves: a load with no `num_ctx` runs at `OLLAMA_CONTEXT_LENGTH`, and a
 * request at any other window than the resident one reloads the model (`num_ctx` is a load
 * parameter). Sizes of what the Hub loads come from `sizeOf`; what the fleet was measured holding
 * is put in place with `hold`.
 */
class FakeOllama {
  readonly type = 'ollama' as const;
  resident = new Map<string, Resident>();
  loads: { id: string; ctx: number }[] = [];

  constructor(
    private readonly defaultWindow: number,
    private readonly sizeOf: (id: string, ctx: number) => { psMb: number; processMb: number; gpuMb?: number } = () => ({
      psMb: 1000,
      processMb: 1500,
    }),
  ) {}

  hold(id: string, ctx: number, psMb: number, processMb: number): void {
    this.resident.set(id, { id, ctx, psMb, processMb });
  }

  /** An app's request reaching the engine: true when it had to (re)load the model. */
  request(id: string, numCtx: number | null): boolean {
    const runsAt = numCtx ?? this.defaultWindow;
    if (this.resident.get(id)?.ctx === runsAt) return false;
    this.load(id, runsAt);
    return true;
  }

  private load(id: string, ctx: number): void {
    this.loads.push({ id, ctx });
    this.resident.set(id, { id, ctx, ...this.sizeOf(id, ctx) });
  }

  processRows(): { pid: number; processName: string; vramMb: number }[] {
    return [...this.resident.values()].map((model, index) => ({
      pid: 1000 + index,
      processName: '/usr/local/lib/ollama/llama-server',
      vramMb: model.processMb,
    }));
  }

  backend(): Record<string, unknown> {
    return {
      type: this.type,
      getBaseUrl: () => 'http://fake-ollama:11434',
      healthCheck: async () => ({ running: true, healthy: true, modelsLoaded: [...Object.keys(OLLAMA_MODELS)] }),
      isModelLoaded: async (id: string) => this.resident.has(id),
      loadModel: async (id: string, options?: { contextLength?: number }) => this.load(id, options?.contextLength ?? this.defaultWindow),
      unloadModel: async (id: string) => {
        this.resident.delete(id);
      },
      contextCostForModel: async (id: string) => {
        const model = OLLAMA_MODELS[id];
        return model ? estimateContextCost({ geometry: parseModelGeometry(model.info), weightBytes: model.tagBytes }) : null;
      },
      listResident: async (): Promise<BackendResidency> => ({
        backend: 'ollama',
        source: 'measured',
        models: [...this.resident.values()].map((model) => ({
          id: model.id,
          engineGpuBytes: (model.gpuMb ?? model.psMb) * MiB,
          totalBytes: model.psMb * MiB,
          expiresAt: null,
          contextLength: model.ctx,
          quantization: null,
        })),
      }),
    };
  }
}

/** Lemonade: one saved window per model, no window per request, no per-model sizes. */
class FakeLemonade {
  readonly type = 'lemonade' as const;
  loads: { id: string; ctx: number | undefined }[] = [];

  backend(): Record<string, unknown> {
    return {
      type: this.type,
      getBaseUrl: () => 'http://fake-lemonade:13305',
      healthCheck: async () => ({ running: true, healthy: true, modelsLoaded: [] }),
      isModelLoaded: async () => false,
      loadModel: async (id: string, options?: { contextLength?: number }) => {
        this.loads.push({ id, ctx: options?.contextLength });
      },
      unloadModel: async () => undefined,
      weightsOnDiskMb: async () => null,
      listResident: async (): Promise<BackendResidency> => ({ backend: 'lemonade', source: 'measured', models: [] }),
    };
  }
}

const dead = (type: InferenceBackendType) => ({
  type,
  getBaseUrl: () => '',
  healthCheck: async () => ({ running: false, healthy: false, modelsLoaded: [] }),
});

const discrete = (vendor: string, model: string, vramMb: number): HardwareProfile => ({
  gpu: { available: true, vendor, model, vramMb, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 32_000, availableMb: 29_000, sampledAt: '2026-09-29T00:00:00.000Z' },
  cpu: { arch: 'x86_64', cores: 16, model: 'x' },
  effectiveInferenceMemoryMb: vramMb,
  tier: 'high',
});

const BETA_1 = discrete('amd', 'Radeon RX 7900 XTX', 24_560);
const BETA_RED = discrete('nvidia', 'GeForce RTX 3080', 10_240);
const BETA_3_GLASS = discrete('nvidia', 'GeForce RTX 3070', 8_192);

function world(opts: {
  profile: HardwareProfile;
  ollama?: FakeOllama;
  lemonade?: FakeLemonade;
  ollamaSlots?: number | null;
  installedApps?: string[];
  /** Unified memory: MemAvailable with nothing resident; the live reading subtracts what the engines hold. */
  freeWithNothingLoadedMb?: number;
}) {
  const logger = mock<LoggerService>();
  const ollama = opts.ollama ?? new FakeOllama(32_768);
  const lemonade = opts.lemonade ?? new FakeLemonade();
  const backends = new InferenceBackendRegistry(ollama.backend() as never, dead('vllm') as never, lemonade.backend() as never, dead('omlx') as never);
  const registry = new ModelRegistryService(logger);
  const sampler = { sampleVramByProcess: async () => ollama.processRows() } as unknown as GpuProcessSamplerService;
  const memoryManager = new MemoryManagerService(logger, registry, backends, new ModelResidencyService(backends, logger), sampler);

  // The inspector's live RAM sample is rate-limited: a caller gets the last sample unless it asks for a fresh one.
  const sampleRam = (): HardwareProfile => {
    const profile = structuredClone(opts.profile);
    if (opts.freeWithNothingLoadedMb !== undefined) {
      const held = [...ollama.resident.values()].reduce((sum, model) => sum + model.psMb, 0);
      profile.ram = { ...profile.ram, availableMb: opts.freeWithNothingLoadedMb - held, sampledAt: new Date().toISOString() };
      profile.effectiveInferenceMemoryMb = profile.ram.availableMb;
    }
    return profile;
  };
  let lastSample = sampleRam();
  const hardwareInspector = {
    getProfile: vi.fn(async (options?: { freshRam?: boolean }) => {
      if (options?.freshRam) lastSample = sampleRam();
      return structuredClone(lastSample);
    }),
  } as unknown as HardwareInspectorService;

  const engines = { ollama, lemonade } as const;
  const puller = {
    loadModel: vi.fn(async (catalogId: string, options?: { contextLength?: number }) => {
      const curated = registry.getCuratedModel(catalogId);
      if (!curated) throw new Error(`no ${catalogId}`);
      if (registry.getTrackedModel(catalogId)) registry.updateModelState(catalogId, 'loading');
      else registry.trackModel(catalogId, 'loading');
      const backend = backends.get(curated.backend);
      await backend.loadModel(curated.backendModelId, { embedding: curated.modality === 'embedding', contextLength: options?.contextLength });
      registry.updateModelState(catalogId, 'loaded');
    }),
    unloadModel: vi.fn(async (catalogId: string) => {
      const curated = registry.getCuratedModel(catalogId);
      if (!curated) throw new Error(`no ${catalogId}`);
      await backends.get(curated.backend).unloadModel(curated.backendModelId);
      registry.updateModelState(catalogId, 'pulled');
    }),
  } as unknown as ModelPullerService;
  const configuration = {
    getInferencePreferences: () => ({ maxNumCtx: null, ollamaSlots: opts.ollamaSlots ?? null, preferredModel: null }),
  } as unknown as ConfigurationService;
  const apps = { getApps: async () => (opts.installedApps ?? []).map((appName) => ({ appName })) } as unknown as AppsRepository;

  const router = new InferenceRouterService(
    logger,
    hardwareInspector,
    registry,
    memoryManager,
    mock<CloudFallbackService>(),
    backends,
    puller,
    configuration,
    apps,
  );
  vi.spyOn(router as unknown as { delay: (ms: number) => Promise<void> }, 'delay').mockResolvedValue(undefined);
  return { router, registry, memoryManager, logger, engines, hardwareInspector };
}

describe('the load window on the fleet', () => {
  it('loads qwen3.8:27b on an empty beta-1 at 16384 instead of refusing it', async () => {
    const ollama = new FakeOllama(65_536);
    const { router } = world({ profile: BETA_1, ollama });

    await expect(router.loadTrackedModel('qwen3-8-27b')).resolves.toEqual({ loaded: true });

    // 32768 is 24,371 MB with the vision reserve, over the 24,048 the card has for models; 16384 is 23,347.
    expect(ollama.loads).toEqual([{ id: 'qwen3.8:27b', ctx: 16_384 }]);
  });

  describe('gemma4:e4b, the fleet default app model, on 8 and 10 GB cards', () => {
    // beta-red, 2026-09-29: /api/ps 3,364,754,553 bytes at 16384; nvidia-smi 5,550 MiB; four slots.
    const servedOnBetaRed = (ollama: FakeOllama) => ollama.hold('gemma4:e4b', 16_384, 3209, 5550);

    it('loads on beta-red, where it was measured serving in 5,550 MiB, instead of being refused at the catalog 10,813 MB', async () => {
      const ollama = new FakeOllama(16_384);
      const { router, memoryManager } = world({ profile: BETA_RED, ollama, ollamaSlots: 4 });
      servedOnBetaRed(ollama);

      // Already resident: the load path takes it as it is.
      await expect(router.loadTrackedModel('gemma4-e4b')).resolves.toEqual({ loaded: true });
      expect(ollama.loads).toEqual([]);
      // The operator's pin was refused on the catalog figure before it ever reached the load path.
      await expect(memoryManager.canPinModel(BETA_RED, 10_813, { backend: 'ollama', backendModelId: 'gemma4:e4b' })).resolves.toEqual({
        canPin: true,
      });

      // It expires; the operator loads it again. Measured at 5,550 MiB at 16384, 32768 is charged
      // 5,550 + 16,384 × 0.09375 (gemma4's one-slot geometry already covers all four slots: core-2
      // holds it at 65536 on four in 3.4 GB) + the 1,024 MB vision reserve = 8,110, inside 9,728.
      ollama.resident.clear();
      memoryManager.invalidateObservation();
      await expect(router.loadTrackedModel('gemma4-e4b')).resolves.toEqual({ loaded: true });
      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 32_768 }]);
    });

    // Nothing resident, nothing measured, the Hub just started: the case every fleet roll produced.
    // The catalog's 10,813 MB is over either card, and only a load can say what the model takes.
    it.each([
      ['beta-red', BETA_RED],
      ['beta-3-glass', BETA_3_GLASS],
    ])('pins on a fresh %s: the load is tried and measured, not refused on the catalog figure', async (_node, profile) => {
      const ollama = new FakeOllama(16_384, () => ({ psMb: 3209, processMb: 5550 }));
      const { router, registry, memoryManager } = world({ profile, ollama, ollamaSlots: 4 });

      await expect(router.pinTrackedModel('gemma4-e4b')).resolves.toEqual({ pinned: true });

      // At the smallest window, since the estimate fits no window at all; nothing was evicted for it.
      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 4_096 }]);
      expect(registry.getTrackedModel('gemma4-e4b')?.state).toBe('pinned');
      // Measured as it landed, so the next fit check, pin and handout use 5,550 and not 10,813.
      await expect(memoryManager.footprintSighting(profile, 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 5550,
        contextLength: 4_096,
        source: 'process',
      });
    });

    it('loads on a fresh beta-3-glass through /models/load and MCP hub_load_model, which share the load path', async () => {
      const ollama = new FakeOllama(16_384, () => ({ psMb: 3209, processMb: 5550 }));
      const { router } = world({ profile: BETA_3_GLASS, ollama, ollamaSlots: 4 });

      await expect(router.loadTrackedModel('gemma4-e4b')).resolves.toEqual({ loaded: true });
      expect([...ollama.resident.keys()]).toEqual(['gemma4:e4b']);
    });

    it('keeps a tried model loaded but does not pin it when Ollama could not put it wholly on the card', async () => {
      // 12.4 GB in all, 7 GB of it on the 8 GB card: nothing says what the card itself must hold.
      const ollama = new FakeOllama(16_384, () => ({ psMb: 12_400, processMb: 7_100, gpuMb: 7_000 }));
      const { router, registry } = world({ profile: BETA_3_GLASS, ollama, ollamaSlots: 4 });

      const outcome = await router.pinTrackedModel('gemma4-e4b');

      expect(outcome).toMatchObject({ pinned: false, reason: expect.stringContaining('gemma4-e4b is loaded, but not pinned') });
      expect(registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');
    });

    it('does not try one while the operator has pinned another model on that Ollama, which could make room by unloading it', async () => {
      const ollama = new FakeOllama(16_384, () => ({ psMb: 3209, processMb: 5550 }));
      const { router, registry } = world({ profile: BETA_RED, ollama, ollamaSlots: 4 });
      registry.trackModel('gemma3-1b', 'loaded');
      registry.pinModel('gemma3-1b');

      await expect(router.loadTrackedModel('gemma4-e4b')).resolves.toMatchObject({ loaded: false });
      expect(ollama.loads).toEqual([]);
    });

    it('still refuses on the catalog where the engine would not place the model itself (Lemonade)', async () => {
      // gemma4-e4b-lemonade: 6,724 MB, the ladder's 0.25 MB/token and the vision reserve: 8,772 at 4096.
      const lemonade = new FakeLemonade();
      const { router } = world({ profile: BETA_3_GLASS, lemonade });

      await expect(router.loadTrackedModel('gemma4-e4b-lemonade')).resolves.toMatchObject({ loaded: false });
      expect(lemonade.loads).toEqual([]);
    });

    it('on the request path, forwards a never-measured model to the engine rather than trying the load itself', async () => {
      const ollama = new FakeOllama(16_384, () => ({ psMb: 3209, processMb: 5550 }));
      const { router, registry, memoryManager } = world({ profile: BETA_3_GLASS, ollama, ollamaSlots: 4 });
      registry.trackModel('gemma4-e4b', 'pulled');

      // Never seen here: only the catalog's 10,813 MB is known, over the 7,680 an 8 GB card has.
      // Refused on the request path, with nothing unloaded; the app's own request then loads it, at
      // the window it runs at, which a load by the Hub could only have guessed.
      await expect(router.prepareTrackedModel('gemma4:e4b', { numCtx: null })).resolves.toBeNull();
      expect(ollama.loads).toEqual([]);
      ollama.request('gemma4:e4b', null);
      memoryManager.invalidateObservation();
      await memoryManager.calculateBudget(BETA_3_GLASS);

      // Measured now. Expired, and loaded again by the operator: it fits.
      ollama.resident.clear();
      memoryManager.invalidateObservation();
      await expect(router.loadTrackedModel('gemma4-e4b')).resolves.toEqual({ loaded: true });
      expect(ollama.loads.at(-1)).toEqual({ id: 'gemma4:e4b', ctx: 16_384 });
    });
  });

  describe('what was measured survives a Hub restart', () => {
    it('sizes gemma4:e4b on beta-red from the measurement the last Hub process took, not from the catalog', async () => {
      const ollama = new FakeOllama(16_384, () => ({ psMb: 3209, processMb: 5550 }));
      ollama.hold('gemma4:e4b', 16_384, 3209, 5550);
      const before = world({ profile: BETA_RED, ollama, ollamaSlots: 4 });
      await before.memoryManager.calculateBudget(BETA_RED);
      await before.memoryManager.sightingsPersisted();

      // A fleet roll: a new Hub process, and the model expired from Ollama meanwhile.
      ollama.resident.clear();
      const after = world({ profile: BETA_RED, ollama, ollamaSlots: 4 });

      await expect(after.memoryManager.footprintSighting(BETA_RED, 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 5550,
        contextLength: 16_384,
        source: 'process',
      });
      await expect(after.router.pinTrackedModel('gemma4-e4b')).resolves.toEqual({ pinned: true });
      // The window the measurement allows (see above), where the catalog alone could only try 4096.
      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 32_768 }]);
    });

    it('does not carry a measurement over to other hardware', async () => {
      const ollama = new FakeOllama(16_384);
      ollama.hold('gemma4:e4b', 16_384, 3209, 5550);
      const before = world({ profile: BETA_RED, ollama, ollamaSlots: 4 });
      await before.memoryManager.calculateBudget(BETA_RED);
      await before.memoryManager.sightingsPersisted();

      ollama.resident.clear();
      const after = world({ profile: BETA_3_GLASS, ollama, ollamaSlots: 4 });
      await expect(after.memoryManager.footprintSighting(BETA_3_GLASS, 'ollama', 'gemma4:e4b')).resolves.toBeNull();
    });
  });

  describe("Lemonade's one saved window and Hermes' 64000-token floor", () => {
    it('loads gemma4-e4b-lemonade at 64000 on a 24 GB card with Hermes installed, where the handout alone said 32768', async () => {
      const lemonade = new FakeLemonade();
      const { router } = world({ profile: BETA_1, lemonade, installedApps: ['ci-hermes', 'ci-openclaw'] });

      await expect(router.loadTrackedModel('gemma4-e4b-lemonade')).resolves.toEqual({ loaded: true });

      expect(lemonade.loads).toEqual([{ id: 'Gemma-4-E4B-it-GGUF', ctx: 64_000 }]);
    });

    it('says so when the card cannot hold the floor, and loads at what it can', async () => {
      const lemonade = new FakeLemonade();
      const { router, logger } = world({ profile: discrete('nvidia', '12 GB card', 12_288), lemonade, installedApps: ['ci-hermes'] });

      await expect(router.loadTrackedModel('gemma4-e4b-lemonade')).resolves.toEqual({ loaded: true });

      // 64000, 32768 and 16384 are over the 11,776 MB; 8192 fits.
      expect(lemonade.loads).toEqual([{ id: 'Gemma-4-E4B-it-GGUF', ctx: 8_192 }]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('below the 64000-token floor of ci-hermes'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('an empty card here holds at most 8192 tokens of it'));
    });

    // beta-1, 2026-09-29: Ollama held gemma4:e4b idle at 16384 in 5,963 MiB (rocm-smi) while Lemonade
    // was asked for its own copy. What was free beside it held 32768 (15,940 MB of 17,408 free), and
    // that is what was saved, although the empty card holds 64000 (23,748 of 24,048).
    it('keeps the floor on beta-1 when an idle Ollama model holds the memory, and unloads that model for it', async () => {
      // Ollama's figure for it equals its process here, so the eviction plan can see what unloading it frees.
      const ollama = new FakeOllama(65_536);
      ollama.hold('gemma4:e4b', 16_384, 5963, 5963);
      const lemonade = new FakeLemonade();
      const { router, logger } = world({ profile: BETA_1, ollama, lemonade, installedApps: ['ci-hermes'] });

      await expect(router.loadTrackedModel('gemma4-e4b-lemonade')).resolves.toEqual({ loaded: true });

      expect(lemonade.loads).toEqual([{ id: 'Gemma-4-E4B-it-GGUF', ctx: 64_000 }]);
      expect([...ollama.resident.keys()]).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('below the 64000-token floor'));
    });

    it('goes below the floor only when what holds the card cannot be unloaded for it, and says that is why', async () => {
      const ollama = new FakeOllama(65_536);
      ollama.hold('gemma4:e4b', 16_384, 5963, 5963);
      const lemonade = new FakeLemonade();
      const { router, registry, logger } = world({ profile: BETA_1, ollama, lemonade, installedApps: ['ci-hermes'] });
      // The operator pinned the Ollama copy: nothing may unload it.
      registry.trackModel('gemma4-e4b', 'loaded');
      registry.pinModel('gemma4-e4b');

      await expect(router.loadTrackedModel('gemma4-e4b-lemonade')).resolves.toEqual({ loaded: true });

      expect(lemonade.loads).toEqual([{ id: 'Gemma-4-E4B-it-GGUF', ctx: 32_768 }]);
      expect([...ollama.resident.keys()]).toEqual(['gemma4:e4b']);
      const warning = logger.warn.mock.calls.map(([message]) => String(message)).find((message) => message.includes('64000-token floor'));
      expect(warning).toContain('an empty card here would hold the floor, but of the 5963 MB in use');
      expect(warning).not.toContain('all this node has room for');
    });

    it('applies no floor when no installed app has one', async () => {
      const lemonade = new FakeLemonade();
      const { router } = world({ profile: BETA_1, lemonade, installedApps: ['ci-openclaw'] });

      await router.loadTrackedModel('gemma4-e4b-lemonade');

      expect(lemonade.loads).toEqual([{ id: 'Gemma-4-E4B-it-GGUF', ctx: 32_768 }]);
    });
  });

  describe('a load an app request triggered', () => {
    // beta-max: Strix Halo, 114,701 MB free, OLLAMA_CONTEXT_LENGTH=32768, four slots. The Hub's own
    // window for gemma4:e4b there is 65536, so a load at it was reloaded by the next /v1 request.
    const BETA_MAX: HardwareProfile = {
      gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 124_124, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
      npu: { available: false, model: '' },
      ram: { totalMb: 124_124, availableMb: 114_701, sampledAt: '2026-09-29T00:00:00.000Z' },
      cpu: { arch: 'x86_64', cores: 32, model: 'AMD RYZEN AI MAX+ 395' },
      effectiveInferenceMemoryMb: 114_701,
      tier: 'high',
    };

    it('is made at the window the /v1 request runs at, so the request does not load it a second time', async () => {
      const ollama = new FakeOllama(32_768);
      const { router, registry } = world({ profile: BETA_MAX, ollama, ollamaSlots: 4 });
      registry.trackModel('gemma4-e4b', 'pulled');

      await expect(router.prepareTrackedModel('gemma4:e4b', { numCtx: null })).resolves.not.toBeNull();
      expect(ollama.request('gemma4:e4b', null)).toBe(false);

      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 32_768 }]);
    });

    it("is made at a native request's own num_ctx", async () => {
      const ollama = new FakeOllama(32_768);
      const { router, registry } = world({ profile: BETA_MAX, ollama, ollamaSlots: 4 });
      registry.trackModel('gemma4-e4b', 'pulled');

      await router.prepareTrackedModel('gemma4:e4b', { numCtx: 16_384 });
      expect(ollama.request('gemma4:e4b', 16_384)).toBe(false);

      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 16_384 }]);
    });

    it("keeps the Hub's own window for an operator's load, which no request names", async () => {
      const ollama = new FakeOllama(32_768);
      const { router } = world({ profile: BETA_MAX, ollama, ollamaSlots: 4 });

      await router.loadTrackedModel('gemma4-e4b');

      expect(ollama.loads).toEqual([{ id: 'gemma4:e4b', ctx: 65_536 }]);
    });
  });

  it("sends Lemonade's speech models no window and charges them no context", async () => {
    const lemonade = new FakeLemonade();
    const { router, memoryManager } = world({ profile: BETA_RED, lemonade });
    const fit = vi.spyOn(memoryManager, 'canFitModel');

    for (const id of ['kokoro-v1', 'whisper-base', 'whisper-large-v3-turbo']) {
      await expect(router.loadTrackedModel(id)).resolves.toEqual({ loaded: true });
    }

    expect(lemonade.loads.map((load) => load.ctx)).toEqual([undefined, undefined, undefined]);
    // Their catalog footprints, and nothing on top.
    expect(fit.mock.calls.map(([, footprintMb]) => footprintMb)).toEqual([350, 200, 1500]);
  });

  // Sized against the budget and charged per slot, the windows apps are handed on the unified-memory
  // nodes must not move: core-2 hands Hermes and OpenClaw 65536 for gemma4:e4b today.
  it.each([
    ['core-2', 103_309, 4],
    ['beta-max', 114_701, 4],
    ['core-7', 89_914, 2],
  ])('still hands out 65536 for gemma4:e4b and qwen3.8:27b on %s', async (_node, freeMb, slots) => {
    const profile: HardwareProfile = {
      gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 128_000, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
      npu: { available: false, model: '' },
      ram: { totalMb: 128_000, availableMb: freeMb, sampledAt: '2026-09-29T00:00:00.000Z' },
      cpu: { arch: 'x86_64', cores: 32, model: 'x' },
      effectiveInferenceMemoryMb: freeMb,
      tier: 'high',
    };
    const backend = new FakeOllama(65_536).backend() as unknown as InferenceBackend;
    const registry = new ModelRegistryService(mock<LoggerService>());
    for (const id of ['gemma4-e4b', 'qwen3-8-27b']) {
      const model = registry.getCuratedModel(id);
      if (!model) throw new Error(id);
      const sizing = await probeLocalSizing({ backendType: 'ollama', backend, model, profile, statedOllamaSlots: slots });
      const numCtx = handoutContextLength({ model, servedLocally: true, effectiveInferenceMemoryMb: modelMemoryCeilingMb(profile), ...sizing });
      expect({ id, numCtx }).toEqual({ id, numCtx: 65_536 });
    }
  });

  // gemma4's geometry counts its sliding-window layers as global: 6,144 MB of KV at 65536 for ONE slot,
  // while core-2 holds it at 65536 on four slots in 3.4 GB in all. Multiplied by four more, beta-1's
  // handout for it fell from 65536 to 16384 once the node stated its slots.
  it('still hands out 65536 for gemma4:e4b on beta-1 with four slots stated', async () => {
    const backend = new FakeOllama(65_536).backend() as unknown as InferenceBackend;
    const model = new ModelRegistryService(mock<LoggerService>()).getCuratedModel('gemma4-e4b');
    if (!model) throw new Error('gemma4-e4b');
    const sizing = await probeLocalSizing({ backendType: 'ollama', backend, model, profile: BETA_1, statedOllamaSlots: 4 });
    expect(sizing.kvSlots).toBe(1);
    expect(handoutContextLength({ model, servedLocally: true, effectiveInferenceMemoryMb: modelMemoryCeilingMb(BETA_1), ...sizing })).toBe(65_536);
  });

  it('on unified memory, re-measures free RAM after an eviction instead of reporting a successful one as a refusal', async () => {
    // core-7 (125,781 MB, CPU), with other processes holding enough that MemAvailable is 20 GB beside
    // opencode's qwen3.8:27b (17,406 MB). qwen3.8:27b can go; the new model needs it gone.
    const ollama = new FakeOllama(32_768, () => ({ psMb: 21_000, processMb: 0 }));
    ollama.hold('qwen3.8:27b', 65_536, 17_406, 0);
    const cpu: HardwareProfile = {
      gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
      npu: { available: false, model: '' },
      ram: { totalMb: 125_781, availableMb: 0, sampledAt: '2026-09-29T00:00:00.000Z' },
      cpu: { arch: 'x86_64', cores: 32, model: 'x' },
      effectiveInferenceMemoryMb: 0,
      tier: 'high',
    };
    const { router, engines } = world({ profile: cpu, ollama, freeWithNothingLoadedMb: 20_000 + 17_406 });

    // qwen3-coder-30b: 20,951 MB, no geometry here (the ladder), text only.
    await expect(router.loadTrackedModel('qwen3-coder-30b')).resolves.toEqual({ loaded: true });

    expect([...engines.ollama.resident.keys()]).toEqual(['qwen3-coder:30b']);
  });
});
