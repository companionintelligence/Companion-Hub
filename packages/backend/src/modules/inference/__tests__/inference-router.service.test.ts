import { Test, type TestingModule } from '@nestjs/testing';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { ModelRegistryService } from '../model-registry.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { DsparkBackend } from '../backends/dspark.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import type { HardwareProfile, TrackedModel, CuratedModel } from '@ci-hub/common/types';

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
  let mtplxBackend: MockProxy<MtplxBackend>;
  let dsparkBackend: MockProxy<DsparkBackend>;
  let luceboxBackend: MockProxy<LuceboxBackend>;

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
    mtplxBackend = mock<MtplxBackend>();
    dsparkBackend = mock<DsparkBackend>();
    luceboxBackend = mock<LuceboxBackend>();

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
    mtplxBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    mtplxBackend.getBaseUrl.mockReturnValue('http://ci-hub-mtplx:8000');
    dsparkBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    dsparkBackend.getBaseUrl.mockReturnValue('http://127.0.0.1:8080');
    luceboxBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    luceboxBackend.getBaseUrl.mockReturnValue('http://ci-hub-lucebox:8000');

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
        { provide: MtplxBackend, useValue: mtplxBackend },
        { provide: DsparkBackend, useValue: dsparkBackend },
        { provide: LuceboxBackend, useValue: luceboxBackend },
        InferenceBackendRegistry,
      ],
    }).compile();

    service = module.get<InferenceRouterService>(InferenceRouterService);
  });

  // ─── Model listing ────────────────────────────────────────────────
  // The router surfaces the merged model list + backend health and routes
  // inference requests through local backends or cloud fallback.

  describe('Model listing', () => {
    it('SHALL return merged model lists from all backends + cloud', async () => {
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

    it('includes discovered backend models not present in the catalog', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['llama3:8b'] });

      const models = await service.listModels();

      const discovered = models.find((m) => m.id === 'llama3:8b');
      expect(discovered).toBeDefined();
      expect(discovered?.backend).toBe('ollama');
      expect(discovered?.local).toBe(true);
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
      expect(status.backends).toHaveLength(6);
      expect(status.memoryBudget).toBeDefined();
    });

    it('reports each backend health + url', async () => {
      memoryManager.calculateBudget.mockReturnValue({
        totalVramMb: 0,
        totalRamMb: 0,
        systemReservedRamMb: 0,
        dockerOverheadMb: 0,
        appContainerBudgetMb: 0,
        modelBudgetVramMb: 0,
        modelBudgetRamMb: 0,
        modelUsedVramMb: 0,
        modelUsedRamMb: 0,
        pinnedVramMb: 0,
        pinnedRamMb: 0,
      });

      const status = await service.getStatus();

      const ollama = status.backends.find((b) => b.type === 'ollama');
      expect(ollama?.running).toBe(true);
      expect(ollama?.url).toBe('http://ci-hub-ollama:11434');
    });
  });
  describe('backend probing', () => {
    /**
     * Regression: `getStatus()` used to health-check every backend twice — once in its own parallel
     * fan-out, then again inside `listModels()`, which walked the registry with `await` in a `for`
     * loop. On a node with one backend whose URL does not resolve, Node's `getaddrinfo` blocks for
     * the resolver timeout, so that doubling turned a 5s stall into 10s and blew the 8s budget in
     * `HubPoolPeerService`'s capabilities probe — the peer went permanently unreachable and nothing
     * routed to it.
     */
    it('health-checks each backend exactly once per getStatus(), not twice', async () => {
      const status = await service.getStatus();

      expect(status.backends).toHaveLength(6);
      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, mtplxBackend, dsparkBackend, luceboxBackend]) {
        expect(backend.healthCheck).toHaveBeenCalledTimes(1);
      }
    });

    it('probes backends concurrently, so one stalled backend costs its own latency and not the sum', async () => {
      const STALL_MS = 40;
      let inFlight = 0;
      let peakInFlight = 0;
      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, mtplxBackend, dsparkBackend, luceboxBackend]) {
        backend.healthCheck.mockImplementation(async () => {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, STALL_MS));
          inFlight -= 1;
          return { running: false, healthy: false, modelsLoaded: [] };
        });
      }

      const startedAt = Date.now();
      await service.listModels();
      const elapsed = Date.now() - startedAt;

      // All six overlap. Sequential would be ~6 x STALL_MS; assert well under that rather than
      // pinning a wall-clock figure a slow CI box would flake on.
      expect(peakInFlight).toBe(6);
      expect(elapsed).toBeLessThan(STALL_MS * 4);
    });
    /**
     * Regression: #1277's routing methods each walked the registry with `await backend.healthCheck()`
     * in a `for` loop, and on the `auto` path `resolveAutoModel()` and `routeChatCompletion()`'s
     * step-4 lookup ran back to back — two serial six-backend sweeps per chat request. That is the
     * doubling #1287 removed from `getStatus()`, on a hotter path, and #1287's own tests do not
     * reach it. `routeChatCompletion` now memoizes one sweep and shares it with the resolution.
     */
    it('sweeps the backends at most once per auto chat request, not once per routing step', async () => {
      modelRegistry.getTrackedModels.mockReturnValue([]);
      // ollama must be HEALTHY WITH A RESIDENT MODEL. Otherwise `auto` resolves to nothing and
      // routeChatCompletion returns before step 4 — one sweep happens either way and this test
      // passes whether or not the memo works. It did exactly that until this line was added.
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['resident-model'] });
      for (const backend of [vllmBackend, lemonadeBackend, mtplxBackend, dsparkBackend, luceboxBackend]) {
        backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      }

      await service.routeChatCompletion({ model: 'auto', messages: [] }).catch(() => undefined);

      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, mtplxBackend, dsparkBackend, luceboxBackend]) {
        expect(backend.healthCheck.mock.calls.length).toBeLessThanOrEqual(1);
      }
    });
  });
});
