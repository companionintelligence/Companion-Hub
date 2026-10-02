import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { BackendResidency, CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import { sameModelId } from '@/common/helpers/hub-pool';
import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY, type LocalGeneration, type LocalModelWork } from '@/modules/hub-pool/hub-pool-load.service';
import { InferenceController } from '../inference.controller';
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
 *
 * Given a capacity, the fake Ollama also arbitrates its own loads the way the scheduler does
 * (`processPending`): a load that does not fit beside a runner it has marked to expire waits for
 * that runner's request to end. Nothing does that across engines, which is what the cross-engine
 * cases are about.
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
  /** What this engine's own scheduler thinks it may fill; unset, it loads whatever it is asked to. */
  capacityMb: number | undefined;
  /** A load waiting, as Ollama's scheduler does, for an expiring runner's request to end. */
  waitingForRoom = false;
  private readonly released: Array<() => void> = [];

  constructor(private readonly loadSizesMb: Record<string, number>) {}

  /** The request a busy runner was serving ends; a runner marked to expire goes with it. */
  finish(id: string): void {
    const model = this.find(id);
    if (!model) return;
    model.refs = Math.max(0, model.refs - 1);
    if (model.refs === 0 && model.expireOnIdle) this.resident.delete(model.id);
    for (const wake of this.released.splice(0)) wake();
  }

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
        const size = this.loadSizesMb[id] ?? 1_000;
        while (this.capacityMb !== undefined && this.processMb() + size > this.capacityMb) {
          if (![...this.resident.values()].some((model) => model.expireOnIdle && model.refs > 0)) break;
          this.waitingForRoom = true;
          await new Promise<void>((wake) => this.released.push(wake));
        }
        this.waitingForRoom = false;
        this.loads.push(id);
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

/**
 * Lemonade 10.2.0 as far as these cases need it: it loads what it is told the moment it is told,
 * with no view of memory, and names what it holds without sizing it. Its peak is the card's: its
 * own models plus whatever Ollama holds at that moment.
 */
class FakeLemonade {
  readonly resident = new Map<string, number>();
  readonly installed = new Set<string>();
  readonly loads: string[] = [];
  peakMb = 0;

  constructor(
    private readonly loadSizesMb: Record<string, number>,
    private readonly ollama: FakeOllama,
  ) {}

  processMb(): number {
    return [...this.resident.values()].reduce((sum, mb) => sum + mb, 0);
  }

  /** A model already in memory, under the name 10.2.0 lists it by (`user.<id>` for one the Hub registered). */
  hold(id: string, processMb: number): void {
    this.installed.add(id);
    this.resident.set(id, processMb);
  }

  backend(): Record<string, unknown> {
    return {
      type: 'lemonade',
      getBaseUrl: () => 'http://fake-lemonade:13305',
      healthCheck: async () => ({ running: true, healthy: true, modelsLoaded: [...this.installed] }),
      // Either spelling, as the real backend's `residentRecordOf` matches.
      isModelLoaded: async (id: string) => [...this.resident.keys()].some((held) => held.replace(/^user\./, '') === id.replace(/^user\./, '')),
      loadModel: async (id: string) => {
        this.loads.push(id);
        this.resident.set(id, this.loadSizesMb[id] ?? 1_000);
        this.peakMb = Math.max(this.peakMb, this.ollama.processMb() + this.processMb());
      },
      unloadModel: async (id: string) => {
        this.resident.delete(id);
      },
      listResident: async (): Promise<BackendResidency> => ({
        backend: 'lemonade',
        source: 'measured',
        models: [...this.resident.keys()].map((id) => ({
          id,
          engineGpuBytes: null,
          totalBytes: null,
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

/**
 * A Strix Halo node, where models load into system RAM and the fit is capped by MemAvailable:
 * 125,781 MB total (core-7). `outsideEnginesMb` is what MemAvailable would read with every engine
 * empty; the apps, the OS and the page cache hold the rest. Like the real inspector, a read reuses
 * the last MemAvailable sample unless it asks for a fresh one (`freshRam`) or none has been taken.
 */
function strixHalo(outsideEnginesMb: number, engines: { processMb(): number }[]): HardwareInspectorService {
  const totalMb = 125_781;
  let sampleMb: number | null = null;
  return {
    getProfile: async (options?: { freshRam?: boolean }): Promise<HardwareProfile> => {
      if (sampleMb === null || options?.freshRam) {
        sampleMb = outsideEnginesMb - engines.reduce((sum, engine) => sum + engine.processMb(), 0);
      }
      return {
        gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 0, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
        npu: { available: false, model: '' },
        ram: { totalMb, availableMb: sampleMb, sampledAt: new Date().toISOString() },
        cpu: { arch: 'x86_64', cores: 32, model: 'Ryzen AI Max+ 395' },
        effectiveInferenceMemoryMb: sampleMb,
        tier: 'high',
      };
    },
  } as unknown as HardwareInspectorService;
}

function world(
  profile: HardwareProfile,
  ollama: FakeOllama,
  footprintsMb: Record<string, number>,
  options: { lemonade?: FakeLemonade; hardware?: HardwareInspectorService } = {},
) {
  const logger = mock<LoggerService>();
  const registry = new ModelRegistryService(logger);
  const lemonade = options.lemonade;
  const backends = new InferenceBackendRegistry(
    ollama.backend() as never,
    silent('vllm') as never,
    (lemonade?.backend() ?? silent('lemonade')) as never,
    silent('omlx') as never,
  );
  const residency = new ModelResidencyService(backends, logger);
  const sampler = {
    sampleVramByProcess: async () => {
      const used = ollama.processMb();
      const lemonadeUsed = lemonade?.processMb() ?? 0;
      return [
        ...(used > 0 ? [{ pid: 4101, processName: '/usr/local/lib/ollama/llama-server', vramMb: used }] : []),
        ...(lemonadeUsed > 0 ? [{ pid: 5202, processName: 'lemond', vramMb: lemonadeUsed }] : []),
      ];
    },
  } as unknown as GpuProcessSamplerService;
  const memory = new MemoryManagerService(logger, registry, backends, residency, sampler);
  const hardware = options.hardware ?? ({ getProfile: async () => structuredClone(profile) } as unknown as HardwareInspectorService);
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
    const row = registry.getCuratedModel(catalogId);
    (row?.backend === 'lemonade' && lemonade ? lemonade.installed : ollama.installed).add(row?.backendModelId ?? catalogId);
  };
  return { router, registry, poolLoad, delay, pulled, logger, residency, memory, puller, profile };
}

/** A model in memory that this Hub loaded itself, as `ModelPullerService.loadModel` records one. */
function hubLoaded(registry: ModelRegistryService, catalogId: string): void {
  registry.trackModel(catalogId, 'loaded');
  registry.markHubLoaded(catalogId);
}

describe('load arbitration on the fleet (REQ3, REQ4, R1, R2, R4, R5, R7)', () => {
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
      hubLoaded(w.registry, 'gemma4-e4b');
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'request', numCtx: null });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('gemma4:e4b is serving a request'), idleWouldFree: true });
      expect(ollama.unloads).toEqual([]);
    });

    // beta-red, 2026-10-01: gemma3:4b was loaded by Ollama for an app; the models page asked
    // `GET /models/tracked`, which recorded it `loaded`, and the next pool request for qwen3:8b evicted it.
    it('never evicts a model the models page only found resident (GET /models/tracked reconciles it to loaded)', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      const controller = Object.assign(Object.create(InferenceController.prototype), { residency: w.residency, modelRegistry: w.registry });

      const listed = await (controller as InferenceController).getTrackedModels();

      expect(listed.find((entry) => entry.catalogId === 'gemma4-e4b')?.state).toBe('loaded');
      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toBeNull();
      expect(ollama.unloads).toEqual([]);
      expect(ollama.resident.has('gemma4:e4b')).toBe(true);
    });

    it('evicts a model once the Hub loaded it itself, through the puller, whoever asked it to', async () => {
      const w = world(BETA_1, ollama, { 'gemma4-e4b': 6_640, 'qwen3-coder-30b': 19_000 });
      w.pulled('gemma4-e4b');
      w.pulled('qwen3-coder-30b');
      await expect(w.router.loadTrackedModel('gemma4-e4b', { origin: 'request', numCtx: null })).resolves.toEqual({ loaded: true });

      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3-coder:30b' });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
    });

    it('does not take a model the Hub adopted for one it loaded', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'gemma4-e4b': 6_640, 'qwen3-coder-30b': 19_000 });
      w.pulled('gemma4-e4b');
      w.pulled('qwen3-coder-30b');
      // A request for the resident model adopts it as loaded.
      await expect(w.router.prepareTrackedModel('gemma4:e4b')).resolves.toEqual({ backend: 'ollama', backendModelId: 'gemma4:e4b' });
      expect(w.registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');

      await expect(w.router.prepareTrackedModel('qwen3-coder:30b')).resolves.toBeNull();
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
      hubLoaded(w.registry, 'gemma4-e4b');
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
      hubLoaded(w.registry, 'gemma4-e4b');
      w.pulled('qwen3-8-27b');

      const outcome = await w.router.loadTrackedModel('qwen3-8-27b', { origin: 'request', numCtx: null });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 6640 MB') });
      expect(ollama.unloads).toEqual([]);
      expect(w.registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');
    });

    // S2 in the review of #1684: only generations were recorded, so the embedder Memory was
    // batch-embedding with was evictable, and Memory's next batch reloaded it cold.
    it('never evicts the embedder while an embedding batch is running on it — beta-red', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208, busy: true });
      ollama.hold('nomic-embed-text:latest', 900, { sizeVramMb: 300, busy: true });
      const w = world(BETA_RED, ollama, { 'qwen3-5-4b': 3_700 });
      hubLoaded(w.registry, 'gemma4-e4b');
      hubLoaded(w.registry, 'nomic-embed-text');
      w.pulled('qwen3-5-4b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);
      // Memory's `/api/embed` through the pool proxy, as the proxy records it.
      const memoryBatch: LocalModelWork = { backend: 'ollama', model: 'nomic-embed-text:latest' };
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, undefined, memoryBatch);

      const outcome = await w.router.loadTrackedModel('qwen3-5-4b', { origin: 'request', numCtx: null });

      expect(outcome).toEqual({
        loaded: false,
        reason: expect.stringContaining('gemma4:e4b, nomic-embed-text:latest are serving a request'),
        idleWouldFree: true,
      });
      expect(ollama.unloads).toEqual([]);
      expect(ollama.resident.get('nomic-embed-text:latest')?.expireOnIdle).toBe(false);
    });

    // S1 in the review of #1684: a request for a model already resident waited behind another
    // model's cold load (up to 120 s) only to be told it was resident.
    it("answers a model that is already resident at once, without queueing behind another model's cold load", async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-8-27b': 17_000 });
      w.pulled('qwen3-8-27b');
      w.pulled('gemma4-e4b');
      const engine = w.router as unknown as { backends: InferenceBackendRegistry };
      const ollamaEngine = engine.backends.get('ollama') as unknown as { loadModel: (id: string) => Promise<void> };
      const load = ollamaEngine.loadModel;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let coldLoadStarted = false;
      ollamaEngine.loadModel = async (id: string) => {
        if (id === 'qwen3.8:27b') {
          coldLoadStarted = true;
          await gate;
        }
        return load(id);
      };

      const cold = w.router.prepareTrackedModel('qwen3.8:27b');
      await vi.waitFor(() => expect(coldLoadStarted).toBe(true));
      const answered = await Promise.race([
        w.router.prepareTrackedModel('gemma4:e4b'),
        new Promise((resolve) => setTimeout(() => resolve('still queued behind qwen3.8:27b'), 1_000)),
      ]);
      expect(answered).toEqual({ backend: 'ollama', backendModelId: 'gemma4:e4b' });
      expect(w.registry.getTrackedModel('gemma4-e4b')?.state).toBe('loaded');

      release();
      await expect(cold).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3.8:27b' });
    });

    // REQ4, beta-red: the registry carries gemma4-e4b at its catalog 10,813 MB and `/api/ps` says
    // 3,208; the budget counted the runner's 5,550. Only the last makes the arithmetic close.
    it("sizes a Hub load by the engine's process figure, not the catalog's — beta-red, llama3.1:8b", async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      const w = world(BETA_RED, ollama, { 'llama3-1-8b': 8_592 });
      hubLoaded(w.registry, 'gemma4-e4b');
      w.pulled('llama3-1-8b');

      await expect(w.router.loadTrackedModel('llama3-1-8b', { origin: 'request', numCtx: null })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['llama3.1:8b']);
    });
  });

  describe("an operator's pin or load", () => {
    it('evicts an idle model an app loaded', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      await expect(w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
    });

    // Merging #1684 with #1686: the pin's load once planned its window as an operator's and evicted as
    // an app's request, so a REST pin could no longer clear what a REST load could. One origin decides both.
    it("pins by the same rule: the REST pin evicts an idle model an app loaded, an agent key's pin does not", async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const agent = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      agent.pulled('qwen3-coder-30b');

      await expect(agent.router.pinTrackedModel('qwen3-coder-30b', { origin: 'agent' })).resolves.toEqual({
        pinned: false,
        reason: expect.stringContaining('unloading every idle model the Hub loaded itself would free 0 MB'),
      });
      expect(ollama.unloads).toEqual([]);

      const operator = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      operator.pulled('qwen3-coder-30b');

      await expect(operator.router.pinTrackedModel('qwen3-coder-30b', { origin: 'operator' })).resolves.toEqual({ pinned: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
      expect(operator.registry.getTrackedModel('qwen3-coder-30b')?.pinned).toBe(true);
    });

    it('never evicts one that is generating, and says which', async () => {
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });

      expect(outcome).toEqual({
        loaded: false,
        reason:
          'qwen3-coder-30b needs 19000 MB but only 17408 MB is free, and unloading every idle unpinned model would free 0 MB; ' +
          'gemma4:e4b is serving a request and will not be unloaded',
        idleWouldFree: true,
      });
      expect(ollama.unloads).toEqual([]);
    });

    // beta-red, 2026-10-01: an unload followed 2 s later by a pin was refused 'needs 9694 MB but only
    // 1058 MB is free ... would free 0 MB' on an empty card; the same pin 7 s later was accepted.
    it('loads straight after an unload, without reading the card as it was before it', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'gemma4-e4b': 6_640, 'qwen3-coder-30b': 19_000 });
      w.pulled('gemma4-e4b');
      w.pulled('qwen3-coder-30b');
      // The budget the dashboard or the last request asked for, still inside its 5 s.
      expect((await w.memory.calculateBudget(w.profile)).modelUsedVramMb).toBe(6_640);

      await w.puller.unloadModel('gemma4-e4b');
      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
    });

    it('evicts it once the turn has ended', async () => {
      ollama.hold('gemma4:e4b', 6_640, { busy: true });
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');
      w.poolLoad.acquire(LOCAL_CANDIDATE_KEY, HERMES_TURN);
      w.poolLoad.release(LOCAL_CANDIDATE_KEY, HERMES_TURN);
      const gemma = ollama.resident.get('gemma4:e4b');
      if (gemma) gemma.refs = 0;

      await expect(w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' })).resolves.toEqual({ loaded: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
    });

    // REQ4 on beta-red, 2026-09-30: refused with "would free 3208 MB" (`/api/ps`), when evicting
    // gemma4 freed the 5,550 the budget had counted: 4,178 + 5,550 = 9,728 ≥ 8,592.
    it('makes room for llama3.1:8b beside an app-loaded gemma4:e4b on beta-red', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      const w = world(BETA_RED, ollama, { 'llama3-1-8b': 8_592 });
      w.pulled('llama3-1-8b');

      await expect(w.router.loadTrackedModel('llama3-1-8b', { origin: 'operator' })).resolves.toEqual({ loaded: true });

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
      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 6640 MB') });
      expect(ollama.unloads).toEqual([]);
    });

    // L1 after #1684/#1685/#1686, reproduced by the review of #1686 on this harness: Lemonade 10.2.0
    // lists the embedder the Hub registers as `user.nomic-embed-text-v1.5-GGUF`, the registry says
    // `nomic-embed-text-v1.5-GGUF`, and the pin was never matched to what Lemonade held.
    it('never evicts the pinned Lemonade embedder that 10.2.0 lists as user.<id> — beta-1', async () => {
      const lemonade = new FakeLemonade({ 'Gemma-4-E4B-it-GGUF': 23_900 }, ollama);
      lemonade.hold('user.nomic-embed-text-v1.5-GGUF', 300);
      const w = world(BETA_1, ollama, { 'gemma4-e4b-lemonade': 23_900 }, { lemonade });
      w.registry.trackModel('nomic-embed-text-v1-5-lemonade', 'loaded');
      w.registry.pinModel('nomic-embed-text-v1-5-lemonade');
      w.pulled('gemma4-e4b-lemonade');

      // 24,048 − 300 = 23,748 free: 152 MB short, and only the pinned embedder could cover it.
      const outcome = await w.router.loadTrackedModel('gemma4-e4b-lemonade', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 0 MB') });
      expect([...lemonade.resident.keys()]).toEqual(['user.nomic-embed-text-v1.5-GGUF']);
      expect(lemonade.loads).toEqual([]);
    });

    // R4: the embedder on the CPU has `size_vram` 0. It used to read as "unknown", which made the
    // plan optimistic: unload everything, then refuse anyway.
    it('treats a model on the CPU as freeing 0 MB, and refuses without unloading when that is all that is left', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      ollama.hold('nomic-embed-text:latest', 0, { sizeVramMb: 0 });
      const w = world(BETA_RED, ollama, { 'qwen3-5-9b': 9_800 });
      w.pulled('qwen3-5-9b');

      const outcome = await w.router.loadTrackedModel('qwen3-5-9b', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 5550 MB') });
      expect(ollama.unloads).toEqual([]);
    });

    it('unloads only the model that frees memory when the rest is on the CPU', async () => {
      ollama.hold('gemma4:e4b', 5_550, { sizeVramMb: 3_208 });
      ollama.hold('nomic-embed-text:latest', 0, { sizeVramMb: 0 });
      const w = world(BETA_RED, ollama, { 'qwen3-5-9b': 9_000 });
      w.pulled('qwen3-5-9b');

      await expect(w.router.loadTrackedModel('qwen3-5-9b', { origin: 'operator' })).resolves.toEqual({ loaded: true });
      expect(ollama.unloads).toEqual(['gemma4:e4b']);
    });

    // R7: the load of a never-downloaded model threw only after the eviction, as a 500.
    it('refuses a model that was never downloaded without unloading anything', async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });

      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: 'qwen3-coder-30b is not downloaded on this node; pull it first' });
      expect(ollama.unloads).toEqual([]);
      expect(ollama.loads).toEqual([]);
    });
  });

  // The review of #1684: once a plan had unloaded, the load went ahead even when the memory never came
  // back. Only an engine that waits for its own expiring runner makes that safe, and only for its own.
  describe('a load whose freed memory has not come back', () => {
    it('refuses a Lemonade load beside an Ollama model still busy with work the Hub cannot see — beta-1', async () => {
      // gpt-oss:20b is serving an app that calls Ollama directly: busy, and nothing in the pool's record.
      ollama.hold('gpt-oss:20b', 14_000, { busy: true });
      const lemonade = new FakeLemonade({ 'gpt-oss-20b-mxfp4-GGUF': 14_000 }, ollama);
      const w = world(BETA_1, ollama, { 'gpt-oss-20b-lemonade': 14_000 }, { lemonade });
      w.pulled('gpt-oss-20b-lemonade');

      const outcome = await w.router.loadTrackedModel('gpt-oss-20b-lemonade', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('gpt-oss:20b may still be finishing work the Hub cannot see') });
      expect(ollama.unloads).toEqual(['gpt-oss:20b']);
      expect(lemonade.loads).toEqual([]);
      // On dev before this, 14,000 + 14,000 = 28,000 MB on a 24,048 MB budget.
      expect(Math.max(ollama.peakMb, lemonade.peakMb)).toBeLessThanOrEqual(24_048);
    });

    it('loads an Ollama model once Ollama itself has waited out the busy runner it evicted — beta-1', async () => {
      ollama.hold('gpt-oss:20b', 14_000, { busy: true });
      ollama.capacityMb = 24_048;
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      const pending = w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });
      // The Hub has let the load through; Ollama holds it until the direct caller's request ends.
      await vi.waitFor(() => expect(ollama.waitingForRoom).toBe(true));
      expect(ollama.loads).toEqual([]);
      ollama.finish('gpt-oss:20b');

      await expect(pending).resolves.toEqual({ loaded: true });
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
      expect(ollama.peakMb).toBeLessThanOrEqual(24_048);
      expect(w.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ollama waits for it itself'));
    });

    // FIT-2: on unified memory the fit is capped by MemAvailable, and the re-measure reused the
    // sample from before the unload, so this load was refused although the eviction had made room.
    it('sees the memory an eviction freed on unified memory, and loads Lemonade beside nothing — Strix Halo', async () => {
      ollama.hold('qwen3.8:27b', 17_406);
      const lemonade = new FakeLemonade({ 'Qwen3.6-35B-A3B-GGUF': 30_000 }, ollama);
      // MemAvailable 27,594 with the 27B resident: 25,546 MB of headroom after the 2 GB reserve.
      const hardware = strixHalo(45_000, [ollama, lemonade]);
      const w = world(await hardware.getProfile(), ollama, { 'qwen3-6-35b-lemonade': 30_000 }, { lemonade, hardware });
      w.pulled('qwen3-6-35b-lemonade');

      await expect(w.router.loadTrackedModel('qwen3-6-35b-lemonade', { origin: 'operator' })).resolves.toEqual({ loaded: true });

      expect(ollama.unloads).toEqual(['qwen3.8:27b']);
      expect(lemonade.loads).toEqual(['Qwen3.6-35B-A3B-GGUF']);
    });
  });

  // L2 after #1684/#1686, reproduced by the review of #1686: the model stayed pinned (never an eviction
  // candidate), but the load that found it resident recorded it `loaded`, and the Hub UI, which reads
  // `state === 'pinned'`, showed it unpinned.
  describe('a pinned model that a later load finds in memory', () => {
    it('stays pinned when a request for it was queued behind its own pin — beta-1', async () => {
      const w = world(BETA_1, ollama, { 'qwen3-coder-30b': 19_000 });
      w.pulled('qwen3-coder-30b');

      const pin = w.router.pinTrackedModel('qwen3-coder-30b', { origin: 'operator' });
      const request = w.router.prepareTrackedModel('qwen3-coder:30b', { numCtx: null });

      await expect(pin).resolves.toEqual({ pinned: true });
      await expect(request).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3-coder:30b' });
      expect(ollama.loads).toEqual(['qwen3-coder:30b']);
      expect(w.registry.getTrackedModel('qwen3-coder-30b')).toMatchObject({ state: 'pinned', pinned: true });
    });

    it("stays pinned through an operator's load of it", async () => {
      ollama.hold('gemma4:e4b', 6_640);
      const w = world(BETA_1, ollama, {});
      w.registry.trackModel('gemma4-e4b', 'loaded');
      w.registry.pinModel('gemma4-e4b');

      await expect(w.router.loadTrackedModel('gemma4-e4b', { origin: 'operator' })).resolves.toEqual({ loaded: true });

      expect(w.registry.getTrackedModel('gemma4-e4b')).toMatchObject({ state: 'pinned', pinned: true });
      expect(ollama.loads).toEqual([]);
    });
  });

  // PIN-2 in the audit of #1679, and its live check 5: pin the embedder, restart the Hub, then make a
  // load need room. Ollama keeps the pinned embedder at keep_alive -1 through the restart; the new Hub
  // process used to know nothing of the pin and offered it to the eviction.
  describe('a pin across a Hub restart', () => {
    /** The first Hub process pins the embedder and goes away; the engines keep what they hold. */
    const pinThenRestart = async () => {
      ollama.hold('nomic-embed-text:latest', 308);
      ollama.hold('gemma4:e4b', 6_640);
      const before = world(BETA_1, ollama, {});
      before.registry.trackModel('nomic-embed-text', 'loaded');
      await expect(before.router.pinTrackedModel('nomic-embed-text', { origin: 'operator' })).resolves.toEqual({ pinned: true });
      await before.registry.pinsPersisted();

      const after = world(BETA_1, ollama, { 'qwen3-coder-30b': 23_900 });
      // What Nest runs at boot: the registry reads the pins (`onModuleInit`) before anything tracks a model.
      await after.registry.onModuleInit();
      after.pulled('qwen3-coder-30b');
      return after;
    };

    it('never evicts the pinned embedder the engine still holds, before the new process has tracked it', async () => {
      const w = await pinThenRestart();

      // 24,048 − 6,948 = 17,100 free; 23,900 needs 6,800 more: gemma4 frees 6,640, only the pin closes it.
      const outcome = await w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 6640 MB') });
      expect(ollama.unloads).toEqual([]);
      expect(ollama.resident.has('nomic-embed-text:latest')).toBe(true);
    });

    it('re-marks it pinned at boot, for the UI, the budget and the default model', async () => {
      const w = await pinThenRestart();

      await expect(w.router.readoptPinnedModels()).resolves.toEqual(['nomic-embed-text']);

      expect(w.registry.getTrackedModel('nomic-embed-text')).toMatchObject({ state: 'pinned', pinned: true });
      expect(w.registry.getEvictionCandidates()).toEqual([]);
      await expect(w.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' })).resolves.toMatchObject({ loaded: false });
      expect(ollama.unloads).toEqual([]);
    });

    it('does that from onApplicationBootstrap, without holding up the boot', async () => {
      const w = await pinThenRestart();

      expect(w.router.onApplicationBootstrap()).toBeUndefined();

      await vi.waitFor(() => expect(w.registry.getTrackedModel('nomic-embed-text')).toMatchObject({ state: 'pinned', pinned: true }));
      expect(w.logger.info).toHaveBeenCalledWith(expect.stringContaining('pinned again: nomic-embed-text'));
    });

    it('keeps the pin of a model the engine dropped, and pins it again when the Hub next loads it', async () => {
      const w = await pinThenRestart();
      // Ollama restarted too: it holds nothing it held before.
      ollama.resident.clear();

      await expect(w.router.readoptPinnedModels()).resolves.toEqual([]);
      expect(w.registry.getTrackedModel('nomic-embed-text')).toBeUndefined();
      expect(w.registry.isPinned('nomic-embed-text')).toBe(true);

      await expect(w.router.loadTrackedModel('nomic-embed-text', { origin: 'operator' })).resolves.toEqual({ loaded: true });
      expect(w.registry.getTrackedModel('nomic-embed-text')).toMatchObject({ state: 'pinned', pinned: true });
    });

    it('forgets it once the operator unpins it', async () => {
      const w = await pinThenRestart();
      w.registry.unpinModel('nomic-embed-text');
      await w.registry.pinsPersisted();

      const again = world(BETA_1, ollama, { 'qwen3-coder-30b': 23_900 });
      await again.registry.onModuleInit();
      again.pulled('qwen3-coder-30b');

      await expect(again.router.loadTrackedModel('qwen3-coder-30b', { origin: 'operator' })).resolves.toEqual({ loaded: true });
      // The embedder goes through its catalog row, under the catalog's name.
      expect(ollama.unloads).toEqual(['gemma4:e4b', 'nomic-embed-text']);
      expect(ollama.resident.has('nomic-embed-text:latest')).toBe(false);
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
