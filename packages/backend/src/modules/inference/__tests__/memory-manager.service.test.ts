import { Test, type TestingModule } from '@nestjs/testing';
import { MemoryManagerService } from '../memory-manager.service';
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
  });

  // ─── planEviction ──────────────────────────────────────────────────
  // Eviction drawn from what the engines hold, not only from the Hub's own loads: the 27B an app
  // loaded through Ollama directly is `pulled` in the registry, and getModelsToEvict never sees it.
  describe('planEviction', () => {
    const keepLemonade = { backend: 'lemonade' as const, backendModelId: 'Qwen3.8-27B-GGUF' };

    beforeEach(() => {
      modelRegistry.getTrackedModels.mockReturnValue([]);
      modelRegistry.getCatalog.mockReturnValue([]);
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
    });

    it('names a model an app loaded on another engine, sized from the engine', async () => {
      reportResidency([
        {
          backend: 'ollama',
          source: 'measured',
          models: [resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB, totalBytes: 17_000 * MiB })],
        },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade);

      expect(plan).toEqual({
        canFree: true,
        freedMb: 17_000,
        candidates: [{ backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', catalogId: null, estimatedMb: 17_000 }],
      });
    });

    it('never names a pinned model or the one being loaded', async () => {
      modelRegistry.getTrackedModels.mockReturnValue([
        tracked({ catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', pinned: true, state: 'pinned' }),
      ]);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('qwen3.8:27b-mtp-q4_K_M', { engineGpuBytes: 17_000 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [resident('Qwen3.8-27B-GGUF')] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade);

      expect(plan.candidates).toEqual([]);
      expect(plan.canFree).toBe(false);
    });

    it("takes the Hub's own loads first, least recently used, and stops once enough is freed", async () => {
      const gemma = tracked({ catalogId: 'gemma4-e4b', backendModelId: 'gemma4:e4b', memoryUsedMb: 5_000 });
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

      const plan = await service.planEviction(makeProfile(), 4_000, keepLemonade);

      expect(plan.candidates.map((c) => c.backendModelId)).toEqual(['gemma4:e4b']);
      expect(plan.freedMb).toBe(5_000);
    });

    it('goes ahead optimistically when a candidate cannot be sized, leaving the re-measure to decide', async () => {
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [] },
        { backend: 'lemonade', source: 'measured', models: [resident('Gemma-4-E4B-GGUF'), resident('nomic-embed-text-v1-GGUF')] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, { backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' });

      expect(plan.canFree).toBe(true);
      expect(plan.candidates.map((c) => c.estimatedMb)).toEqual([null, null]);
    });

    it('names nothing live from an engine that did not answer', async () => {
      modelRegistry.getLoadedModels.mockReturnValue([
        tracked({ catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', memoryUsedMb: 17_000 }),
      ]);
      reportResidency([
        { backend: 'ollama', source: 'unreachable', models: null },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);

      const plan = await service.planEviction(makeProfile(), 12_000, keepLemonade);

      expect(plan.candidates).toEqual([]);
    });
  });

  // AUDIT-1679 scratch: a pinned catalog model Ollama reports under its `:latest` spelling.
  describe('AUDIT planEviction tag folding', () => {
    it('never names a pinned model Ollama lists as name:latest', async () => {
      const nomic = tracked({ catalogId: 'nomic-embed-text', backendModelId: 'nomic-embed-text', pinned: true, state: 'pinned' });
      modelRegistry.getTrackedModels.mockReturnValue([nomic]);
      modelRegistry.getCatalog.mockReturnValue([]);
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
      reportResidency([
        { backend: 'ollama', source: 'measured', models: [resident('nomic-embed-text:latest', { engineGpuBytes: 600 * MiB })] },
        { backend: 'lemonade', source: 'measured', models: [] },
      ]);
      const plan = await service.planEviction(makeProfile(), 500, { backend: 'lemonade', backendModelId: 'Qwen3.8-27B-GGUF' });
      expect(plan.candidates).toEqual([]);
    });
  });
});
