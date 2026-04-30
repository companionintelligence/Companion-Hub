import { Test, type TestingModule } from '@nestjs/testing';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { ModelRegistryService } from '../model-registry.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { HardwareProfile, TrackedModel, CuratedModel } from '@ci-hub/common/types';

vi.mock('axios');

describe('InferenceRouterService', () => {
  let service: InferenceRouterService;
  let loggerService: MockProxy<LoggerService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let memoryManager: MockProxy<MemoryManagerService>;
  let modelPuller: MockProxy<ModelPullerService>;
  let cloudFallback: MockProxy<CloudFallbackService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let vllmBackend: MockProxy<VllmBackend>;
  let lemonadeBackend: MockProxy<LemonadeBackend>;

  const defaultProfile: HardwareProfile = {
    gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '535', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: 65536, availableMb: 32768 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
  };

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    hardwareInspector = mock<HardwareInspectorService>();
    modelRegistry = mock<ModelRegistryService>();
    memoryManager = mock<MemoryManagerService>();
    modelPuller = mock<ModelPullerService>();
    cloudFallback = mock<CloudFallbackService>();
    ollamaBackend = mock<OllamaBackend>();
    vllmBackend = mock<VllmBackend>();
    lemonadeBackend = mock<LemonadeBackend>();

    hardwareInspector.getProfile.mockResolvedValue(defaultProfile);
    modelRegistry.getTrackedModels.mockReturnValue([]);
    modelRegistry.getCatalog.mockReturnValue([]);
    modelRegistry.getPinnedModels.mockReturnValue([]);
    modelRegistry.getLoadedModels.mockReturnValue([]);
    cloudFallback.listProviders.mockReturnValue([]);
    cloudFallback.getEnabledProviders.mockReturnValue([]);
    cloudFallback.hasCloudFallback.mockReturnValue(false);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    ollamaBackend.getBaseUrl.mockReturnValue('http://ci-hub-ollama:11434');
    vllmBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    vllmBackend.getBaseUrl.mockReturnValue('http://ci-hub-vllm:8000');
    lemonadeBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    lemonadeBackend.getBaseUrl.mockReturnValue('http://ci-hub-lemonade:13305');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InferenceRouterService,
        { provide: LoggerService, useValue: loggerService },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: MemoryManagerService, useValue: memoryManager },
        { provide: ModelPullerService, useValue: modelPuller },
        { provide: CloudFallbackService, useValue: cloudFallback },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: vllmBackend },
        { provide: LemonadeBackend, useValue: lemonadeBackend },
      ],
    }).compile();

    service = module.get<InferenceRouterService>(InferenceRouterService);
  });

  // ─── S-IR-1: OpenAI-Compatible Endpoints ──────────────────────────

  describe('Model listing (IR-1)', () => {
    it('S-IR-1.5: SHALL return merged model lists from all backends + cloud', async () => {
      modelRegistry.getTrackedModels.mockReturnValue([
        {
          catalogId: 'phi-4-mini',
          backend: 'ollama',
          backendModelId: 'phi4-mini',
          state: 'pinned',
          pinned: true,
          memoryUsedMb: 2600,
          requestCount: 5,
        },
      ]);
      modelRegistry.getCatalog.mockReturnValue([
        { id: 'phi-4-mini', backend: 'ollama', modality: 'llm', runtime: { contextWindow: 16384, maxTokens: 4096 } } as any,
        { id: 'kokoro-v1', backend: 'lemonade', modality: 'tts', runtime: { contextWindow: 0, maxTokens: 0 } } as any,
      ]);
      modelRegistry.getCuratedModel.mockImplementation((id) => {
        if (id === 'phi-4-mini') return { id: 'phi-4-mini', modality: 'llm', runtime: { contextWindow: 16384, maxTokens: 4096 } } as CuratedModel;
        if (id === 'kokoro-v1') return { id: 'kokoro-v1', modality: 'tts', runtime: { contextWindow: 0, maxTokens: 0 } } as CuratedModel;
        return undefined;
      });
      modelRegistry.getTrackedModel.mockImplementation((id) => {
        if (id === 'phi-4-mini') return { catalogId: 'phi-4-mini', state: 'pinned' } as TrackedModel;
        return undefined;
      });
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-test', enabled: true, defaultModel: 'gpt-4o', baseUrl: '' },
      ]);

      const models = await service.listModels();

      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models.find((m) => m.id === 'phi-4-mini')?.state).toBe('pinned');
      expect(models.find((m) => m.id === 'phi-4-mini')?.local).toBe(true);
      expect(models.find((m) => m.id === 'gpt-4o')?.local).toBe(false);
    });
  });

  // ─── S-IR-2: Routing ──────────────────────────────────────────────

  describe('Routing logic (IR-2)', () => {
    it('S-IR-2.2: SHALL route "auto" to default pinned LLM', async () => {
      const pinnedModel: TrackedModel = {
        catalogId: 'phi-4-mini',
        backend: 'ollama',
        backendModelId: 'phi4-mini',
        state: 'pinned',
        pinned: true,
        memoryUsedMb: 2600,
        requestCount: 5,
      };

      modelRegistry.getPinnedModels.mockReturnValue([pinnedModel]);
      modelRegistry.getTrackedModel.mockReturnValue(pinnedModel);
      modelRegistry.getCuratedModel.mockReturnValue({ id: 'phi-4-mini', modality: 'llm' } as CuratedModel);

      const axios = await import('axios');
      (axios.default.post as any) = vi.fn().mockResolvedValue({
        data: { choices: [{ message: { content: 'Hello' } }] },
        headers: {},
      });

      const result = await service.routeChatCompletion({ model: 'auto', messages: [{ role: 'user', content: 'Hi' }] });

      expect(result.backend).toBe('ollama');
    });

    it('S-IR-2.3: SHALL route cloud model prefixes to cloud fallback', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      cloudFallback.resolveProvider.mockReturnValue({
        provider: 'openai',
        apiKey: 'sk-test',
        enabled: true,
        defaultModel: 'gpt-4o',
      });
      cloudFallback.proxyChatCompletion.mockResolvedValue({
        data: { choices: [{ message: { content: 'Hi' } }] },
        headers: {},
      });

      const result = await service.routeChatCompletion({ model: 'gpt-4o', messages: [] });
      expect(result.backend).toContain('cloud');
    });

    it('S-IR-2.5: SHALL return error when no model available', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      modelRegistry.getPinnedModels.mockReturnValue([]);
      modelRegistry.getLoadedModels.mockReturnValue([]);
      cloudFallback.resolveProvider.mockReturnValue(undefined);
      cloudFallback.getEnabledProviders.mockReturnValue([]);

      await expect(service.routeChatCompletion({ model: 'auto', messages: [] })).rejects.toThrow('No models available');
    });
  });

  // ─── Status ───────────────────────────────────────────────────────

  describe('Status', () => {
    it('should return full inference status', async () => {
      memoryManager.calculateBudget.mockReturnValue({
        totalVramMb: 24576,
        totalRamMb: 65536,
        systemReservedRamMb: 2048,
        dockerOverheadMb: 0,
        appContainerBudgetMb: 0,
        modelBudgetVramMb: 24064,
        modelBudgetRamMb: 63488,
        modelUsedVramMb: 0,
        modelUsedRamMb: 0,
        pinnedVramMb: 0,
        pinnedRamMb: 0,
      });

      const status = await service.getStatus();

      expect(status.hardwareTier).toBe('high');
      expect(status.backends).toHaveLength(3);
      expect(status.memoryBudget).toBeDefined();
    });
  });

  // ─── Inference Endpoint ───────────────────────────────────────────

  describe('Inference endpoint', () => {
    it('should return the correct inference endpoint URL', () => {
      const endpoint = service.getInferenceEndpoint();
      expect(endpoint).toContain('/api/inference/v1');
    });
  });
});
