import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { AppCredentialsService } from '../app-credentials.service';
import type { HardwareProfile, InferenceStatus } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';

describe('InferenceController — onboarding-profile', () => {
  let controller: InferenceController;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let memoryManager: MockProxy<MemoryManagerService>;
  let router: MockProxy<InferenceRouterService>;

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
        { provide: AppCredentialsService, useValue: mock<AppCredentialsService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: OllamaBackend, useValue: mock<OllamaBackend>() },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(InferenceController);
    hardwareInspector = moduleRef.get(HardwareInspectorService);
    modelRegistry = moduleRef.get(ModelRegistryService);
    memoryManager = moduleRef.get(MemoryManagerService);
    router = moduleRef.get(InferenceRouterService);
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

    const result = await controller.getOnboardingProfile();

    expect(result.hardware).toEqual(fakeProfile);
    expect(result.tier).toBe('high');
    expect(result.backends.recommended).toBe('vllm');
    expect(result.backends.available).toHaveLength(2);
    expect(result.resourceEstimate.availableMemoryMb).toBeGreaterThanOrEqual(0);
  });

  it('should recommend vllm for AMD GPU with runtime', async () => {
    const amdProfile = { ...fakeProfile, gpu: { ...fakeProfile.gpu, vendor: 'amd' as const } };
    hardwareInspector.getProfile.mockResolvedValue(amdProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
    modelRegistry.getModelsForTier.mockReturnValue([]);
    memoryManager.calculateBudget.mockReturnValue(fakeStatus.memoryBudget);
    router.getStatus.mockResolvedValue(fakeStatus);

    const result = await controller.getOnboardingProfile();
    expect(result.backends.recommended).toBe('vllm');
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
