import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { BackendResidency, CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import { sameModelId } from '@/common/helpers/hub-pool';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY, type LocalGeneration } from '@/modules/hub-pool/hub-pool-load.service';
import { InferenceRouterService } from '../inference-router.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelResidencyService } from '../model-residency.service';
import { ModelPullerService } from '../model-puller.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { CloudFallbackService } from '../cloud-fallback.service';
import type { HardwareInspectorService } from '../hardware-inspector.service';
import type { GpuProcessSamplerService } from '../gpu-process-sampler.service';

/**
 * Load arbitration end to end, against the fleet's own numbers: the real router, memory manager,
 * registry (real catalog), residency service and puller, over an engine that unloads the way
 * Ollama's scheduler does — `keep_alive: 0` on a runner with a request in flight only marks it, and
 * it goes when that request ends (`server/sched.go`, `expireRunner`). The vendor tool reads the
 * runner's whole process, which is what the budget counts.
 *
 * Only the window a load is sized at is stubbed (`planLoad`): that sizing is its own subject, and
 * these cases are about what is unloaded to make room for a footprint, not what the footprint is.
 */

const MiB = 1024 * 1024;

type Resident = { id: string; processMb: number; sizeVramMb: number; refs: number; expireOnIdle: boolean };

class FakeOllama {
  readonly resident = new Map<string, Resident>();
  readonly installed = new Set<string>();
  readonly loads: string[] = [];
  readonly unloads: string[] = [];
  /** The most memory the runner ever held at once. */
  peakMb = 0;

  constructor(private readonly loadSizesMb: Record<string, number>) {}

  /** A model already in memory. `sizeVramMb` is what `/api/ps` says, when it differs from the process. */
  hold(id: string, processMb: number, options: { sizeVramMb?: number; busy?: boolean } = {}): void {
    this.installed.add(id);
    this.resident.set(id, { id, processMb, sizeVramMb: options.sizeVramMb ?? processMb, refs: options.busy ? 1 : 0, expireOnIdle: false });
    this.notePeak();
  }

  processMb(): number {
    return [...this.resident.values()].reduce((sum, model) => sum + model.processMb, 0);
  }

  private notePeak(): void {
    this.peakMb = Math.max(this.peakMb, this.processMb());
  }

  private find(id: string): Resident | undefined {
    return [...this.resident.values()].find((model) => sameModelId(model.id, id));
  }

  backend(): Record<string, unknown> {
    return {
      type: 'ollama',
      getBaseUrl: () => 'http://fake-ollama:11434',
      // Ollama's inventory is what is installed, resident or not.
      healthCheck: async () => ({ running: true, healthy: true, modelsLoaded: [...this.installed] }),
      isModelLoaded: async (id: string) => this.find(id) !== undefined,
      loadModel: async (id: string) => {
        this.loads.push(id);
        const size = this.loadSizesMb[id] ?? 1_000;
        this.resident.set(id, { id, processMb: size, sizeVramMb: size, refs: 0, expireOnIdle: false });
        this.notePeak();
      },
      unloadModel: async (id: string) => {
        this.unloads.push(id);
        const model = this.find(id);
        if (!model) return;
        if (model.refs > 0) model.expireOnIdle = true;
        else this.resident.delete(model.id);
      },
      listResident: async (): Promise<BackendResidency> => ({
        backend: 'ollama',
        source: 'measured',
        models: [...this.resident.values()].map((model) => ({
          id: model.id,
          engineGpuBytes: model.sizeVramMb * MiB,
          totalBytes: model.sizeVramMb * MiB,
          expiresAt: null,
          contextLength: null,
          quantization: null,
        })),
      }),
    };
  }
}

const silent = (type: InferenceBackendType) => ({
  type,
  getBaseUrl: () => '',
  healthCheck: async () => ({ running: false, healthy: false, modelsLoaded: [] }),
  ...(type === 'lemonade' ? { listResident: async (): Promise<BackendResidency> => ({ backend: 'lemonade', source: 'measured', models: [] }) } : {}),
});

const discrete = (vendor: 'amd' | 'nvidia', vramMb: number): HardwareProfile => ({
  gpu: { available: true, vendor, model: 'dGPU', vramMb, unifiedMemory: false, driverVersion: '', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 65_536, availableMb: 60_000 },
  cpu: { arch: 'x86_64', cores: 16, model: 'x' },
  effectiveInferenceMemoryMb: vramMb,
  tier: 'high',
});

/** beta-1: RX 7900 XTX, 24,560 MB — a 24,048 MB model budget. */
const BETA_1 = discrete('amd', 24_560);
/** beta-red: RTX 3080, 10,240 MB — a 9,728 MB model budget. */
const BETA_RED = discrete('nvidia', 10_240);

/** Hermes' turn on gemma4:e4b, as the pool proxy records it while it streams. */
const HERMES_TURN: LocalGeneration = { backend: 'ollama', model: 'gemma4:e4b', numCtx: 65_536 };

function world(profile: HardwareProfile, ollama: FakeOllama, footprintsMb: Record<string, number>) {
  const logger = mock<LoggerService>();
  const registry = new ModelRegistryService(logger);
  const backends = new InferenceBackendRegistry(
    ollama.backend() as never,
    silent('vllm') as never,
    silent('lemonade') as never,
    silent('omlx') as never,
  );
  const residency = new ModelResidencyService(backends, logger);
  const sampler = {
    sampleVramByProcess: async () => {
      const used = ollama.processMb();
      return used > 0 ? [{ pid: 4101, processName: '/usr/local/lib/ollama/llama-server', vramMb: used }] : [];
    },
  } as unknown as GpuProcessSamplerService;
  const memory = new MemoryManagerService(logger, registry, backends, residency, sampler);
  const hardware = { getProfile: async () => structuredClone(profile) } as unknown as HardwareInspectorService;
  const puller = new ModelPullerService(logger, registry, hardware, memory, mock<HostMetricsService>(), backends);
  const poolLoad = new HubPoolLoadService();
  const router = new InferenceRouterService(logger, hardware, registry, memory, mock<CloudFallbackService>(), backends, puller, undefined, poolLoad);
  const delay = vi.spyOn(router as unknown as { delay: (ms: number) => Promise<void> }, 'delay').mockResolvedValue(undefined);
  vi.spyOn(router as unknown as { planLoad: (curated: CuratedModel | undefined) => Promise<unknown> }, 'planLoad').mockImplementation(
    async (curated) => ({ contextLength: 16_384, footprintMb: footprintsMb[curated?.id ?? ''] ?? 0 }),
  );
  /** A model the Hub itself pulled since its last restart, so it is tracked and on disk. */
  const pulled = (catalogId: string) => {
    registry.trackModel(catalogId, 'pulled');
    ollama.installed.add(registry.getCuratedModel(catalogId)?.backendModelId ?? catalogId);
  };
  return { router, registry, poolLoad, delay, pulled };
}

describe('load arbitration on the fleet (REQ3, REQ4, R1, R4, R5, R7)', () => {
  let ollama: FakeOllama;

  beforeEach(() => {
    ollama = new FakeOllama({ 'qwen3-coder:30b': 19_000, 'qwen3.8:27b': 17_406, 'gemma4:e4b': 6_640, 'llama3.1:8b': 7_900 });
  });

  describe("an app's request (the pool proxy's prepareTrackedModel)", () => {
    it("never evicts gemma4:e4b while Hermes is streaming on it — beta-1, opencode's qwen3-coder:30b", async () => {
      // beta-1 live: gemma4:e4b resident, 6,640 MB by process, loaded by the apps and not the Hub.
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);

      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toBeNull();

      expect(ollama.unloads).toEqual([]);
      expect(ollama.resident.get('gemma4:e4b')?.expireOnIdle).toBe(false);
      // Refused at once: no nine-second settle wait on a request whose answer is "no".
      expect(w.delay).not.toHaveBeenCalled();
    });

    it('never evicts a model the Hub loaded while a generation is running on it', async () => {
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.registry.trackModel('gemma4-e4b', 'loaded');
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'request' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('gemma4:e4b is serving a request') });
      expect(ollama.unloads).toEqual([]);
    });

    it('never evicts a model an app loaded, even when it is idle', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toBeNull();
      expect(ollama.unloads).toEqual([]);
    });

    it('evicts an idle model the Hub loaded itself, then loads', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.registry.trackModel('gemma4-e4b', 'loaded');
      w.pulled('qwen3-coder-30b');

      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3-coder:30b' });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
      expect(w.registry.getTrackedModel('gemma4-e4b')?.state).toBe('pulled');
    });

    // REQ4, beta-1: counted at its catalog 10,813 MB, a Hub-tracked gemma4 looked like enough to make
    // room for qwen3.8:27b, was evicted, and the load was refused anyway. By the budget's own figure
    // it frees 6,640, which is not enough — so nothing should be unloaded.
    it("refuses without evicting when the Hub load's real size cannot cover the shortfall — beta-1, qwen3.8:27b", async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-8-27b': 24_371 });
      w.registry.trackModel('gemma4-e4b', 'loaded');
      w.pulled('qwen3-8-27b');

      const outcome = await w.router.loadTrackedModel('qwen3-8-27b', { scope: 'request' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 6640 MB') });
      expect(ollama.unloads).toEqual([]);
      expect(w.registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');
    });

    // REQ4, beta-red: the registry carries gemma4-e4b at its catalog 10,813 MB and `/api/ps` says
    // 3,208; the budget counted the runner's 5,550. Only the last makes the arithmetic close.
    it("sizes a Hub load by the engine's process figure, not the catalog's — beta-red, llama3.1:8b", async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      const w = world(BETA_RED, ollama, { 'llama3-1-8b': 8_592 });
      w.registry.trackModel('gemma4-e4b', 'loaded');
      w.pulled('llama3-1-8b');

      await expect(w.router.loadTrackedModel('llama3-1-8b', { scope: 'request' })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['llama3.1:8b']);
    });
  });

  describe("an operator's pin or load", () => {
    it('evicts an idle model an app loaded', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      await expect(w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'operator' })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
    });

    it('never evicts one that is generating, and says which', async () => {
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'operator' });

      expect(outcome).toEqual({
        loaded: false,
        reason:
          'qwen3-coder-30b needs 19000 MB but only 17408 MB is free, and unloading every idle unpinned model would free 0 MB; ' +
          'gemma4:e4b is serving a request and will not be unloaded',
      });
      expect(ollama.unloads).toEqual([]);
    });

    it('evicts it once the turn has ended', async () => {
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);
      w.poolLoad.release(LOCAL_CANDIDATE_KEY, HERMES_TURN);
      const gemma = ollama.resident.get('gemma4:e4b');
      if (gemma) gemma.refs = 0;

      await expect(w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'operator' })).resolves.toEqual({ loaded: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
    });

    // REQ4 on beta-red, 2026-09-30: refused with "would free 3208 MB" (`/api/ps`), when evicting
    // gemma4 freed the 5,550 the budget had counted: 4,178 + 5,550 = 9,728 ≥ 8,592.
    it('makes room for llama3.1:8b beside an app-loaded gemma4:e4b on beta-red', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      const w = world(BETA_RED, ollama, { 'llama3-1-8b': 8_592 });
      w.pulled('llama3-1-8b');

      await expect(w.router.loadTrackedModel('llama3-1-8b', { scope: 'operator' })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['llama3.1:8b']);
      expect(ollama.peakMb).toBeLessThanOrEqual(9_728);
    });

    // R1: `/api/ps` lists the embedder as `nomic-embed-text:latest`; the pin says `nomic-embed-text`.
    it('never evicts the pinned embedder the engine spells nomic-embed-text:latest', async () => {
      ollama.hold('nomic-embed-text:latest', 308);
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 23_900 });
      w.registry.trackModel('nomic-embed-text', 'loaded');
      w.registry.pinModel('nomic-embed-text');
      w.pulled('qwen3-coder-30b');

      // 24,048 − 6,948 = 17,100 free; 23,900 needs 6,800 more. gemma4 frees 6,640; only the pinned
      // embedder's 308 would close the gap.
      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 6640 MB') });
      expect(ollama.unloads).toEqual([]);
    });

    // R4: the embedder on the CPU has `size_vram` 0. It used to read as "unknown", which made the
    // plan optimistic: unload everything, then refuse anyway.
    it('treats a model on the CPU as freeing 0 MB, and refuses without unloading when that is all that is left', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      ollama.hold('nomic-embed-text:latest', 0, { sizeVramMb: 0 });
      const w = world(BETA_RED, ollama, { 'qwen3-5-9b': 9_800 });
      w.pulled('qwen3-5-9b');

      const outcome = await w.router.loadTrackedModel('qwen3-5-9b', { scope: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 5550 MB') });
      expect(ollama.unloads).toEqual([]);
    });

    it('unloads only the model that frees memory when the rest is on the CPU', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      ollama.hold('nomic-embed-text:latest', 0, { sizeVramMb: 0 });
      const w = world(BETA_RED, ollama, { 'qwen3-5-9b': 9_000 });
      w.pulled('qwen3-5-9b');

      await expect(w.router.loadTrackedModel('qwen3-5-9b', { scope: 'operator' })).resolves.toEqual({ loaded: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
    });

    // R7: the load of a never-downloaded model threw only after the eviction, as a 500.
    it('refuses a model that was never downloaded without unloading anything', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { scope: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: 'qwen3-coder-30b is not downloaded on this node; pull it first' });
      expect(ollama.unloads).toEqual([]);
      expect(ollama.loads).toEqual([]);
    });
  });

  // R5: concurrent loads planned against the same cached reading and both went ahead.
  describe('concurrent loads', () => {
    it('run one at a time, so the second plans around the first — beta-1', async () => {
      const w = world(BETA_1, ollama, { 'gemma4-e4b': 6_640, 'qwen3-8-27b': 18_500 });
      w.pulled('gemma4-e4b');
      w.pulled('qwen3-8-27b');

      const [gemma, qwen] = await Promise.all([w.router.prepareTrackedModel('gemma4:e4b'), w.router.prepareTrackedModel('qwen3.8:27b')]);

      expect(gemma).not.toBeNull();
      expect(qwen).not.toBeNull();
      // The second saw the first resident and made room for itself, instead of loading on top.
      expect(ollama.loads).toEqual(['gemma4:e4b', 'qwen3.8:27b']);
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.peakMb).toBeLessThanOrEqual(24_048);
    });

    it('load one model once, however many requests arrive for it together', async () => {
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      await Promise.all([w.router.prepareTrackedModel('qwen3-coder:30b'), w.router.prepareTrackedModel('qwen3-coder:30b')]);

      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
    });
  });
});
