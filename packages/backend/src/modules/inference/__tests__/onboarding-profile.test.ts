import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { RocmInstallerService } from '../rocm-installer.service';
import { AppCredentialsService } from '../app-credentials.service';
import type { HardwareProfile, InferenceStatus } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { ModelResidencyService } from '../model-residency.service';
import { BackendObserverService } from '../supervision/backend-observer.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { DsparkBackend } from '../backends/dspark.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';

describe('InferenceController — onboarding-profile', () => {
  let controller: InferenceController;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let memoryManager: MockProxy<MemoryManagerService>;
  let router: MockProxy<InferenceRouterService>;
  let hostMetrics: MockProxy<HostMetricsService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let vllmBackend: MockProxy<VllmBackend>;
  let mtplxBackend: MockProxy<MtplxBackend>;
  let dsparkBackend: MockProxy<DsparkBackend>;
  let lemonadeBackend: MockProxy<LemonadeBackend>;
  let luceboxBackend: MockProxy<LuceboxBackend>;

  const fakeProfile: HardwareProfile = {
    gpu: {
      available: true,
      vendor: 'nvidia',
      model: 'RTX 4090',
      vramMb: 24576,
      unifiedMemory: false,
      driverVersion: '550.0',
      runtimeAvailable: true,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: 32768, availableMb: 24000 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
  };

  const fakeStatus: InferenceStatus = {
    hardwareTier: 'high',
    backends: [
      { type: 'ollama', running: true, healthy: true, url: 'http://localhost:11434', modelsLoaded: 0 },
      { type: 'vllm', running: false, healthy: false, url: 'http://localhost:8000', modelsLoaded: 0 },
    ],
    models: [],
    memoryBudget: {
      totalVramMb: 24576,
      totalRamMb: 32768,
      systemReservedRamMb: 2048,
      dockerOverheadMb: 0,
      appContainerBudgetMb: 0,
      modelBudgetVramMb: 24064,
      modelBudgetRamMb: 30720,
      modelUsedVramMb: 0,
      modelUsedRamMb: 0,
      pinnedVramMb: 0,
      pinnedRamMb: 0,
    },
    cloudProviders: [],
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        { provide: InferenceRouterService, useValue: mock<InferenceRouterService>() },
        { provide: HardwareInspectorService, useValue: mock<HardwareInspectorService>() },
        { provide: MemoryManagerService, useValue: mock<MemoryManagerService>() },
        { provide: ModelRegistryService, useValue: mock<ModelRegistryService>() },
        { provide: ModelPullerService, useValue: mock<ModelPullerService>() },
        { provide: CloudFallbackService, useValue: mock<CloudFallbackService>() },
        { provide: OllamaInstallerService, useValue: mock<OllamaInstallerService>() },
        { provide: RocmInstallerService, useValue: mock<RocmInstallerService>() },
        { provide: AppCredentialsService, useValue: mock<AppCredentialsService>() },
        { provide: HostMetricsService, useValue: mock<HostMetricsService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: OllamaBackend, useValue: mock<OllamaBackend>() },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: MtplxBackend, useValue: mock<MtplxBackend>() },
        { provide: DsparkBackend, useValue: mock<DsparkBackend>() },
        { provide: LuceboxBackend, useValue: mock<LuceboxBackend>() },
        InferenceBackendRegistry,
        // The controller exposes GET inference/models/resident, which reads this service's
        // report. Mocked here: nothing in these suites exercises residency.
        { provide: ModelResidencyService, useValue: mock<ModelResidencyService>() },
        // The controller exposes GET inference/supervision, which reads this service's in-memory
        // report. Mocked here: nothing in these suites exercises observation.
        { provide: BackendObserverService, useValue: mock<BackendObserverService>() },
        { provide: PoolProxyService, useValue: mock<PoolProxyService>() },
        { provide: HubPoolPeerService, useValue: mock<HubPoolPeerService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        // `@UseGuards(InferenceAccessGuard)` on the v1 routes registers the guard as an injectable
        // of this module, and its key leg takes ApiKeyService. Mocked here: nothing in these suites
        // dispatches through a guard.
        { provide: ApiKeyService, useValue: mock<ApiKeyService>() },
      ],
    }).compile();

    controller = moduleRef.get(InferenceController);
    hardwareInspector = moduleRef.get(HardwareInspectorService);
    modelRegistry = moduleRef.get(ModelRegistryService);
    memoryManager = moduleRef.get(MemoryManagerService);
    router = moduleRef.get(InferenceRouterService);
    hostMetrics = moduleRef.get(HostMetricsService);
    ollamaBackend = moduleRef.get(OllamaBackend);
    vllmBackend = moduleRef.get(VllmBackend);
    lemonadeBackend = moduleRef.get(LemonadeBackend);
    mtplxBackend = moduleRef.get(MtplxBackend);
    dsparkBackend = moduleRef.get(DsparkBackend);
    luceboxBackend = moduleRef.get(LuceboxBackend);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['phi4-mini'] });
    vllmBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    mtplxBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    dsparkBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    luceboxBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    lemonadeBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    modelRegistry.getCatalog.mockReturnValue([{ id: 'phi-4-mini', backendModelId: 'phi4-mini', backend: 'ollama' }] as any);
    modelRegistry.getModelsForHardware.mockImplementation((tier) => modelRegistry.getModelsForTier(tier));
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    hostMetrics.readHostSection.mockResolvedValue(null);
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 0,
      diskUsed: 0,
      percentUsed: 0,
      cpuLoad: 0,
      cpuCores: 0,
      memoryTotal: 0,
      memoryUsed: 0,
      percentUsedMemory: 0,
      hasVmWedge: false,
      runtimeKind: 'container-only',
    });
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should return aggregated onboarding profile', async () => {
    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile({ backend: 'ollama' });

    expect(result.hardware).toEqual(fakeProfile);
    expect(result.tier).toBe('high');
    expect(result.backends.recommended).toBe('vllm');
    expect(result.backends.available).toHaveLength(2);
    expect(result.resourceEstimate.availableMemoryMb).toBeGreaterThanOrEqual(0);
    expect(result.installedCatalogIds).toEqual(['phi-4-mini']);
  });

  it('maps vLLM served models and Ollama embeddings when backend=vllm', async () => {
    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text:latest'] });
    vllmBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen/Qwen2.5-7B-Instruct'] });
    modelRegistry.getCatalog.mockReturnValue([
      { id: 'phi-4-mini', backendModelId: 'phi4-mini', backend: 'ollama', modality: 'llm' },
      { id: 'nomic-embed-text', backendModelId: 'nomic-embed-text', backend: 'ollama', modality: 'embedding' },
      { id: 'qwen-vllm', backendModelId: 'Qwen/Qwen2.5-7B-Instruct', backend: 'vllm', modality: 'llm' },
    ] as any);

    const result = await controller.getOnboardingProfile({ backend: 'vllm' });

    expect(result.installedCatalogIds).toEqual(expect.arrayContaining(['qwen-vllm', 'nomic-embed-text']));
  });

  it('maps MTPLX served models and Ollama embeddings when backend=mtplx', async () => {
    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text:latest'] });
    mtplxBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed'] });
    modelRegistry.getCatalog.mockReturnValue([
      { id: 'phi-4-mini', backendModelId: 'phi4-mini', backend: 'ollama', modality: 'llm' },
      { id: 'nomic-embed-text', backendModelId: 'nomic-embed-text', backend: 'ollama', modality: 'embedding' },
      { id: 'qwen3-8-27b-mtplx-speed', backendModelId: 'Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed', backend: 'mtplx', modality: 'llm' },
    ] as any);

    const result = await controller.getOnboardingProfile({ backend: 'mtplx' });

    expect(result.installedCatalogIds).toEqual(expect.arrayContaining(['qwen3-8-27b-mtplx-speed', 'nomic-embed-text']));
  });

  it('maps Lemonade models served through its Hub-managed API when backend=lemonade', async () => {
    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);
    lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen3-8B-GGUF'] });
    modelRegistry.getCatalog.mockReturnValue([
      { id: 'nomic-embed-text', backendModelId: 'nomic-embed-text', backend: 'ollama', modality: 'embedding' },
      { id: 'qwen3-8b-lemonade', backendModelId: 'Qwen3-8B-GGUF', backend: 'lemonade', modality: 'llm' },
    ] as any);

    const result = await controller.getOnboardingProfile({ backend: 'lemonade' });

    expect(result.installedCatalogIds).toEqual(['qwen3-8b-lemonade']);
  });

  it('should recommend ollama (not vllm) for AMD GPU with runtime — vLLM has no maintained ROCm image', async () => {
    const amdProfile = { ...fakeProfile, gpu: { ...fakeProfile.gpu, vendor: 'amd' as const } };
    hardwareInspector.getProfile.mockResolvedValue(amdProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.backends.recommended).toBe('ollama');
  });

  it('should recommend ollama for AMD GPU without runtime (Vulkan fallback, no ROCm passthrough)', async () => {
    const amdProfile = { ...fakeProfile, gpu: { ...fakeProfile.gpu, vendor: 'amd' as const, runtimeAvailable: false } };
    hardwareInspector.getProfile.mockResolvedValue(amdProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.backends.recommended).toBe('ollama');
  });

  it('should recommend mlx-dspark for Apple Silicon — real hot-swap via /admin/load, unlike vLLM-Metal', async () => {
    const appleProfile = { ...fakeProfile, gpu: { ...fakeProfile.gpu, vendor: 'apple' as const, unifiedMemory: true, runtimeAvailable: false } };
    hardwareInspector.getProfile.mockResolvedValue(appleProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.backends.recommended).toBe('dspark');
  });

  it('should recommend ollama for nvidia without runtime', async () => {
    const noRuntimeProfile = { ...fakeProfile, gpu: { ...fakeProfile.gpu, runtimeAvailable: false } };
    hardwareInspector.getProfile.mockResolvedValue(noRuntimeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.backends.recommended).toBe('ollama');
  });

  it('should keep a GPU tier for Ollama onboarding when host GPU VRAM is available but container runtime is not', async () => {
    const noRuntimeProfile: HardwareProfile = {
      ...fakeProfile,
      gpu: { ...fakeProfile.gpu, runtimeAvailable: false },
      tier: 'cpu-only',
    };

    hardwareInspector.getProfile.mockResolvedValue(noRuntimeProfile);
    hardwareInspector.computeTier.mockReturnValue('high');
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();

    expect(result.backends.recommended).toBe('ollama');
    expect(result.tier).toBe('high');
    expect(hardwareInspector.computeTier).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeAvailable: true, vramMb: 24576 }),
      noRuntimeProfile.ram,
    );
    expect(modelRegistry.getRecommendedModelsForHardware).toHaveBeenCalledWith('high', noRuntimeProfile);
    expect(modelRegistry.getModelsForTier).toHaveBeenCalledWith('high');
    expect(result.resourceEstimate.availableMemoryMb).toBe(fakeStatus.memoryBudget.modelBudgetVramMb - fakeStatus.memoryBudget.modelUsedVramMb);
  });

  it('should use display disk metrics when legacy host probe has no disk total', async () => {
    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);
    hostMetrics.readHostSection.mockResolvedValue({
      totalRamMb: 98304,
      availableRamMb: 83558,
      cpuCores: 24,
      diskTotalGb: 0,
      diskUsedGb: 0,
      diskMount: '/',
    });
    hostMetrics.getDisplayLoad.mockResolvedValue({
      diskSize: 100,
      diskUsed: 40,
      percentUsed: 40,
      cpuLoad: 0,
      cpuCores: 24,
      memoryTotal: 96,
      memoryUsed: 14,
      percentUsedMemory: 15,
      hasVmWedge: true,
      runtimeKind: 'docker-desktop-vm',
    });

    const result = await controller.getOnboardingProfile();

    expect(hostMetrics.getDisplayLoad).toHaveBeenCalledWith(0, 0);
    expect(result.resourceEstimate.diskTotalMb).toBe(102400);
    expect(result.resourceEstimate.availableDiskMb).toBe(61440);
  });

  it('should calculate resource estimates from recommended models', async () => {
    const fakeModels = [
      { id: 'm1', runtime: { memoryFootprintMb: 4096 }, requirements: { diskMb: 3000 } },
      { id: 'm2', runtime: { memoryFootprintMb: 2048 }, requirements: { diskMb: 1500 } },
    ] as any;

    hardwareInspector.getProfile.mockResolvedValue(fakeProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue(fakeModels);
    modelRegistry.getModelsForTier.mockReturnValue(fakeModels);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.resourceEstimate.totalMemoryMb).toBe(6144);
    expect(result.resourceEstimate.totalDiskMb).toBe(4500);
  });

  it('should use RAM budget for unified memory systems', async () => {
    const unifiedProfile: HardwareProfile = {
      ...fakeProfile,
      gpu: { ...fakeProfile.gpu, unifiedMemory: true },
    };
    hardwareInspector.getProfile.mockResolvedValue(unifiedProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.resourceEstimate.availableMemoryMb).toBe(fakeStatus.memoryBudget.modelBudgetRamMb - fakeStatus.memoryBudget.modelUsedRamMb);
  });

  it('should propagate rescan HttpException from hardware inspector', async () => {
    const err = new HttpException('rescan unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    hardwareInspector.rescan.mockRejectedValue(err);

    await expect(controller.rescanHardware()).rejects.toBe(err);
    expect(hardwareInspector.rescan).toHaveBeenCalledOnce();
  });
});
