import { Test, type TestingModule } from '@nestjs/testing';
import { MemoryManagerService, modelMemoryCeilingMb } from '../memory-manager.service';
import { readFootprintSightings } from '../footprint-sighting-record';
import { CURATED_MODELS } from '../catalog/curated-models';
import { ModelRegistryService } from '../model-registry.service';
import { ModelResidencyService } from '../model-residency.service';
import { GpuProcessSamplerService } from '../gpu-process-sampler.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { InferenceBackend } from '../backends/backend.interface';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BackendHealthStatus, BackendResidency, HardwareProfile, InferenceBackendType, ResidentModel, TrackedModel } from '@ci-hub/common/types';

const MiB = 1024 * 1024;

describe('MemoryManagerService', () => {
  let service: MemoryManagerService;
  let loggerService: MockProxy<LoggerService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let residency: MockProxy<ModelResidencyService>;
  let gpuSampler: MockProxy<GpuProcessSamplerService>;
  let backendRegistry: MockProxy<InferenceBackendRegistry>;
  /** The health each engine WITHOUT `listResident` answers with; the rest are never health-checked. */
  let health: Partial<Record<InferenceBackendType, BackendHealthStatus>>;

  const makeProfile = (overrides: Partial<HardwareProfile> = {}): HardwareProfile => ({
    gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '535', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: 65536, availableMb: 32768 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
    ...overrides,
  });

  const resident = (id: string, over: Partial<ResidentModel> = {}): ResidentModel => ({
    id,
    engineGpuBytes: null,
    totalBytes: null,
    expiresAt: null,
    contextLength: null,
    quantization: null,
    ...over,
  });

  const nothingResident = (): BackendResidency[] => [
    { backend: 'ollama', source: 'measured', models: [] },
    { backend: 'vllm', source: 'unsupported', models: null },
    { backend: 'lemonade', source: 'measured', models: [] },
    { backend: 'omlx', source: 'unsupported', models: null },
  ];

  const reportResidency = (entries: BackendResidency[]) => {
    residency.getReport.mockResolvedValue({ backends: entries, residentCount: 0, sampledAt: '2026-09-20T00:00:00.000Z' });
  };

  const tracked = (over: Partial<TrackedModel> & { catalogId: string }): TrackedModel => ({
    backend: 'ollama',
    backendModelId: over.catalogId,
    state: 'loaded',
    pinned: false,
    memoryUsedMb: 0,
    lastUsedAt: 100,
    requestCount: 1,
    ...over,
  });

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    modelRegistry = mock<ModelRegistryService>();
    residency = mock<ModelResidencyService>();
    gpuSampler = mock<GpuProcessSamplerService>();
    backendRegistry = mock<InferenceBackendRegistry>();
    health = {};

    modelRegistry.getLoadedModels.mockReturnValue([]);
    modelRegistry.getEvictionCandidates.mockReturnValue([]);
    reportResidency(nothingResident());
    gpuSampler.sampleVramByProcess.mockResolvedValue([]);

    // Ollama and Lemonade answer residency; the other four only ever answer a health check.
    const withResidency: InferenceBackendType[] = ['ollama', 'lemonade'];
    backendRegistry.entries.mockImplementation(() =>
      (['ollama', 'vllm', 'lemonade', 'omlx'] as InferenceBackendType[]).map((type) => {
        const backend = {
          type,
          healthCheck: vi.fn(async () => health[type] ?? { running: false, healthy: false, modelsLoaded: [] }),
          ...(withResidency.includes(type) ? { listResident: vi.fn() } : {}),
        } as unknown as InferenceBackend;
        return [type, backend] as const;
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryManagerService,
        { provide: LoggerService, useValue: loggerService },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelResidencyService, useValue: residency },
        { provide: GpuProcessSamplerService, useValue: gpuSampler },
        { provide: InferenceBackendRegistry, useValue: backendRegistry },
      ],
    }).compile();

    service = module.get<MemoryManagerService>(MemoryManagerService);
  });

  // ─── S-MEM-1: Memory Budget ────────────────────────────────────────

  describe('Memory budget (MEM-1)', () => {
    it('S-MEM-1.1: SHALL reserve system overhead (default 2 GB)', async () => {
      const budget = await service.calculateBudget(makeProfile());
      expect(budget.systemReservedRamMb).toBe(2048);
    });

    it('S-MEM-1.2: SHALL account for running app containers', async () => {
      service.setRunningAppCount(3);
      const budget = await service.calculateBudget(makeProfile());
      expect(budget.dockerOverheadMb).toBe(1500); // 3 * 500
    });

    it('S-MEM-1.3: SHALL recalculate when apps start/stop', async () => {
      service.setRunningAppCount(2);
      const budget1 = await service.calculateBudget(makeProfile());

      service.setRunningAppCount(5);
      const budget2 = await service.calculateBudget(makeProfile());

      expect(budget2.dockerOverheadMb).toBeGreaterThan(budget1.dockerOverheadMb);
    });

    it('should compute VRAM budget for discrete GPU', async () => {
      const budget = await service.calculateBudget(makeProfile());
      expect(budget.totalVramMb).toBe(24576);
      expect(budget.modelBudgetVramMb).toBe(24064); // 24576 - 512 reserved
    });

    it('should compute RAM-only budget for unified memory', async () => {
      const profile = makeProfile({
        gpu: { available: true, vendor: 'apple', model: 'M4 Max', vramMb: 0, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
      });
      const budget = await service.calculateBudget(profile);
      expect(budget.totalVramMb).toBe(0);
      expect(budget.modelBudgetRamMb).toBeGreaterThan(0);
    });
  });

  // ─── Live usage ───────────────────────────────────────────────────
  //
  // The figures the fleet actually showed. Every case here is one the registry-only budget got
  // wrong by reading 0: on beta-red the router had loaded nothing while nvidia-smi held 9 of 10
  // GiB for an Ollama runner and an out-of-band vLLM.

  describe('used memory comes from the engines, not the registry', () => {
    it('discrete GPU: counts an Ollama-loaded model the registry never heard of, from the runner nvidia-smi sees', async () => {
      // gemma4:e4b as beta-red held it — loaded by pool traffic, so not tracked. /api/ps planned
      // 1,533 MiB for it; the runner process held 2,926 MiB. The measurement wins.
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 1533 * MiB, totalBytes: 4200 * MiB })] },
      ]);
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 4101, processName: '/usr/local/lib/ollama/llama-server', vramMb: 2926 }]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(2926);
      expect(budget.modelUsedRamMb).toBe(0);
      expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 2926, source: 'process' }]);
      expect(modelRegistry.getLoadedModels).toHaveBeenCalled();
    });

    it("discrete GPU: falls back to /api/ps size_vram when nothing measured Ollama's runner", async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 1533 * MiB, totalBytes: 4200 * MiB })] },
      ]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(1533);
      expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 1533, source: 'engine' }]);
    });

    describe('a bare `llama-server`, as rocm-smi reports both Ollama and Lemonade runners', () => {
      const amd = () =>
        makeProfile({
          gpu: {
            available: true,
            vendor: 'amd',
            model: 'Radeon 8060S',
            vramMb: 2048,
            unifiedMemory: true,
            driverVersion: '',
            runtimeAvailable: true,
          },
        });
      const ollamaHolding = (): BackendResidency => ({
        backend: 'ollama',
        source: 'measured',
        models: [resident('qwen3:9b', { engineGpuBytes: 7319 * MiB, totalBytes: 7319 * MiB })],
      });
      const lemonadeHolding = (): BackendResidency => ({ backend: 'lemonade', source: 'measured', models: [resident('Qwen3-0.6B-GGUF')] });

      it('is Ollama when only Ollama holds a model', async () => {
        reportResidency([...nothingResident().filter((entry) => entry.backend !== 'ollama'), ollamaHolding()]);
        gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 7001, processName: 'llama-server', vramMb: 8100 }]);

        const budget = await service.calculateBudget(amd());

        expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['qwen3:9b'], pool: 'ram', usedMb: 8100, source: 'process' }]);
      });

      it('is Lemonade when only Lemonade holds a model', async () => {
        reportResidency([...nothingResident().filter((entry) => entry.backend !== 'lemonade'), lemonadeHolding()]);
        gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 7002, processName: 'llama-server', vramMb: 900 }]);

        const budget = await service.calculateBudget(amd());

        expect(budget.usage.backends).toEqual([{ backend: 'lemonade', models: ['Qwen3-0.6B-GGUF'], pool: 'ram', usedMb: 900, source: 'process' }]);
      });

      it('is claimed by neither when both hold a model: Ollama keeps its own figure, Lemonade is a floor', async () => {
        reportResidency([
          ...nothingResident().filter((entry) => entry.backend !== 'ollama' && entry.backend !== 'lemonade'),
          ollamaHolding(),
          lemonadeHolding(),
        ]);
        gpuSampler.sampleVramByProcess.mockResolvedValue([
          { pid: 7001, processName: 'llama-server', vramMb: 8100 },
          { pid: 7002, processName: 'llama-server', vramMb: 900 },
        ]);

        const budget = await service.calculateBudget(amd());

        expect(budget.modelUsedRamMb).toBe(7319);
        expect(budget.usage.backends).toEqual([
          { backend: 'ollama', models: ['qwen3:9b'], pool: 'ram', usedMb: 7319, source: 'engine' },
          { backend: 'lemonade', models: ['Qwen3-0.6B-GGUF'], pool: 'ram', usedMb: null, source: 'unmeasured' },
        ]);
      });

      it('never lets a path that names another engine be read as a bare runner', async () => {
        // A manual llama.cpp on the host (beta-nas runs one): its path names neither engine.
        reportResidency([...nothingResident().filter((entry) => entry.backend !== 'ollama'), ollamaHolding()]);
        gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 7003, processName: '/home/ci/llama.cpp/build/bin/llama-server', vramMb: 5000 }]);

        const budget = await service.calculateBudget(amd());

        expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['qwen3:9b'], pool: 'ram', usedMb: 7319, source: 'engine' }]);
      });
    });

    it('unified memory: counts Ollama /api/ps `size` against RAM and leaves VRAM at zero', async () => {
      const profile = makeProfile({
        gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 2048, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
        ram: { totalMb: 131_072, availableMb: 60_000 },
      });
      // The beta-max reading: `size_vram` 3.5x the card's VRAM because most of it is GTT-backed
      // host RAM. On a unified node the whole allocation is RAM, and `size` is the number.
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('qwen3:9b', { engineGpuBytes: 7319 * MiB, totalBytes: 7319 * MiB })] },
      ]);

      const budget = await service.calculateBudget(profile);

      expect(budget.totalVramMb).toBe(0);
      expect(budget.modelUsedVramMb).toBe(0);
      expect(budget.modelUsedRamMb).toBe(7319);
      expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['qwen3:9b'], pool: 'ram', usedMb: 7319, source: 'engine' }]);
    });

    it('vLLM healthy with a per-process sample: counts the EngineCore process as measured VRAM', async () => {
      health.vllm = { running: true, healthy: true, modelsLoaded: ['Qwen/Qwen2.5-3B-Instruct-AWQ'] };
      // nvidia-smi on beta-red: the engine core holds the weights, the desktop holds 22 MiB.
      gpuSampler.sampleVramByProcess.mockResolvedValue([
        { pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 },
        { pid: 286138, processName: '/usr/bin/baobab', vramMb: 22 },
      ]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(6104);
      expect(budget.usage.backends).toEqual([
        { backend: 'vllm', models: ['Qwen/Qwen2.5-3B-Instruct-AWQ'], pool: 'vram', usedMb: 6104, source: 'process' },
      ]);
      expect(gpuSampler.sampleVramByProcess).toHaveBeenCalledWith('nvidia');
    });

    it('vLLM healthy with no sample: reports the backend resident and unmeasured, never as 0 used', async () => {
      health.vllm = { running: true, healthy: true, modelsLoaded: ['Qwen/Qwen2.5-3B-Instruct-AWQ'] };
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(0);
      expect(budget.usage.backends).toEqual([
        { backend: 'vllm', models: ['Qwen/Qwen2.5-3B-Instruct-AWQ'], pool: 'vram', usedMb: null, source: 'unmeasured' },
      ]);
    });

    it('rocm-smi truncates the process title, and the match still lands', async () => {
      const profile = makeProfile({
        gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 2048, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
      });
      health.vllm = { running: true, healthy: true, modelsLoaded: ['Qwen/Qwen3.5-9B'] };
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 9399, processName: 'VLLM::EngineCor', vramMb: 314 }]);

      const budget = await service.calculateBudget(profile);

      expect(budget.modelUsedRamMb).toBe(314);
      expect(budget.usage.backends.map((entry) => [entry.backend, entry.usedMb, entry.source])).toEqual([['vllm', 314, 'process']]);
    });

    it('an engine that is up but holds nothing contributes no row at all', async () => {
      health.vllm = { running: true, healthy: true, modelsLoaded: [] };
      const budget = await service.calculateBudget(makeProfile());
      expect(budget.usage.backends).toEqual([]);
    });

    it('an engine that is down leaves the registry to stand in for what the Hub loaded there', async () => {
      // Ollama is unreachable; the Hub's own bookkeeping says it loaded one model. That is the
      // only reading left, and the row says it is bookkeeping rather than a measurement.
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'unreachable', models: null, error: 'ECONNREFUSED' },
      ]);
      modelRegistry.getLoadedModels.mockReturnValue([tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 5000 })]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(5000);
      expect(budget.usage.backends).toEqual([{ backend: 'ollama', models: ['gemma4:e4b'], pool: 'vram', usedMb: 5000, source: 'registry' }]);
    });

    it('a live reading wins over the registry when both have an opinion, so nothing is counted twice', async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 1533 * MiB, totalBytes: 4200 * MiB })] },
      ]);
      modelRegistry.getLoadedModels.mockReturnValue([tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 5000 })]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(1533);
    });

    it('Lemonade names its resident models without sizing them, so it is measured per process or not at all', async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'lemonade'),
        { backend: 'lemonade', source: 'measured', models: [resident('Qwen3-0.6B-GGUF')] },
      ]);

      const unmeasured = await service.calculateBudget(makeProfile());
      expect(unmeasured.usage.backends).toEqual([
        { backend: 'lemonade', models: ['Qwen3-0.6B-GGUF'], pool: 'vram', usedMb: null, source: 'unmeasured' },
      ]);

      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 4242, processName: '/usr/lib/lemonade-server/llama-server', vramMb: 900 }]);
      // A fresh service, because the previous sweep is still inside its TTL.
      const fresh = await freshService();
      const measured = await fresh.calculateBudget(makeProfile());
      expect(measured.usage.backends).toEqual([{ backend: 'lemonade', models: ['Qwen3-0.6B-GGUF'], pool: 'vram', usedMb: 900, source: 'process' }]);
    });

    it('pinned stays the registry figure: only the router pins, so only it knows', async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 1533 * MiB, totalBytes: 4200 * MiB })] },
      ]);
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', state: 'pinned', pinned: true, memoryUsedMb: 5000 }),
      ]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.pinnedVramMb).toBe(5000);
      expect(budget.modelUsedVramMb).toBe(1533);
    });

    it('invalidating drops a sweep already under way, so an unload is never answered with what began before it', async () => {
      const before = [
        {
          backend: 'ollama' as const,
          source: 'measured' as const,
          models: [resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553 })],
        },
      ];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      residency.getReport.mockImplementationOnce(async () => {
        await gate;
        return { backends: [...before, ...nothingResident().filter((entry) => entry.backend !== 'ollama')], residentCount: 1, sampledAt: 'x' };
      });
      const stale = service.calculateBudget(makeProfile());
      await vi.waitFor(() => expect(residency.getReport).toHaveBeenCalledTimes(1));

      // The model is unloaded while that sweep is still reading, and the pin that follows asks again.
      service.invalidateObservation();
      reportResidency(nothingResident());
      const fresh = await service.calculateBudget(makeProfile());
      release();
      await stale;

      expect(fresh.modelUsedVramMb).toBe(0);
      expect((await service.calculateBudget(makeProfile())).modelUsedVramMb).toBe(0);
      expect(residency.getReport).toHaveBeenCalledTimes(2);
    });

    it('one sweep serves every budget asked for within the TTL', async () => {
      await Promise.all([service.calculateBudget(makeProfile()), service.calculateBudget(makeProfile())]);
      await service.calculateBudget(makeProfile());

      expect(residency.getReport).toHaveBeenCalledTimes(1);
      expect(gpuSampler.sampleVramByProcess).toHaveBeenCalledTimes(1);
    });

    it('a sampler that throws costs only the GPU figure', async () => {
      gpuSampler.sampleVramByProcess.mockRejectedValue(new Error('nvidia-smi: not found'));
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 1533 * MiB, totalBytes: 4200 * MiB })] },
      ]);

      const budget = await service.calculateBudget(makeProfile());

      expect(budget.modelUsedVramMb).toBe(1533);
    });

    async function freshService(): Promise<MemoryManagerService> {
      const module = await Test.createTestingModule({
        providers: [
          MemoryManagerService,
          { provide: LoggerService, useValue: loggerService },
          { provide: ModelRegistryService, useValue: modelRegistry },
          { provide: ModelResidencyService, useValue: residency },
          { provide: GpuProcessSamplerService, useValue: gpuSampler },
          { provide: InferenceBackendRegistry, useValue: backendRegistry },
        ],
      }).compile();
      return module.get(MemoryManagerService);
    }
  });

  // ─── S-MEM-2: Eviction ─────────────────────────────────────────────

  describe('Eviction (MEM-2)', () => {
    it('S-MEM-2.1: SHALL score eviction candidates by LRU + frequency', () => {
      const candidates: TrackedModel[] = [
        {
          catalogId: 'model-a',
          backend: 'ollama',
          backendModelId: 'a',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 5000,
          lastUsedAt: 100,
          requestCount: 10,
        },
        {
          catalogId: 'model-b',
          backend: 'ollama',
          backendModelId: 'b',
          state: 'loaded',
          pinned: false,
          memoryUsedMb: 3000,
          lastUsedAt: 200,
          requestCount: 5,
        },
      ];
      modelRegistry.getEvictionCandidates.mockReturnValue(candidates);

      const result = service.getModelsToEvict(makeProfile(), 4000);
      expect(result.canFree).toBe(true);
      expect(result.modelsToEvict[0]).toBe('model-a'); // Older = evict first
    });

    it('S-MEM-2.2: pinned models SHALL never be eviction candidates', () => {
      // The model registry filters these out — we test that the eviction result
      // with no candidates cannot free memory
      modelRegistry.getEvictionCandidates.mockReturnValue([]);

      const result = service.getModelsToEvict(makeProfile(), 4000);
      expect(result.canFree).toBe(false);
      expect(result.modelsToEvict).toHaveLength(0);
    });
  });

  // ─── S-MEM-3: App vs Model Priority ───────────────────────────────

  describe('App starts vs models (MEM-3)', () => {
    // Use CPU-only profiles so models use RAM (not VRAM), which is the pool an app start draws on.
    const cpuProfile = (over: Partial<HardwareProfile> = {}) =>
      makeProfile({
        gpu: { available: false, vendor: 'none', model: '', vramMb: 0, unifiedMemory: false, driverVersion: '', runtimeAvailable: false },
        tier: 'cpu-only',
        ...over,
      });

    it('S-MEM-3.1: SHALL evict unpinned models for app starts', async () => {
      const loadedModels: TrackedModel[] = [tracked({ catalogId: 'model-a', backendModelId: 'a', memoryUsedMb: 62000 })];
      modelRegistry.getEvictionCandidates.mockReturnValue(loadedModels);
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('a', { engineGpuBytes: 62000 * MiB, totalBytes: 62000 * MiB })] },
      ]);

      const result = await service.canStartApp(cpuProfile(), 4000);
      expect(result.canStart).toBe(true);
      expect(result.modelsToEvict.length).toBeGreaterThan(0);
    });

    it('S-MEM-3.2: SHALL deny app start if it requires evicting pinned models', async () => {
      // No eviction candidates (all pinned); the pinned model is using nearly all RAM.
      modelRegistry.getEvictionCandidates.mockReturnValue([]);
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('p1', { engineGpuBytes: 62000 * MiB, totalBytes: 62000 * MiB })] },
      ]);
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'pinned-1', backendModelId: 'p1', state: 'pinned', pinned: true, memoryUsedMb: 62000 }),
      ]);

      const result = await service.canStartApp(cpuProfile({ ram: { totalMb: 65536, availableMb: 2000 } }), 10000);
      expect(result.canStart).toBe(false);
      expect(result.warning).toContain('pinned models cannot be evicted');
    });

    it('S-MEM-3.3: SHALL warn when starting app will evict models', async () => {
      const candidates: TrackedModel[] = [tracked({ catalogId: 'model-a', backendModelId: 'a', memoryUsedMb: 5000 })];
      modelRegistry.getEvictionCandidates.mockReturnValue(candidates);
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('a', { engineGpuBytes: 5000 * MiB, totalBytes: 5000 * MiB })] },
      ]);

      const result = await service.canStartApp(cpuProfile(), 65000);
      if (result.warning) {
        expect(result.warning).toContain('evict');
      }
    });
  });

  // ─── canFitModel ──────────────────────────────────────────────────

  describe('canFitModel', () => {
    it('should fit model when enough VRAM', async () => {
      const result = await service.canFitModel(makeProfile(), 5000);
      expect(result.fits).toBe(true);
    });

    it('should not fit model when insufficient VRAM', async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        { backend: 'ollama', source: 'measured', models: [resident('big', { engineGpuBytes: 22000 * MiB, totalBytes: 22000 * MiB })] },
      ]);
      const result = await service.canFitModel(makeProfile(), 5000);
      expect(result.fits).toBe(false);
    });

    it('does not fit a model into VRAM an out-of-band vLLM is holding', async () => {
      // The over-admission this change removes: nothing tracked, so the old budget said 24 GiB free.
      health.vllm = { running: true, healthy: true, modelsLoaded: ['Qwen/Qwen2.5-3B-Instruct-AWQ'] };
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 6975, processName: 'VLLM::EngineCore', vramMb: 20_000 }]);

      const result = await service.canFitModel(makeProfile(), 5000);

      expect(result.fits).toBe(false);
      expect(result.availableMb).toBe(24064 - 20_000);
    });
  });

  // ─── Live host RAM on a unified node ──────────────────────────────
  //
  // The budget's "used" is what the engines hold, and on a unified-memory node that is not the
  // whole story: the apps, the OS, page cache under pressure and any engine the sweep cannot size
  // draw from the same RAM. On `ci` (Strix Halo) vLLM held 96 GB of GTT out-of-band; the budget
  // still said the machine was free, and the load it admitted got Ollama OOM-killed. The hardware
  // inspector now serves `ram.availableMb` live (marked by `ram.sampledAt`), and that is what a
  // load on a unified node must be admitted against as well.

  describe('live host RAM cap (unified memory)', () => {
    const STRIX_HALO_TOTAL_MB = 128085;
    const unified = (ram: HardwareProfile['ram']): HardwareProfile =>
      makeProfile({
        gpu: {
          available: true,
          vendor: 'amd',
          model: 'Radeon 8060S',
          vramMb: STRIX_HALO_TOTAL_MB,
          unifiedMemory: true,
          driverVersion: '',
          runtimeAvailable: false,
          hostRocmKfdAvailable: true,
        },
        ram,
        effectiveInferenceMemoryMb: ram.availableMb,
      });
    const live = (availableMb: number): HardwareProfile['ram'] => ({
      totalMb: STRIX_HALO_TOTAL_MB,
      availableMb,
      usedMb: STRIX_HALO_TOTAL_MB - availableMb,
      sampledAt: '2026-09-20T12:00:00.000Z',
    });

    it('admits against what the host has free now, not the budget arithmetic alone', async () => {
      // Engines: nothing resident, so the budget is total − 2 GB reserve = 126037 MB.
      // Host: vLLM has 96 GB of GTT the sweep never sees; MemAvailable says 20 GB.
      const profile = unified(live(20480));

      const fit = await service.canFitModel(profile, 24000);

      expect(fit.fits).toBe(false);
      expect(fit.availableMb).toBe(20480 - 2048);
      expect(fit.requiredMb).toBe(24000);
      // The same load fits once the host actually has the room.
      expect((await service.canFitModel(unified(live(53052)), 24000)).fits).toBe(true);
    });

    it('still honours the budget when the host has more free than the engines leave', async () => {
      // Ollama holds a 100 GB model: 128085 − 2048 − 100000 = 26037 MB budgeted; the host
      // (page cache reclaimable) says 60 GB free.
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('qwen3.6:35b', { totalBytes: 100000 * MiB })] },
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
      ]);

      const fit = await service.canFitModel(unified(live(61440)), 24000);
      expect(fit.availableMb).toBe(26037);
      expect(fit.fits).toBe(true);
      expect((await service.canFitModel(unified(live(61440)), 30000)).fits).toBe(false);
    });

    it('does not cap on a host-probe snapshot (no sampledAt): macOS/Windows keep the budget arithmetic', async () => {
      // The desktop probe's vm_stat free+inactive at app start on a busy Mac; it never refreshes,
      // and macOS would hand the memory over on demand. Capping on it would refuse loads that
      // were admitted before.
      const profile = unified({ totalMb: 98304, availableMb: 12288 });

      const fit = await service.canFitModel(profile, 24000);

      expect(fit.availableMb).toBe(98304 - 2048);
      expect(fit.fits).toBe(true);
    });

    it('discrete node: VRAM admission is untouched by the live RAM figure', async () => {
      const profile = makeProfile({ ram: { totalMb: 65536, availableMb: 4096, usedMb: 61440, sampledAt: '2026-09-20T12:00:00.000Z' } });

      const fit = await service.canFitModel(profile, 20000);

      expect(fit.availableMb).toBe(24576 - 512);
      expect(fit.fits).toBe(true);
    });

    it('a host with less free than the reserve has no headroom, and says 0 rather than a negative number', async () => {
      const fit = await service.canFitModel(unified(live(1024)), 100);
      expect(fit.availableMb).toBe(0);
      expect(fit.fits).toBe(false);
    });

    it('canStartApp evicts against the live figure', async () => {
      const candidates: TrackedModel[] = [tracked({ catalogId: 'model-a', backendModelId: 'a', memoryUsedMb: 20000 })];
      modelRegistry.getEvictionCandidates.mockReturnValue(candidates);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('a', { totalBytes: 20000 * MiB })] },
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
      ]);

      // Budget headroom 106037 MB; host says 8 GB free. A 10 GB app needs the model gone.
      const result = await service.canStartApp(unified(live(8192)), 10240);

      expect(result.canStart).toBe(true);
      expect(result.modelsToEvict).toEqual(['model-a']);
      expect(result.warning).toContain('evict');
    });
  });

  // ─── canPinModel ──────────────────────────────────────────────────

  describe('canPinModel', () => {
    it('should allow pinning when budget available', async () => {
      const result = await service.canPinModel(makeProfile(), 5000);
      expect(result.canPin).toBe(true);
    });

    it('should deny pinning when budget exceeded', async () => {
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'big', backendModelId: 'big', state: 'pinned', pinned: true, memoryUsedMb: 22000 }),
      ]);
      const result = await service.canPinModel(makeProfile(), 5000);
      expect(result.canPin).toBe(false);
    });

    // beta-red: the catalog's 10,813 MB for gemma4:e4b is over the 9,728 MB a 3080 has for models,
    // while the card was serving it in 5,550 MiB at that moment.
    it('uses what the model was measured holding here over the catalog figure', async () => {
      const betaRed = makeProfile({ gpu: { ...makeProfile().gpu, vramMb: 10_240, model: 'RTX 3080' }, effectiveInferenceMemoryMb: 10_240 });
      const gemma = { backend: 'ollama' as const, backendModelId: 'gemma4:e4b' };
      await expect(service.canPinModel(betaRed, 10_813, gemma)).resolves.toMatchObject({ canPin: false });

      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 3697148, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })],
        },
      ]);
      await service.calculateBudget(betaRed);
      service.invalidateObservation();

      await expect(service.canPinModel(betaRed, 10_813, gemma)).resolves.toEqual({ canPin: true });
    });
  });

  // ─── Load sizing ───────────────────────────────────────────────────
  // What the router sizes a load's context window against, and the measurements it prefers to the
  // catalog: the window must be chosen against the same budget the fit check then applies.
  describe('load sizing', () => {
    const betaRed = (): HardwareProfile =>
      makeProfile({ gpu: { ...makeProfile().gpu, vramMb: 10_240, model: 'RTX 3080' }, effectiveInferenceMemoryMb: 10_240 });
    const ollamaHolding = (...models: ResidentModel[]): BackendResidency[] => [
      ...nothingResident().filter((entry) => entry.backend !== 'ollama'),
      { backend: 'ollama', source: 'measured', models },
    ];

    it('modelMemoryCeilingMb is the budget canFitModel applies with nothing loaded', async () => {
      // beta-1: 24,560 MB card, 24,048 for models.
      const beta1 = makeProfile({ gpu: { ...makeProfile().gpu, vendor: 'amd', vramMb: 24_560 }, effectiveInferenceMemoryMb: 24_560 });
      expect(modelMemoryCeilingMb(beta1)).toBe(24_048);
      expect((await service.canFitModel(beta1, 0)).availableMb).toBe(24_048);
      // Unified memory: live MemAvailable less the system reserve, the cap canFitModel applies there.
      const unified = makeProfile({
        gpu: { ...makeProfile().gpu, vendor: 'amd', unifiedMemory: true, vramMb: 128_085 },
        ram: { totalMb: 128_085, availableMb: 103_309, sampledAt: '2026-09-29T00:00:00.000Z' },
        effectiveInferenceMemoryMb: 103_309,
      });
      expect(modelMemoryCeilingMb(unified)).toBe(103_309 - 2048);
      // A host-probe snapshot (macOS/Windows) is read as the sizing always read it.
      expect(modelMemoryCeilingMb({ ...unified, ram: { totalMb: 98_304, availableMb: 12_288 }, effectiveInferenceMemoryMb: 12_288 })).toBe(12_288);
    });

    describe('a node with two cards (beta-1, 2 x RX 7900 XTX)', () => {
      // sysfs lists 25,753,026,560 bytes = 24,560 MB on each card; vramMb is the larger single one.
      const beta1TwoCards = (): HardwareProfile =>
        makeProfile({
          gpu: { ...makeProfile().gpu, vendor: 'amd', model: 'Navi 31', vramMb: 24_560, deviceCount: 2, poolVramMb: 49_120 },
          effectiveInferenceMemoryMb: 49_120,
        });

      it('budgets every card, each less its own display reserve', async () => {
        const budget = await service.calculateBudget(beta1TwoCards());
        expect(budget.totalVramMb).toBe(49_120);
        expect(budget.modelBudgetVramMb).toBe(49_120 - 2 * 512);
        expect(modelMemoryCeilingMb(beta1TwoCards())).toBe(48_096);
        await expect(service.loadHeadroomMb(beta1TwoCards())).resolves.toBe(48_096);
      });

      it('no longer reads the 27B that Ollama split across both cards as over budget', async () => {
        // /api/ps: 20,135 MB at 65536; rocm-smi: the one llama-server holds 26.1 GB across GPUs 1 and 2, beside gemma4 and nomic.
        reportResidency(ollamaHolding(resident('qwen3.8:27b', { engineGpuBytes: 20_135 * MiB, totalBytes: 20_135 * MiB, contextLength: 65_536 })));
        gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: 'llama-server', vramMb: 36_642 }]);
        const one = makeProfile({ gpu: { ...makeProfile().gpu, vendor: 'amd', vramMb: 24_560 }, effectiveInferenceMemoryMb: 24_560 });
        await expect(service.loadHeadroomMb(one)).resolves.toBe(24_048 - 36_642);
        service.invalidateObservation();
        await expect(service.loadHeadroomMb(beta1TwoCards())).resolves.toBe(48_096 - 36_642);
      });

      it('leaves a one-card profile exactly as it was', async () => {
        const one = makeProfile({ gpu: { ...makeProfile().gpu, vendor: 'amd', vramMb: 24_560 }, effectiveInferenceMemoryMb: 24_560 });
        expect(modelMemoryCeilingMb(one)).toBe(24_048);
        expect((await service.calculateBudget(one)).totalVramMb).toBe(24_560);
      });
    });

    it('loadHeadroomMb is the figure canFitModel compares against', async () => {
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      await expect(service.loadHeadroomMb(betaRed())).resolves.toBe(9_728 - 5_550);
      await expect(service.canFitModel(betaRed(), 0)).resolves.toMatchObject({ availableMb: 9_728 - 5_550 });
    });

    it("records a model's process figure, with its window, and keeps it after the model unloads", async () => {
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 5550,
        contextLength: 16_384,
        source: 'process',
      });

      // Expired: the next load of it is exactly when the measurement is needed.
      reportResidency(nothingResident());
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);
      service.invalidateObservation();
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toMatchObject({ footprintMb: 5550 });
    });

    it('keeps what it measured across a Hub restart, and rewrites the file only when a figure moved', async () => {
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      await service.calculateBudget(betaRed());
      await service.sightingsPersisted();
      const written = await readFootprintSightings();
      expect(written?.sightings.map(({ model, footprintMb }) => [model, footprintMb])).toEqual([['gemma4:e4b', 5550]]);

      // A few MB of drift between samples is the same measurement: the file keeps what it had.
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5580 }]);
      service.invalidateObservation();
      await service.calculateBudget(betaRed());
      await service.sightingsPersisted();
      await expect(readFootprintSightings()).resolves.toEqual(written);

      // The next Hub process, with the model expired: the measurement is still there to size it by.
      reportResidency(nothingResident());
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);
      const restarted = new MemoryManagerService(loggerService, modelRegistry, backendRegistry, residency, gpuSampler);
      await expect(restarted.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 5550,
        contextLength: 16_384,
        source: 'process',
      });
      // And a pin counts at it, where the registry says the catalog's 10,813.
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', state: 'pinned', pinned: true, memoryUsedMb: 10_813 }),
      ]);
      await expect(restarted.calculateBudget(betaRed())).resolves.toMatchObject({ pinnedVramMb: 5550 });
    });

    it('does not restore a measurement taken on other hardware', async () => {
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      await service.calculateBudget(betaRed());
      await service.sightingsPersisted();

      reportResidency(nothingResident());
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);
      const swapped = makeProfile({ gpu: { ...makeProfile().gpu, vramMb: 8_192, model: 'RTX 3070' }, effectiveInferenceMemoryMb: 8_192 });
      const restarted = new MemoryManagerService(loggerService, modelRegistry, backendRegistry, residency, gpuSampler);
      await expect(restarted.footprintSighting(swapped, 'ollama', 'gemma4:e4b')).resolves.toBeNull();
    });

    it("splits one process figure between models in the engine's own proportions (beta-1: gemma4 and the embedder)", async () => {
      const beta1 = makeProfile({ gpu: { ...makeProfile().gpu, vendor: 'amd', vramMb: 24_560 }, effectiveInferenceMemoryMb: 24_560 });
      reportResidency(
        ollamaHolding(
          resident('gemma4:e4b', { engineGpuBytes: 3_573_442_149, totalBytes: 3_573_442_149, contextLength: 16_384 }),
          resident('nomic-embed-text:latest', { engineGpuBytes: 323_150_151, totalBytes: 323_150_151, contextLength: 2048 }),
        ),
      );
      // rocm-smi: 5,963 + 677 MiB, both bare `llama-server`.
      gpuSampler.sampleVramByProcess.mockResolvedValue([
        { pid: 776965, processName: 'llama-server', vramMb: 5963 },
        { pid: 592858, processName: 'llama-server', vramMb: 677 },
      ]);
      const gemma = await service.footprintSighting(beta1, 'ollama', 'gemma4:e4b');
      expect(gemma?.footprintMb).toBe(Math.round((6640 * 3_573_442_149) / (3_573_442_149 + 323_150_151)));
      // Keyed by the model, not the spelling: the catalog says `nomic-embed-text`.
      await expect(service.footprintSighting(beta1, 'ollama', 'nomic-embed-text')).resolves.toMatchObject({ contextLength: 2048 });
    });

    it("keeps the engine's own figure, marked as such, when no process figure exists", async () => {
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: Math.round(3_364_754_553 / MiB),
        contextLength: 16_384,
        source: 'engine',
      });
    });

    // beta-red, 2026-10-01: right after a load the vendor tool listed no runner for a sample, the engine's
    // 3,257 MB stood in for the 8,785 MiB the card held, and a pin checked in that window used it.
    it('does not let the engine’s own figure replace a measured one at the same window', async () => {
      const gemma = resident('gemma4:e4b', { engineGpuBytes: 3_257 * MiB, totalBytes: 3_257 * MiB, contextLength: 65_536 });
      reportResidency(ollamaHolding(gemma));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 8_660 }]);
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 8_660,
        contextLength: 65_536,
        source: 'process',
      });

      // The next sweep finds no runner row: only /api/ps is left to read.
      service.invalidateObservation();
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 8_660,
        contextLength: 65_536,
        source: 'process',
      });

      // The same model at another window is another question, and the engine's figure is all there is for it.
      service.invalidateObservation();
      reportResidency(ollamaHolding({ ...gemma, contextLength: 16_384 }));
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 3_257,
        contextLength: 16_384,
        source: 'engine',
      });

      // And a process reading replaces whatever is there.
      service.invalidateObservation();
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 7_854 }]);
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toEqual({
        footprintMb: 7_854,
        contextLength: 16_384,
        source: 'process',
      });
    });

    it('does not let a pin be checked against the engine’s figure while it is the only one this sweep has', async () => {
      const gemma = resident('gemma4:e4b', { engineGpuBytes: 3_257 * MiB, totalBytes: 3_257 * MiB, contextLength: 65_536 });
      const pinned = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', pinned: true, memoryUsedMb: 10_813 });
      modelRegistry.getLoadedModels.mockReturnValue([pinned]);
      reportResidency(ollamaHolding(gemma));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 8_660 }]);
      await service.calculateBudget(betaRed());

      service.invalidateObservation();
      gpuSampler.sampleVramByProcess.mockResolvedValue([]);
      await expect(service.calculateBudget(betaRed())).resolves.toMatchObject({ pinnedVramMb: 8_660 });
    });

    it('records nothing for a model partly in system RAM: that says nothing about what the card must hold', async () => {
      // beta-3-glass, RTX 3070, 2026-09-29: qwen3.8:27b at 16384, 18.1 GB of which 4.6 GB on the card, 6,104 MiB process.
      const glass = makeProfile({ gpu: { ...makeProfile().gpu, vramMb: 8192, model: 'RTX 3070' }, effectiveInferenceMemoryMb: 8192 });
      reportResidency(ollamaHolding(resident('qwen3.8:27b', { engineGpuBytes: 4_798_839_519, totalBytes: 18_968_320_405, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 3961994, processName: '/usr/local/lib/ollama/llama-server', vramMb: 6104 }]);
      await expect(service.footprintSighting(glass, 'ollama', 'qwen3.8:27b')).resolves.toBeNull();
    });

    it('records nothing without a window, or from the registry’s bookkeeping', async () => {
      reportResidency([
        ...nothingResident().filter((entry) => entry.backend !== 'ollama' && entry.backend !== 'lemonade'),
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553 })] },
        { backend: 'lemonade', source: 'unreachable', models: null },
      ]);
      modelRegistry.getLoadedModels.mockReturnValue([tracked({ catalogId: 'x', backend: 'lemonade', backendModelId: 'X-GGUF', memoryUsedMb: 6000 })]);
      await expect(service.footprintSighting(betaRed(), 'ollama', 'gemma4:e4b')).resolves.toBeNull();
      await expect(service.footprintSighting(betaRed(), 'lemonade', 'X-GGUF')).resolves.toBeNull();
    });

    it('counts a pin at what it was measured holding', async () => {
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', state: 'pinned', pinned: true, memoryUsedMb: 10_813 }),
      ]);
      reportResidency(ollamaHolding(resident('gemma4:e4b', { engineGpuBytes: 3_364_754_553, totalBytes: 3_364_754_553, contextLength: 16_384 })));
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 1, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5550 }]);
      await service.calculateBudget(betaRed());
      service.invalidateObservation();
      await expect(service.calculateBudget(betaRed())).resolves.toMatchObject({ pinnedVramMb: 5550 });
    });
  });

  // ─── planEviction ──────────────────────────────────────────────────
  // What a load may unload to make room. Candidates are sized in the budget's own units, a model
  // with a generation in flight is never one, and who asked decides whether models the Hub did not
  // load itself are fair game (`request` no, `operator` yes).
  describe('planEviction', () => {
    const keepLemonade = { backend: 'lemonade' as const, backendModelId: 'Qwen3.8-27B-GGUF' };
    const operator = { scope: 'operator' as const };
    const request = { scope: 'request' as const };
    /** beta-red: RTX 3080 10 GB, so a 9,728 MB model budget. */
    const betaRed = () =>
      makeProfile({
        gpu: {
          available: true,
          vendor: 'nvidia',
          model: 'RTX 3080',
          vramMb: 10_240,
          unifiedMemory: false,
          driverVersion: '580',
          runtimeAvailable: true,
        },
      });

    beforeEach(() => {
      modelRegistry.getTrackedModels.mockReturnValue([]);
      modelRegistry.getCatalog.mockReturnValue([]);
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
    });

    it('names a model an app loaded on another engine, for an operator, sized from the engine', async () => {
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB, totalBytes: 17_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade, operator);

      expect(plan).toEqual({
        canFree: true,
        freedMb: 17_000,
        candidates: [{ backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', catalogId: null, estimatedMb: 17_000 }],
        busy: [],
      });
    });

    it("never names a model an app loaded when an app's request asked, and so unloads nothing", async () => {
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade, request);

      expect(plan).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [] });
    });

    it('never names a pinned model or the one being loaded', async () => {
      modelRegistry.getTrackedModels.mockReturnValue([
        tracked({ catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', pinned: true, state: 'pinned' }),
      ]);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [resident('Qwen3.8-27B-GGUF')] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade, operator);

      expect(plan.candidates).toEqual([]);
      expect(plan.canFree).toBe(false);
    });

    // R1: `/api/ps` names an untagged catalog model `name:latest`, and an exact comparison missed the pin.
    it('never names a pinned model the engine spells with :latest', async () => {
      modelRegistry.getTrackedModels.mockReturnValue([
        tracked({ catalogId: 'nomic-embed-text', backendModelId: 'nomic-embed-text', pinned: true, state: 'pinned' }),
      ]);
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('nomic-embed-text:latest', { engineGpuBytes: 308 * MiB }), resident('gemma4:e4b', { engineGpuBytes: 6_640 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 6_000, { backend: 'ollama', backendModelId: 'qwen3-coder:30b' }, operator);
      expect(plan.candidates.map((c) => c.backendModelId)).toEqual(['gemma4:e4b']);

      // Needing more than gemma4 frees, the plan would have reached for the embedder next.
      const more = await service.planEviction(makeProfile(), 6_800, { backend: 'ollama', backendModelId: 'qwen3-coder:30b' }, operator);
      expect(more).toEqual({ canFree: false, candidates: [], freedMb: 6_640, busy: [] });
    });

    // L1 after #1684/#1685/#1686: Lemonade 10.2.0 lists the embedder the Hub registers as
    // `user.nomic-embed-text-v1.5-GGUF` (its `/v1/health` record, as `Router::get_all_loaded_models`
    // writes it), while the registry and the catalog carry `nomic-embed-text-v1.5-GGUF`. Matched with
    // the `:latest` folding alone, the pin was never seen and an operator's load unloaded it.
    describe('a Lemonade embedder that 10.2.0 lists as user.<id>', () => {
      const EMBEDDER = 'user.nomic-embed-text-v1.5-GGUF';
      const embedderRow = CURATED_MODELS.find((model) => model.id === 'nomic-embed-text-v1-5-lemonade');
      const gemmaLemonade = { backend: 'lemonade' as const, backendModelId: 'Gemma-4-E4B-it-GGUF' };
      const lemonadeHoldingEmbedder = () => {
        reportResidency([
          { backend: 'ollama', source: 'measured', models: [] },
          { backend: 'lemonade', source: 'measured', models: [resident(EMBEDDER, { contextLength: 8192 })] },
        ]);
        // The one model Lemonade holds, so its process figure is all the embedder's.
        gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 5202, processName: 'lemond', vramMb: 300 }]);
      };

      beforeEach(() => {
        if (!embedderRow) throw new Error('the catalog lost its Lemonade embedder row');
        modelRegistry.getCatalog.mockReturnValue([embedderRow]);
      });

      it('never names it when the operator pinned it', async () => {
        modelRegistry.getTrackedModels.mockReturnValue([
          tracked({
            catalogId: 'nomic-embed-text-v1-5-lemonade',
            backend: 'lemonade',
            backendModelId: 'nomic-embed-text-v1.5-GGUF',
            pinned: true,
            state: 'pinned',
          }),
        ]);
        lemonadeHoldingEmbedder();

        const plan = await service.planEviction(makeProfile(), 152, gemmaLemonade, operator);

        expect(plan).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [] });
      });

      // PIN-2: after a Hub restart the engine still holds what the operator pinned, and the new process
      // has tracked nothing yet. The persisted pin, looked up through the catalog row, keeps it.
      it('never names it when the pin was persisted by the last Hub process and nothing tracks it yet', async () => {
        modelRegistry.isPinned.mockImplementation((catalogId) => catalogId === 'nomic-embed-text-v1-5-lemonade');
        lemonadeHoldingEmbedder();

        const plan = await service.planEviction(makeProfile(), 152, gemmaLemonade, operator);

        expect(plan.candidates).toEqual([]);
        expect(modelRegistry.isPinned).toHaveBeenCalledWith('nomic-embed-text-v1-5-lemonade');
      });

      it('names it, under its catalog row, when nothing pinned it', async () => {
        lemonadeHoldingEmbedder();

        const plan = await service.planEviction(makeProfile(), 152, gemmaLemonade, operator);

        expect(plan.candidates).toEqual([
          { backend: 'lemonade', backendModelId: EMBEDDER, catalogId: 'nomic-embed-text-v1-5-lemonade', estimatedMb: 300 },
        ]);
      });

      it("finds the Hub's own load of it, and leaves it alone while an embedding batch runs on it", async () => {
        const embedder = tracked({ catalogId: 'nomic-embed-text-v1-5-lemonade', backend: 'lemonade', backendModelId: 'nomic-embed-text-v1.5-GGUF' });
        modelRegistry.getEvictionCandidates.mockReturnValue([embedder]);
        modelRegistry.getTrackedModels.mockReturnValue([embedder]);
        lemonadeHoldingEmbedder();

        const idle = await service.planEviction(makeProfile(), 152, gemmaLemonade, request);
        expect(idle.candidates).toEqual([
          { backend: 'lemonade', backendModelId: EMBEDDER, catalogId: 'nomic-embed-text-v1-5-lemonade', estimatedMb: 300 },
        ]);

        // Memory batch-embedding through the pool, under the bare name it was handed on another version.
        const inUse = (backend: InferenceBackendType) => (backend === 'lemonade' ? [{ model: 'nomic-embed-text-v1.5-GGUF' }] : []);
        const busy = await service.planEviction(makeProfile(), 152, gemmaLemonade, { scope: 'operator', inUse });
        expect(busy).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [EMBEDDER], idleWouldFree: true });
      });

      it('matches the model being loaded under either spelling', async () => {
        lemonadeHoldingEmbedder();

        const plan = await service.planEviction(makeProfile(), 100, { backend: 'lemonade', backendModelId: 'nomic-embed-text-v1.5-GGUF' }, operator);

        expect(plan.candidates).toEqual([]);
      });

      it('shares a sighting between the two spellings, on unified memory where one lone process is measurable', async () => {
        lemonadeHoldingEmbedder();
        const strixHalo = makeProfile({
          gpu: { available: true, vendor: 'amd', model: 'Radeon 8060S', vramMb: 0, unifiedMemory: true, driverVersion: '', runtimeAvailable: true },
          ram: { totalMb: 125_781, availableMb: 90_000 },
        });

        await expect(service.footprintSighting(strixHalo, 'lemonade', 'nomic-embed-text-v1.5-GGUF')).resolves.toMatchObject({
          footprintMb: 300,
          contextLength: 8192,
        });
      });

      it('folds nothing for another engine: `user.` means nothing to Ollama', async () => {
        reportResidency([
          { backend: 'ollama', source: 'measured', models: [resident('user.nomic-embed-text', { engineGpuBytes: 300 * MiB })] },
          { backend: 'lemonade', source: 'measured', models: [] },
        ]);
        modelRegistry.getTrackedModels.mockReturnValue([
          tracked({ catalogId: 'nomic-embed-text', backendModelId: 'nomic-embed-text', pinned: true }),
        ]);

        const plan = await service.planEviction(makeProfile(), 100, keepLemonade, operator);

        expect(plan.candidates.map((candidate) => candidate.backendModelId)).toEqual(['user.nomic-embed-text']);
      });
    });

    it('matches the model being loaded under :latest too', async () => {
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('nomic-embed-text:latest', { engineGpuBytes: 308 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 100, { backend: 'ollama', backendModelId: 'nomic-embed-text' }, operator);

      expect(plan.candidates).toEqual([]);
    });

    it("takes the Hub's own loads first, least recently used, and stops once enough is freed", async () => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 10_813 });
      modelRegistry.getEvictionCandidates.mockReturnValue([gemma]);
      modelRegistry.getTrackedModels.mockReturnValue([gemma]);
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('gemma4:e4b', { engineGpuBytes: 5_000 * MiB }), resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 4_000, keepLemonade, operator);

      expect(plan.candidates.map((c) => c.backendModelId)).toEqual(['gemma4:e4b']);
      // The engine's figure, not the catalog footprint the registry carries (10,813 MB).
      expect(plan.freedMb).toBe(5_000);
    });

    it("offers the Hub's own idle loads to an app's request", async () => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 10_813 });
      modelRegistry.getEvictionCandidates.mockReturnValue([gemma]);
      modelRegistry.getTrackedModels.mockReturnValue([gemma]);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 6_640 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 4_000, { backend: 'ollama', backendModelId: 'qwen3-coder:30b' }, request);

      expect(plan).toEqual({
        canFree: true,
        freedMb: 6_640,
        candidates: [{ backend: 'ollama', backendModelId: 'gemma4:e4b', catalogId: 'gemma4-e4b', estimatedMb: 6_640 }],
        busy: [],
      });
    });

    it('drops a Hub load the engine no longer holds: unloading it frees nothing', async () => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 10_813 });
      modelRegistry.getEvictionCandidates.mockReturnValue([gemma]);
      modelRegistry.getTrackedModels.mockReturnValue([gemma]);
      // Ollama expired it on its own keep-alive; the registry still says `loaded`.
      reportResidency(nothingResident());

      const plan = await service.planEviction(makeProfile(), 4_000, { backend: 'ollama', backendModelId: 'qwen3-coder:30b' }, request);

      expect(plan).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [] });
    });

    // REQ3: Ollama only marks a busy runner to expire, so evicting it frees nothing in time and costs
    // its app a cold reload. Neither scope may do it.
    it.each([
      ['an operator', operator],
      ["an app's request", request],
    ])('never names a model with a request in flight, for %s', async (_who, scope) => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b' });
      modelRegistry.getEvictionCandidates.mockReturnValue([gemma]);
      modelRegistry.getTrackedModels.mockReturnValue([gemma]);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 6_640 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      const inUse = (backend: InferenceBackendType) => (backend === 'ollama' ? [{ model: 'gemma4:e4b' }] : []);

      const plan = await service.planEviction(makeProfile(), 4_000, { backend: 'ollama', backendModelId: 'qwen3-coder:30b' }, { ...scope, inUse });

      expect(plan).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: ['gemma4:e4b'], idleWouldFree: true });
    });

    it('says a refusal is only the busy models’ doing when idle they would have covered it, and not otherwise', async () => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b' });
      modelRegistry.getEvictionCandidates.mockReturnValue([gemma]);
      modelRegistry.getTrackedModels.mockReturnValue([gemma]);
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('gemma4:e4b', { engineGpuBytes: 6_640 * MiB }), resident('qwen3.5:9b', { engineGpuBytes: 1_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      const inUse = (backend: InferenceBackendType) => (backend === 'ollama' ? [{ model: 'gemma4:e4b' }] : []);
      const keep = { backend: 'ollama' as const, backendModelId: 'qwen3-coder:30b' };

      // Short by 4,000: gemma4's 6,640 would cover it once its generation ends.
      await expect(service.planEviction(makeProfile(), 4_000, keep, { ...request, inUse })).resolves.toMatchObject({
        canFree: false,
        idleWouldFree: true,
      });
      // Short by 20,000: nothing the Hub may unload would, busy or not.
      const hopeless = await service.planEviction(makeProfile(), 20_000, keep, { ...request, inUse });
      expect(hopeless.canFree).toBe(false);
      expect(hopeless.idleWouldFree).toBeUndefined();
      // The idle model an app loaded is not the Hub's to unload for a request, so nothing waits on it.
      modelRegistry.getEvictionCandidates.mockReturnValue([]);
      const appLoaded = await service.planEviction(makeProfile(), 4_000, keep, { ...request, inUse: () => [] });
      expect(appLoaded).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [] });
    });

    it('still names the idle model beside a busy one', async () => {
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('gemma4:e4b', { engineGpuBytes: 6_640 * MiB }), resident('qwen3.5:9b', { engineGpuBytes: 7_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      const inUse = (backend: InferenceBackendType) => (backend === 'ollama' ? [{ model: 'gemma4:e4b' }] : []);

      const plan = await service.planEviction(makeProfile(), 5_000, keepLemonade, { scope: 'operator', inUse });

      expect(plan.candidates.map((c) => c.backendModelId)).toEqual(['qwen3.5:9b']);
      expect(plan.busy).toEqual(['gemma4:e4b']);
    });

    // REQ4: the budget counted gemma4:e4b at its runner's 5,550 MB (nvidia-smi); a plan that sized it
    // at `/api/ps`'s 3,208 refused llama3.1:8b on beta-red although evicting gemma4 made room.
    it('sizes a lone model by the process figure the budget counted (beta-red, 2026-09-30)', async () => {
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('gemma4:e4b', { engineGpuBytes: 3_208 * MiB, totalBytes: 3_208 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 4101, processName: '/usr/local/lib/ollama/llama-server', vramMb: 5_550 }]);
      const fit = await service.canFitModel(betaRed(), 8_592);
      expect(fit).toMatchObject({ fits: false, availableMb: 4_178 });

      const plan = await service.planEviction(betaRed(), 8_592 - fit.availableMb, { backend: 'ollama', backendModelId: 'llama3.1:8b' }, operator);

      expect(plan).toMatchObject({ canFree: true, freedMb: 5_550 });
      expect(plan.candidates).toEqual([{ backend: 'ollama', backendModelId: 'gemma4:e4b', catalogId: null, estimatedMb: 5_550 }]);
    });

    it("splits a process figure across an engine's models in the engine's own proportions", async () => {
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('gemma4:e4b', { engineGpuBytes: 3_000 * MiB }), resident('nomic-embed-text:latest', { engineGpuBytes: 1_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      gpuSampler.sampleVramByProcess.mockResolvedValue([{ pid: 4101, processName: '/usr/local/lib/ollama/llama-server', vramMb: 6_000 }]);

      const plan = await service.planEviction(makeProfile(), 5_000, keepLemonade, operator);

      expect(plan.candidates.map((c) => [c.backendModelId, c.estimatedMb])).toEqual([
        ['gemma4:e4b', 4_500],
        ['nomic-embed-text:latest', 1_500],
      ]);
    });

    // R4: `estimatedMb || null` read a real 0 as "unknown", and one unknown made the plan unload everything.
    it('never unloads a model that frees 0 MB of this pool', async () => {
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          // Ollama placed the embedder wholly on the CPU: `size_vram` 0.
          models: [resident('gemma4:e4b', { engineGpuBytes: 6_000 * MiB }), resident('nomic-embed-text:latest', { engineGpuBytes: 0 })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 5_000, keepLemonade, operator);
      expect(plan.candidates.map((c) => c.backendModelId)).toEqual(['gemma4:e4b']);

      const tooMuch = await service.planEviction(makeProfile(), 7_000, keepLemonade, operator);
      expect(tooMuch).toEqual({ canFree: false, candidates: [], freedMb: 6_000, busy: [] });
    });

    it('refuses without unloading anything when the only candidates cannot be sized', async () => {
      // Lemonade names its models and sizes none, and neither is in the catalog.
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [] },
        { backend: 'lemonade', source: 'measured', models: [resident('Gemma-4-E4B-GGUF'), resident('nomic-embed-text-v1-GGUF')] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, { backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' }, operator);

      expect(plan).toEqual({ canFree: false, candidates: [], freedMb: 0, busy: [] });
    });

    it('names nothing live from an engine that did not answer', async () => {
      const qwen = tracked({ catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', memoryUsedMb: 17_000 });
      modelRegistry.getLoadedModels.mockReturnValue([qwen]);
      modelRegistry.getEvictionCandidates.mockReturnValue([qwen]);
      reportResidency([
        { backend: 'ollama', source: 'unreachable', models: null },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade, operator);

      expect(plan.candidates).toEqual([]);
    });
  });
});
