import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelPullerService } from '../model-puller.service';
import { ModelRegistryService } from '../model-registry.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { DsparkBackend } from '../backends/dspark.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { LlamacppBackend } from '../backends/llamacpp.backend';
import { LmStudioBackend } from '../backends/lmstudio.backend';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';

const profile: HardwareProfile = {
  gpu: { available: true, vendor: 'nvidia', model: 'RTX', vramMb: 8192, unifiedMemory: false, driverVersion: '1', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 16384, availableMb: 12000 },
  cpu: { arch: 'x86_64', cores: 8, model: 'CPU' },
  effectiveInferenceMemoryMb: 8192,
  tier: 'medium',
};

const curated: CuratedModel = {
  id: 'phi-4-mini',
  displayName: 'Phi-4 Mini',
  description: '',
  modality: 'llm',
  purpose: 'general',
  backend: 'ollama',
  backendModelId: 'phi4-mini',
  requirements: { diskMb: 3000, gpuVendors: ['nvidia', 'cpu'], minTier: 'medium' },
  runtime: { memoryFootprintMb: 4096, input: ['text'], pinnedByDefault: false },
  tiers: { high: 'available', medium: 'recommended', low: 'available', cpuOnly: 'available' },
} as CuratedModel;

describe('ModelPullerService.evaluatePull', () => {
  let service: ModelPullerService;
  let logger: MockProxy<LoggerService>;
  let memoryManager: MockProxy<MemoryManagerService>;
  let hostMetrics: MockProxy<HostMetricsService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

  beforeEach(async () => {
    const hardwareInspector = mock<HardwareInspectorService>();
    logger = mock<LoggerService>();
    memoryManager = mock<MemoryManagerService>();
    hostMetrics = mock<HostMetricsService>();
    modelRegistry = mock<ModelRegistryService>();
    ollamaBackend = mock<OllamaBackend>();

    hardwareInspector.getProfile.mockResolvedValue(profile);
    memoryManager.calculateBudget.mockResolvedValue({
      totalVramMb: 8192,
      totalRamMb: 16384,
      systemReservedRamMb: 1024,
      dockerOverheadMb: 0,
      appContainerBudgetMb: 0,
      modelBudgetVramMb: 7000,
      modelBudgetRamMb: 15000,
      modelUsedVramMb: 0,
      modelUsedRamMb: 0,
      pinnedVramMb: 0,
      pinnedRamMb: 0,
      usage: { sampledAt: '2026-09-20T00:00:00.000Z', backends: [] },
    });
    memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 7000, requiredMb: 4096 });
    hostMetrics.readHostSection.mockResolvedValue(null);
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 100,
      diskUsed: 50,
      percentUsed: 50,
      cpuLoad: 0,
      cpuCores: 8,
      memoryTotal: 16,
      memoryUsed: 8,
      percentUsedMemory: 50,
      hasVmWedge: false,
      runtimeKind: 'container-only',
    });
    modelRegistry.getCuratedModel.mockReturnValue(curated);
    modelRegistry.getModelsForTier.mockReturnValue([curated]);
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelPullerService,
        { provide: LoggerService, useValue: logger },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: MtplxBackend, useValue: mock<MtplxBackend>() },
        { provide: DsparkBackend, useValue: mock<DsparkBackend>() },
        { provide: LuceboxBackend, useValue: mock<LuceboxBackend>() },
        { provide: LlamacppBackend, useValue: mock<LlamacppBackend>() },
        { provide: LmStudioBackend, useValue: mock<LmStudioBackend>() },
        InferenceBackendRegistry,
      ],
    }).compile();

    service = moduleRef.get(ModelPullerService);
  });

  it('allows pull when disk and memory budgets are sufficient', async () => {
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.canPull).toBe(true);
    expect(result.alreadyInstalled).toBe(false);
  });

  it('marks already-installed models as no-op pulls', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['phi4-mini'] });
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.alreadyInstalled).toBe(true);
    expect(result.canPull).toBe(true);
  });

  it('blocks pull when disk is insufficient', async () => {
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 10,
      diskUsed: 9,
      percentUsed: 90,
      cpuLoad: 0,
      cpuCores: 8,
      memoryTotal: 16,
      memoryUsed: 8,
      percentUsedMemory: 50,
      hasVmWedge: false,
      runtimeKind: 'container-only',
    });
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(/disk/i);
  });

  it('blocks pull when memory budget is insufficient', async () => {
    memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 1024, requiredMb: 4096 });
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(/memory/i);
  });

  it('logs pull progress so model downloads appear in hub logs', async () => {
    ollamaBackend.pullModel.mockImplementation(async (_modelId, onProgress) => {
      onProgress?.({ status: 'pulling manifest', total: 100, completed: 1, percent: 1 });
      onProgress?.({ status: 'pulling manifest', total: 100, completed: 5, percent: 5 });
      onProgress?.({ status: 'pulling layers', total: 100, completed: 27, percent: 27 });
      onProgress?.({ status: 'pulling layers', total: 100, completed: 29, percent: 29 });
      onProgress?.({ status: 'verifying sha256 digest', total: 100, completed: 100, percent: 100 });
    });

    await service.pullModel('phi-4-mini');

    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pulling phi-4-mini via ollama (backendId: phi4-mini)');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pull progress phi-4-mini: 1% pulling manifest');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pull progress phi-4-mini: 5% pulling manifest');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pull progress phi-4-mini: 27% pulling layers');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pull progress phi-4-mini: 29% pulling layers');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Pull progress phi-4-mini: 100% verifying sha256 digest');
    expect(logger.info).toHaveBeenCalledWith('[ModelPuller] Successfully pulled phi-4-mini');
  });
});

describe('ModelPullerService.startPull', () => {
  let service: ModelPullerService;
  let logger: MockProxy<LoggerService>;
  let memoryManager: MockProxy<MemoryManagerService>;
  let hostMetrics: MockProxy<HostMetricsService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

  beforeEach(async () => {
    const hardwareInspector = mock<HardwareInspectorService>();
    logger = mock<LoggerService>();
    memoryManager = mock<MemoryManagerService>();
    hostMetrics = mock<HostMetricsService>();
    modelRegistry = mock<ModelRegistryService>();
    ollamaBackend = mock<OllamaBackend>();

    hardwareInspector.getProfile.mockResolvedValue(profile);
    memoryManager.calculateBudget.mockResolvedValue({
      totalVramMb: 8192,
      totalRamMb: 16384,
      systemReservedRamMb: 1024,
      dockerOverheadMb: 0,
      appContainerBudgetMb: 0,
      modelBudgetVramMb: 7000,
      modelBudgetRamMb: 15000,
      modelUsedVramMb: 0,
      modelUsedRamMb: 0,
      pinnedVramMb: 0,
      pinnedRamMb: 0,
      usage: { sampledAt: '2026-09-20T00:00:00.000Z', backends: [] },
    });
    memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 7000, requiredMb: 4096 });
    hostMetrics.readHostSection.mockResolvedValue(null);
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 100,
      diskUsed: 50,
      percentUsed: 50,
      cpuLoad: 0,
      cpuCores: 8,
      memoryTotal: 16,
      memoryUsed: 8,
      percentUsedMemory: 50,
      hasVmWedge: false,
      runtimeKind: 'container-only',
    });
    modelRegistry.getCuratedModel.mockReturnValue(curated);
    modelRegistry.getModelsForTier.mockReturnValue([curated]);
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    ollamaBackend.pullModel.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelPullerService,
        { provide: LoggerService, useValue: logger },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: MtplxBackend, useValue: mock<MtplxBackend>() },
        { provide: DsparkBackend, useValue: mock<DsparkBackend>() },
        { provide: LuceboxBackend, useValue: mock<LuceboxBackend>() },
        { provide: LlamacppBackend, useValue: mock<LlamacppBackend>() },
        { provide: LmStudioBackend, useValue: mock<LmStudioBackend>() },
        InferenceBackendRegistry,
      ],
    }).compile();

    service = moduleRef.get(ModelPullerService);
  });

  it('returns already_installed without enqueueing', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['phi4-mini'] });
    const result = await service.startPull('phi-4-mini');
    expect(result.status).toBe('already_installed');
    expect(ollamaBackend.pullModel).not.toHaveBeenCalled();
  });

  it('dedupes concurrent startPull calls', async () => {
    let resolvePull: (() => void) | undefined;
    ollamaBackend.pullModel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePull = resolve;
        }),
    );

    const first = await service.startPull('phi-4-mini');
    const second = await service.startPull('phi-4-mini');

    expect(first.status).toBe('queued');
    expect(second.status).toBe('in_progress');
    resolvePull?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('skips blocked pulls when bestEffort is true', async () => {
    memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 1024, requiredMb: 4096 });
    const result = await service.startPull('phi-4-mini', { bestEffort: true });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/memory/i);
    expect(ollamaBackend.pullModel).not.toHaveBeenCalled();
  });

  it('queues pulls serially', async () => {
    const order: string[] = [];
    ollamaBackend.pullModel.mockImplementation(async (modelId) => {
      order.push(modelId);
    });

    const secondCurated = { ...curated, id: 'llama3-3-70b', backendModelId: 'llama3.3:70b' };
    modelRegistry.getCuratedModel.mockImplementation((id: string) => (id === 'llama3-3-70b' ? secondCurated : curated));
    modelRegistry.getModelsForTier.mockReturnValue([curated, secondCurated]);

    await service.startPull('phi-4-mini');
    await service.startPull('llama3-3-70b');
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual(['phi4-mini', 'llama3.3:70b']);
  });
});
