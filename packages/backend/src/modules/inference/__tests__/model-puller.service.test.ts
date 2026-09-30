import { LoggerService } from '@/core/logger/logger.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelPullerService, weightsFloorMb } from '../model-puller.service';
import { ModelRegistryService } from '../model-registry.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OmlxBackend } from '../backends/omlx.backend';
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
  let lemonadeBackend: MockProxy<LemonadeBackend>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;

  beforeEach(async () => {
    hardwareInspector = mock<HardwareInspectorService>();
    logger = mock<LoggerService>();
    memoryManager = mock<MemoryManagerService>();
    hostMetrics = mock<HostMetricsService>();
    modelRegistry = mock<ModelRegistryService>();
    ollamaBackend = mock<OllamaBackend>();
    lemonadeBackend = mock<LemonadeBackend>();

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
        { provide: LemonadeBackend, useValue: lemonadeBackend },
        { provide: OmlxBackend, useValue: mock<OmlxBackend>() },
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

  it('allows pull when the model does not fit in free memory right now (loading decides that)', async () => {
    memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 1024, requiredMb: 4096 });
    const result = await service.evaluatePull('phi-4-mini');
    expect(result.canPull).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(memoryManager.canFitModel).not.toHaveBeenCalled();
  });

  // An RTX 3080 (10 GB) reads as tier `medium`, which admits 20+ GB models. A model whose weights
  // alone are larger than the node's whole model budget with nothing loaded is refused by every load
  // and pin, so downloading it only spends the disk. Free memory right now still does not matter (the
  // case above).
  it('refuses a model whose weights alone are bigger than the whole model budget with nothing loaded', async () => {
    modelRegistry.getCuratedModel.mockReturnValue({
      ...curated,
      parameterScale: 31,
      requirements: { ...curated.requirements, diskMb: 20_480 },
      runtime: { ...curated.runtime, memoryFootprintMb: 22_528 },
    } as CuratedModel);

    const result = await service.evaluatePull('phi-4-mini');

    expect(result.canPull).toBe(false);
    // 31B parameters at 4 bits each, not the catalog's 22528 MB footprint.
    expect(result.reason).toMatch(
      /weights need at least 14781 MB, more than the 7000 MB of GPU memory this node has for models with nothing else loaded/,
    );
  });

  it('judges a row with no parameter count by its download size', async () => {
    modelRegistry.getCuratedModel.mockReturnValue({
      ...curated,
      requirements: { ...curated.requirements, diskMb: 9_000 },
      runtime: { ...curated.runtime, memoryFootprintMb: 9_900 },
    } as CuratedModel);

    const result = await service.evaluatePull('phi-4-mini');

    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(/at least 9000 MB/);
  });

  it('judges a unified-memory node against its RAM budget, not what is free now', async () => {
    hardwareInspector.getProfile.mockResolvedValue({ ...profile, gpu: { ...profile.gpu, unifiedMemory: true } });
    modelRegistry.getCuratedModel.mockReturnValue({ ...curated, runtime: { ...curated.runtime, memoryFootprintMb: 14_000 } } as CuratedModel);
    // 15000 MB of RAM for models, 12000 of it held by something else right now.
    memoryManager.calculateBudget.mockResolvedValue({
      ...(await memoryManager.calculateBudget(profile)),
      modelUsedRamMb: 12_000,
    });

    const result = await service.evaluatePull('phi-4-mini');

    expect(result.canPull).toBe(true);
  });

  it("refuses a Lemonade model the connected server's registry does not list, naming the registry", async () => {
    const lemonadeRow = { ...curated, id: 'qwen3-8-27b-lemonade', backend: 'lemonade', backendModelId: 'Qwen3.8-27B-GGUF' } as CuratedModel;
    modelRegistry.getCuratedModel.mockReturnValue(lemonadeRow);
    lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    lemonadeBackend.offersModel.mockReturnValue(false);

    const result = await service.evaluatePull('qwen3-8-27b-lemonade');

    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(/lemonade on this node does not list Qwen3\.8-27B-GGUF in its model registry/);
    expect(result.reason).not.toMatch(/hardware tier/);
  });

  it('counts a model Lemonade lists as user.<id> as installed, so a restart does not re-register it', async () => {
    const embedder = {
      ...curated,
      id: 'nomic-embed-text-v1-5-lemonade',
      backend: 'lemonade',
      backendModelId: 'nomic-embed-text-v1.5-GGUF',
      modality: 'embedding',
    } as CuratedModel;
    modelRegistry.getCuratedModel.mockReturnValue(embedder);
    lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['user.nomic-embed-text-v1.5-GGUF'] });

    const result = await service.evaluatePull('nomic-embed-text-v1-5-lemonade');

    expect(result.alreadyInstalled).toBe(true);
  });

  it('loads and unloads under the name the engine knows the model by', async () => {
    const embedder = {
      ...curated,
      id: 'nomic-embed-text-v1-5-lemonade',
      backend: 'lemonade',
      backendModelId: 'nomic-embed-text-v1.5-GGUF',
      modality: 'embedding',
    } as CuratedModel;
    modelRegistry.getCuratedModel.mockReturnValue(embedder);
    lemonadeBackend.engineModelId.mockImplementation((id) => `user.${id}`);

    await service.loadModel('nomic-embed-text-v1-5-lemonade');
    await service.unloadModel('nomic-embed-text-v1-5-lemonade');

    expect(lemonadeBackend.loadModel).toHaveBeenCalledWith('user.nomic-embed-text-v1.5-GGUF', { embedding: true, contextLength: undefined });
    expect(lemonadeBackend.unloadModel).toHaveBeenCalledWith('user.nomic-embed-text-v1.5-GGUF', { embedding: true });
  });

  // L3: the router marks a window it stepped below an app's floor for memory it could not free; the
  // engine is the one that decides not to save it, so the mark must reach it.
  it("hands the engine the router's provisional window mark, and adds nothing when there is none", async () => {
    const gemma = {
      ...curated,
      id: 'gemma4-e4b-lemonade',
      backend: 'lemonade',
      backendModelId: 'Gemma-4-E4B-it-GGUF',
      modality: 'llm',
    } as CuratedModel;
    modelRegistry.getCuratedModel.mockReturnValue(gemma);
    lemonadeBackend.engineModelId.mockImplementation((id) => id);

    await service.loadModel('gemma4-e4b-lemonade', { contextLength: 32_768, provisionalWindow: true });
    await service.loadModel('gemma4-e4b-lemonade', { contextLength: 64_000 });

    expect(lemonadeBackend.loadModel.mock.calls).toEqual([
      ['Gemma-4-E4B-it-GGUF', { embedding: false, contextLength: 32_768, provisionalWindow: true }],
      ['Gemma-4-E4B-it-GGUF', { embedding: false, contextLength: 64_000 }],
    ]);
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
        { provide: OmlxBackend, useValue: mock<OmlxBackend>() },
        InferenceBackendRegistry,
      ],
    }).compile();

    service = moduleRef.get(ModelPullerService);
  });

  // Nest's exception filter turns a plain Error into `INTERNAL_SERVER_ERROR`, so a throw here reached
  // the Settings page as a download that failed for no stated reason.
  it('answers an unknown catalog id with a reason instead of throwing', async () => {
    modelRegistry.getCuratedModel.mockReturnValue(undefined);

    const result = await service.startPull('no-such-model');

    expect(result).toEqual({ catalogId: 'no-such-model', status: 'error', reason: 'Model no-such-model not found in catalog' });
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
    const result = await service.startPull('phi-4-mini', { bestEffort: true });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/disk/i);
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

// The real catalog and registry, sized with the fleet's discrete cards. beta-red's figures are its
// live `GET /api/inference/memory` of 2026-09-29, taken while it served gemma4:e4b: an RTX 3080 with
// 10240 MB, 9728 MB of it for models, 5550 MB in use by the runner. Ollama held that model at
// 3,209 MiB on the card (`/api/ps` size equal to size_vram) against the catalog's 10,813 MB.
describe('ModelPullerService download gate on the fleet', () => {
  const discreteNode = (vramMb: number, ramMb: number): HardwareProfile => ({
    gpu: { available: true, vendor: 'nvidia', model: 'RTX', vramMb, unifiedMemory: false, driverVersion: '1', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: ramMb, availableMb: ramMb - 3396 },
    cpu: { arch: 'x86_64', cores: 12, model: 'CPU' },
    effectiveInferenceMemoryMb: vramMb,
    tier: 'medium',
  });

  async function pullerOn(vramMb: number, ramMb: number, modelUsedVramMb: number) {
    const hardwareInspector = mock<HardwareInspectorService>();
    const memoryManager = mock<MemoryManagerService>();
    const hostMetrics = mock<HostMetricsService>();
    const ollamaBackend = mock<OllamaBackend>();
    const logger = mock<LoggerService>();
    hardwareInspector.getProfile.mockResolvedValue(discreteNode(vramMb, ramMb));
    memoryManager.calculateBudget.mockResolvedValue({
      totalVramMb: vramMb,
      totalRamMb: ramMb,
      systemReservedRamMb: 2048,
      dockerOverheadMb: 0,
      appContainerBudgetMb: 0,
      modelBudgetVramMb: vramMb - 512,
      modelBudgetRamMb: ramMb - 2048,
      modelUsedVramMb,
      modelUsedRamMb: 0,
      pinnedVramMb: 0,
      pinnedRamMb: 0,
      usage: { sampledAt: '2026-09-29T00:00:00.000Z', backends: [] },
    });
    hostMetrics.readHostSection.mockResolvedValue(null);
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 1000,
      diskUsed: 100,
      percentUsed: 10,
      cpuLoad: 0,
      cpuCores: 12,
      memoryTotal: 32,
      memoryUsed: 4,
      percentUsedMemory: 12,
      hasVmWedge: false,
      runtimeKind: 'container-only',
    });
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    ollamaBackend.pullModel.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelPullerService,
        { provide: LoggerService, useValue: logger },
        { provide: ModelRegistryService, useValue: new ModelRegistryService(mock<LoggerService>()) },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: HostMetricsService, useValue: hostMetrics },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: OmlxBackend, useValue: mock<OmlxBackend>() },
        InferenceBackendRegistry,
      ],
    }).compile();
    return { service: moduleRef.get(ModelPullerService), logger, ollamaBackend };
  }

  // gemma4-e4b warned here until its row carried a measured footprint (4,362 MB, not the 10,813
  // derived from its 9.6 GB download), so it now downloads without one.
  it('lets beta-red download gemma4-e4b, the model it serves, without a warning', async () => {
    const { service } = await pullerOn(10_240, 31_017, 5_550);

    const result = await service.evaluatePull('gemma4-e4b');

    expect(result.canPull).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.requiredMemoryMb).toBe(4_362);
  });

  it('lets beta-red download a row that only its derived footprint objects to, with a warning', async () => {
    const { service } = await pullerOn(10_240, 31_017, 5_550);

    const result = await service.evaluatePull('qwen3-14b');

    expect(result.canPull).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.warning).toMatch(/estimates 10475 MB .* more than the 9728 MB of GPU memory .* at least 6675 MB/);
  });

  it('still refuses beta-red a 22.5 GB row such as gemma4-31b', async () => {
    const { service } = await pullerOn(10_240, 31_017, 5_550);

    const result = await service.evaluatePull('gemma4-31b');

    expect(result.canPull).toBe(false);
    expect(result.reason).toMatch(
      /weights need at least 14781 MB, more than the 9728 MB of GPU memory this node has for models with nothing else loaded, so it could never be loaded onto the GPU here/,
    );
  });

  it('lets an 8 GB card (beta-3-glass) download gemma4-e4b', async () => {
    const { service } = await pullerOn(8_192, 31_017, 0);

    const result = await service.evaluatePull('gemma4-e4b');

    expect(result.canPull).toBe(true);
  });

  it('lets a 24 GB card (beta-1) download gemma4-31b without a warning', async () => {
    const { service } = await pullerOn(24_560, 63_000, 0);

    const result = await service.evaluatePull('gemma4-31b');

    expect(result.canPull).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  // App pre-pull (decideModelPrePull -> startPull with bestEffort) is how a fresh node gets its app
  // model, so a refusal there left Hermes and OpenClaw with nothing to run.
  it('queues the app pre-pull of gemma4-e4b on beta-red with nothing to warn about', async () => {
    const { service, logger, ollamaBackend } = await pullerOn(10_240, 31_017, 0);

    const result = await service.startPull('gemma4-e4b', { bestEffort: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.status).toBe('queued');
    expect(ollamaBackend.pullModel).toHaveBeenCalledWith('gemma4:e4b', expect.any(Function));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/The catalog estimates/));
  });

  it('queues an app pre-pull that only the derived footprint objects to, and logs the warning', async () => {
    const { service, logger, ollamaBackend } = await pullerOn(10_240, 31_017, 0);

    const result = await service.startPull('qwen3-14b', { bestEffort: true });
    await new Promise((r) => setTimeout(r, 10));

    expect(result.status).toBe('queued');
    expect(ollamaBackend.pullModel).toHaveBeenCalledWith('qwen3:14b', expect.any(Function));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[ModelPuller\] qwen3-14b: The catalog estimates 10475 MB/));
  });

  // The floor may only ever admit more than the catalog footprint did, never refuse a row the
  // footprint admitted.
  it('never puts a catalog row above its own catalog footprint', () => {
    const registry = new ModelRegistryService(mock<LoggerService>());
    const over = registry.getCatalog().filter((m) => weightsFloorMb(m) > m.runtime.memoryFootprintMb);

    expect(over.map((m) => m.id)).toEqual([]);
  });
});
