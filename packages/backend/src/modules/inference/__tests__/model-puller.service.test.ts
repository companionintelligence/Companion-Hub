import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelPullerService } from '../model-puller.service';
import { ModelRegistryService } from '../model-registry.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
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
  let memoryManager: MockProxy<MemoryManagerService>;
  let hostMetrics: MockProxy<HostMetricsService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

  beforeEach(async () => {
    const hardwareInspector = mock<HardwareInspectorService>();
    memoryManager = mock<MemoryManagerService>();
    hostMetrics = mock<HostMetricsService>();
    modelRegistry = mock<ModelRegistryService>();
    ollamaBackend = mock<OllamaBackend>();

    hardwareInspector.getProfile.mockResolvedValue(profile);
    memoryManager.calculateBudget.mockReturnValue({
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
    });
    memoryManager.canFitModel.mockReturnValue({ fits: true, availableMb: 7000, requiredMb: 4096 });
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
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
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
    memoryManager.canFitModel.mockReturnValue({ fits: false, availableMb: 1024, requiredMb: 4096 });
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(/memory/i);
  });
});
