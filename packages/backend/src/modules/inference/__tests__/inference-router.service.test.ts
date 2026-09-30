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
import { OmlxBackend } from '../backends/omlx.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import axios from 'axios';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import type { HardwareProfile, TrackedModel, CuratedModel, CloudProviderConfig } from '@ci-hub/common/types';
import { firstByteBudgetMs } from '@/modules/hub-pool/hub-pool-budget';
import { InferenceRouteError } from '../inference-error-reply';
import { HubPoolLoadService, LOCAL_CANDIDATE_KEY } from '@/modules/hub-pool/hub-pool-load.service';

vi.mock('axios');

/**
 * No operator preference at all. Typed as the real return shape, so a field added to
 * `getInferencePreferences` fails this one declaration instead of every mock that spells the
 * object out by hand — which is how the two below fell four fields behind without anyone noticing,
 * since test files are outside `pnpm run tsc`.
 */
const NO_PREFERENCES: ReturnType<ConfigurationService['getInferencePreferences']> = {
  preferredBackend: null,
  preferredModel: null,
  preferredEmbeddingModel: null,
  preferredVisionModel: null,
  preferredVllmApiKey: null,
  preferredVllmUrl: null,
  preferredOmlxUrl: null,
  preferredDecodeEndpoint: null,
  preferredEncodeEndpoint: null,
  maxNumCtx: null,
  ollamaSlots: null,
};

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
  let omlxBackend: MockProxy<OmlxBackend>;
  let configuration: MockProxy<ConfigurationService>;
  /** Real: what the pool records as generating is exactly what a load must not evict. */
  let poolLoad: HubPoolLoadService;

  const defaultProfile: HardwareProfile = {
    gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '535', runtimeAvailable: true },
    npu: { available: false, model: '' },
    ram: { totalMb: 65536, availableMb: 32768 },
    cpu: { arch: 'x86_64', cores: 16, model: 'AMD Ryzen 9' },
    effectiveInferenceMemoryMb: 24576,
    tier: 'high',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    loggerService = mock<LoggerService>();
    hardwareInspector = mock<HardwareInspectorService>();
    modelRegistry = mock<ModelRegistryService>();
    memoryManager = mock<MemoryManagerService>();
    modelPuller = mock<ModelPullerService>();
    cloudFallback = mock<CloudFallbackService>();
    ollamaBackend = mock<OllamaBackend>();
    vllmBackend = mock<VllmBackend>();
    lemonadeBackend = mock<LemonadeBackend>();
    omlxBackend = mock<OmlxBackend>();
    configuration = mock<ConfigurationService>();
    poolLoad = new HubPoolLoadService();
    // No operator preference by default, so every existing case resolves exactly as before.
    configuration.getInferencePreferences.mockReturnValue({ ...NO_PREFERENCES });

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
    omlxBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    omlxBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:8000');

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
        { provide: OmlxBackend, useValue: omlxBackend },
        { provide: ConfigurationService, useValue: configuration },
        { provide: HubPoolLoadService, useValue: poolLoad },
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
      memoryManager.calculateBudget.mockResolvedValue({
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
        usage: { sampledAt: '2026-09-20T00:00:00.000Z', backends: [] },
      });

      const status = await service.getStatus();

      expect(status.hardwareTier).toBe('high');
      expect(status.backends).toHaveLength(INFERENCE_BACKEND_TYPES.length);
      expect(status.memoryBudget).toBeDefined();
    });

    it('reports each backend health + url', async () => {
      memoryManager.calculateBudget.mockResolvedValue({
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
        usage: { sampledAt: '2026-09-20T00:00:00.000Z', backends: [] },
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

      expect(status.backends).toHaveLength(INFERENCE_BACKEND_TYPES.length);
      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, omlxBackend]) {
        expect(backend.healthCheck).toHaveBeenCalledTimes(1);
      }
    });

    it('probes backends concurrently, so one stalled backend costs its own latency and not the sum', async () => {
      const STALL_MS = 40;
      let inFlight = 0;
      let peakInFlight = 0;
      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, omlxBackend]) {
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

      // Every backend overlaps. Sequential would be ~n x STALL_MS; assert well under that rather
      // than pinning a tight wall-clock figure a loaded CI box would flake on. Concurrency is
      // directly proved by peakInFlight reaching all backends at once.
      expect(peakInFlight).toBe(INFERENCE_BACKEND_TYPES.length);
      expect(elapsed).toBeLessThan(STALL_MS * 8);
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
      for (const backend of [vllmBackend, lemonadeBackend, omlxBackend]) {
        backend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      }

      await service.routeChatCompletion({ model: 'auto', messages: [] }).catch(() => undefined);

      for (const backend of [ollamaBackend, vllmBackend, lemonadeBackend, omlxBackend]) {
        expect(backend.healthCheck.mock.calls.length).toBeLessThanOrEqual(1);
      }
    });
  });

  // `auto` must mean the same model apps are told is the default (`InferenceEnvResolver` →
  // `DEFAULT_MODEL`), which comes from the operator's preference. beta-max, 2026-09-15: apps were
  // told `qwen3.6:27b`, nothing was pinned, and `auto` ran whatever ollama listed first.
  describe('resolveAutoModel and the operator preference', () => {
    const preferred = (preferredModel: string | null) =>
      configuration.getInferencePreferences.mockReturnValue({ ...NO_PREFERENCES, preferredBackend: 'ollama', preferredModel });
    const curatedQwen36 = { catalogId: 'qwen3-6-27b', backend: 'ollama', backendModelId: 'qwen3.6:27b', modality: 'llm' } as unknown as CuratedModel;

    it('returns the preferred model, as its engine id, when a healthy backend has it', async () => {
      preferred('qwen3-6-27b');
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'qwen3-6-27b' ? curatedQwen36 : undefined));
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['qwen3.8:27b', 'qwen3.6:27b'] });

      expect(await service.resolveAutoModel()).toBe('qwen3.6:27b');
    });

    it('beats a pinned model: the preference is what apps were told', async () => {
      preferred('qwen3-6-27b');
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'qwen3-6-27b' ? curatedQwen36 : ({ modality: 'llm' } as CuratedModel)));
      modelRegistry.getPinnedModels.mockReturnValue([{ catalogId: 'other-llm' } as TrackedModel]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['qwen3.6:27b'] });

      expect(await service.resolveAutoModel()).toBe('qwen3.6:27b');
    });

    it('falls through when the preferred model is not on any healthy backend', async () => {
      preferred('qwen3-6-27b');
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'qwen3-6-27b' ? curatedQwen36 : undefined));
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['qwen3.8:27b'] });

      expect(await service.resolveAutoModel()).toBe('qwen3.8:27b');
    });

    it('does not count the preferred model when only a different backend type lists it', async () => {
      preferred('qwen3-6-27b');
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'qwen3-6-27b' ? curatedQwen36 : undefined));
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      vllmBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['qwen3.6:27b'] });

      expect(await service.resolveAutoModel()).toBe('gemma3:1b');
    });

    it('takes an uncatalogued preference verbatim when the engine lists it', async () => {
      preferred('my-custom:latest');
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['my-custom:latest'] });

      expect(await service.resolveAutoModel()).toBe('my-custom:latest');
    });

    it('skips embedding models in the last-resort fallback, by catalog modality or by name', async () => {
      modelRegistry.getCatalog.mockReturnValue([
        {
          catalogId: 'nomic-embed-text',
          backend: 'ollama',
          backendModelId: 'nomic-embed-text:latest',
          modality: 'embedding',
        } as unknown as CuratedModel,
        { catalogId: 'gemma4-e4b', backend: 'ollama', backendModelId: 'gemma4:e4b', modality: 'llm' } as unknown as CuratedModel,
      ]);
      ollamaBackend.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['nomic-embed-text:latest', 'mxbai-embed-large:latest', 'gemma4:e4b'],
      });

      expect(await service.resolveAutoModel()).toBe('gemma4:e4b');
    });

    it('resolves to nothing when a healthy backend lists only embedding models', async () => {
      modelRegistry.getCatalog.mockReturnValue([]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text:latest'] });

      expect(await service.resolveAutoModel()).toBeUndefined();
    });

    it('probes nothing extra when no preference is set', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['resident-model'] });
      modelRegistry.getPinnedModels.mockReturnValue([{ catalogId: 'pinned-llm' } as TrackedModel]);
      modelRegistry.getCuratedModel.mockReturnValue({ modality: 'llm' } as CuratedModel);

      expect(await service.resolveAutoModel()).toBe('pinned-llm');
      expect(ollamaBackend.healthCheck).not.toHaveBeenCalled();
    });
  });

  // ─── prepareTrackedModel ───────────────────────────────
  // The load-or-evict step, shared with the pool proxy so an app calling the engine's native
  // routes by ENGINE tag gets the same arbitration `auto` always had.
  describe('prepareTrackedModel', () => {
    const pulled = { catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', backend: 'ollama', state: 'pulled' } as TrackedModel;

    it('answers null for a model the Hub does not track, so the caller falls through to the engine', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      modelRegistry.getTrackedModels.mockReturnValue([]);
      await expect(service.prepareTrackedModel('mystery:7b')).resolves.toBeNull();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });

    it('finds a tracked model by its ENGINE tag, which is what every app sends', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      modelRegistry.getTrackedModels.mockReturnValue([{ ...pulled, state: 'pinned' } as TrackedModel]);
      await expect(service.prepareTrackedModel('qwen3.8:27b-mtp-q4_K_M')).resolves.toEqual({
        backend: 'ollama',
        backendModelId: 'qwen3.8:27b-mtp-q4_K_M',
      });
    });

    it('asks the engine first: a `pulled` model that is already resident is marked loaded and NOT reloaded or evicted for', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      ollamaBackend.isModelLoaded.mockResolvedValue(true);

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' });

      expect(modelRegistry.updateModelState).toHaveBeenCalledWith('qwen3-8-27b-mtp', 'loaded');
      expect(memoryManager.canFitModel).not.toHaveBeenCalled();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
      expect(modelPuller.unloadModel).not.toHaveBeenCalled();
    });

    it('loads a `pulled` model that is absent from the engine when it fits', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 20_000 } } as CuratedModel);
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 20_000 });

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.toEqual({ backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' });
      // No window in the catalog: the 8192 fallback, whose ladder KV (2048 MB) the fit check charges on top.
      expect(memoryManager.canFitModel).toHaveBeenCalledWith(defaultProfile, 22_048);
      expect(modelPuller.loadModel).toHaveBeenCalledWith('qwen3-8-27b-mtp', { contextLength: 8192 });
    });

    it('evicts what the memory manager plans, re-measures, then loads, when the model does not fit as is', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      modelRegistry.getCuratedModel.mockImplementation((id) =>
        id === 'gemma4-e4b' ? ({ id } as CuratedModel) : ({ runtime: { memoryFootprintMb: 20_000 } } as CuratedModel),
      );
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      memoryManager.canFitModel
        .mockResolvedValueOnce({ fits: false, availableMb: 8_000, requiredMb: 20_000 })
        .mockResolvedValueOnce({ fits: true, availableMb: 20_000, requiredMb: 20_000 });
      memoryManager.planEviction.mockResolvedValue({
        canFree: true,
        candidates: [{ backend: 'ollama', backendModelId: 'gemma4:e4b', catalogId: 'gemma4-e4b', estimatedMb: 12_000 }],
        freedMb: 12_000,
        busy: [],
      });

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.not.toBeNull();
      // An app's request: only the Hub's own loads may go, and never one that is generating.
      expect(memoryManager.planEviction).toHaveBeenCalledWith(
        defaultProfile,
        14_048,
        { backend: 'ollama', backendModelId: 'qwen3.8:27b-mtp-q4_K_M' },
        { scope: 'request', generating: expect.any(Function) },
      );
      expect(modelPuller.unloadModel).toHaveBeenCalledWith('gemma4-e4b');
      expect(memoryManager.invalidateObservation).toHaveBeenCalled();
      expect(modelPuller.loadModel).toHaveBeenCalledWith('qwen3-8-27b-mtp', { contextLength: 8192 });
    });

    it('answers null when nothing can be freed, leaving the engine to decide', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 20_000 } } as CuratedModel);
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 8_000, requiredMb: 20_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: false, candidates: [], freedMb: 0, busy: [] });

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.toBeNull();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });

    it('finds a tracked model whatever the app calls it under :latest', async () => {
      const embedder = { catalogId: 'nomic-embed-text', backendModelId: 'nomic-embed-text', backend: 'ollama', state: 'loaded' } as TrackedModel;
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      modelRegistry.getTrackedModels.mockReturnValue([embedder]);

      await expect(service.prepareTrackedModel('nomic-embed-text:latest')).resolves.toEqual({
        backend: 'ollama',
        backendModelId: 'nomic-embed-text',
      });
    });
  });

  // ─── loadTrackedModel ──────────────────────────────────
  // The load path the pin endpoint now shares. The pin used to load with no fit check, which put
  // a Lemonade 27B onto a 24 GiB card where ci-server's Ollama 27B already sat.
  describe('loadTrackedModel', () => {
    const lemonadeModel = {
      id: 'qwen3-8-27b-lemonade',
      backend: 'lemonade',
      backendModelId: 'Qwen3.8-27B-GGUF',
      runtime: { memoryFootprintMb: 18_000, contextWindow: 262_144 },
    } as CuratedModel;
    const ollamaResident = { backend: 'ollama' as const, backendModelId: 'qwen3.8:27b-mtp-q4_K_M', catalogId: null, estimatedMb: 17_000 };

    beforeEach(() => {
      modelRegistry.getTrackedModel.mockReturnValue({
        catalogId: lemonadeModel.id,
        backend: 'lemonade',
        backendModelId: 'Qwen3.8-27B-GGUF',
        state: 'pulled',
      } as TrackedModel);
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === lemonadeModel.id ? lemonadeModel : undefined));
      lemonadeBackend.isModelLoaded.mockResolvedValue(false);
      vi.spyOn(service as unknown as { delay: (ms: number) => Promise<void> }, 'delay').mockResolvedValue(undefined);
    });

    it('unloads a model the Hub never loaded directly on its engine, for an operator, then loads', async () => {
      memoryManager.canFitModel
        .mockResolvedValueOnce({ fits: false, availableMb: 6_000, requiredMb: 18_000 })
        .mockResolvedValueOnce({ fits: false, availableMb: 6_000, requiredMb: 18_000 })
        .mockResolvedValueOnce({ fits: true, availableMb: 23_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: true, candidates: [ollamaResident], freedMb: 17_000, busy: [] });

      await expect(service.loadTrackedModel(lemonadeModel.id, { scope: 'operator' })).resolves.toEqual({ loaded: true });

      expect(memoryManager.planEviction.mock.calls[0]?.[3]).toMatchObject({ scope: 'operator' });
      expect(ollamaBackend.unloadModel).toHaveBeenCalledWith('qwen3.8:27b-mtp-q4_K_M');
      expect(modelPuller.unloadModel).not.toHaveBeenCalled();
      // The first re-measure still showed the old model; the second, after a settle wait, did not.
      expect(memoryManager.canFitModel).toHaveBeenCalledTimes(3);
      expect(modelPuller.loadModel).toHaveBeenCalledWith(lemonadeModel.id, { contextLength: 16_384 });
    });

    it("tells the plan what the pool has generating on each engine, from the pool's own record", async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: false, candidates: [], freedMb: 0, busy: [] });
      const hermesTurn = { backend: 'ollama' as const, model: 'gemma4:e4b', numCtx: 65_536 };
      poolLoad.acquire(LOCAL_CANDIDATE_KEY, hermesTurn);

      await service.loadTrackedModel(lemonadeModel.id, { scope: 'operator' });

      const generating = memoryManager.planEviction.mock.calls[0]?.[3].generating;
      expect(generating?.('ollama')).toEqual([{ model: 'gemma4:e4b', numCtx: 65_536 }]);
      expect(generating?.('lemonade')).toEqual([]);
      poolLoad.release(LOCAL_CANDIDATE_KEY, hermesTurn);
    });

    it("plans as an app's request unless the caller says it is an operator", async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: false, candidates: [], freedMb: 0, busy: [] });

      await service.loadTrackedModel(lemonadeModel.id);

      expect(memoryManager.planEviction.mock.calls[0]?.[3]).toMatchObject({ scope: 'request' });
    });

    // REQ3 (c): unloading and then refusing is the worst of both — the pool forwards the request
    // anyway, and whatever was evicted reloads cold on its app's next turn.
    it('loads once its plan has unloaded, even when the re-measure has not caught up', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: true, candidates: [ollamaResident], freedMb: 17_000, busy: [] });

      const outcome = await service.loadTrackedModel(lemonadeModel.id);

      expect(outcome).toEqual({ loaded: true });
      expect(ollamaBackend.unloadModel).toHaveBeenCalledWith('qwen3.8:27b-mtp-q4_K_M');
      expect(modelPuller.loadModel).toHaveBeenCalledWith(lemonadeModel.id, { contextLength: 16_384 });
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('has not shown up yet'));
    });

    it('refuses rather than loading on top when the engine refused an unload and memory never freed', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: true, candidates: [ollamaResident], freedMb: 17_000, busy: [] });
      ollamaBackend.unloadModel.mockRejectedValueOnce(new Error('boom'));

      const outcome = await service.loadTrackedModel(lemonadeModel.id);

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('the engine refused to unload') });
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });

    it('refuses without unloading anything when the plan cannot free enough', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: false, candidates: [], freedMb: 2_000, busy: [] });

      const outcome = await service.loadTrackedModel(lemonadeModel.id);

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('would free 2000 MB') });
      expect(ollamaBackend.unloadModel).not.toHaveBeenCalled();
      expect(modelPuller.unloadModel).not.toHaveBeenCalled();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });

    it('names the busy models in a refusal', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 6_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({ canFree: false, candidates: [], freedMb: 0, busy: ['gemma4:e4b'] });

      const outcome = await service.loadTrackedModel(lemonadeModel.id, { scope: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('gemma4:e4b is serving a request and will not be unloaded') });
      expect(outcome).toEqual({ loaded: false, reason: expect.stringContaining('every idle unpinned model') });
    });

    it('keeps going when one unload fails, and lets the re-measure decide', async () => {
      memoryManager.canFitModel
        .mockResolvedValueOnce({ fits: false, availableMb: 6_000, requiredMb: 18_000 })
        .mockResolvedValueOnce({ fits: true, availableMb: 20_000, requiredMb: 18_000 });
      memoryManager.planEviction.mockResolvedValue({
        canFree: true,
        candidates: [ollamaResident, { backend: 'ollama', backendModelId: 'gemma4:e4b', catalogId: null, estimatedMb: 3_000 }],
        freedMb: 20_000,
        busy: [],
      });
      ollamaBackend.unloadModel.mockRejectedValueOnce(new Error('boom'));

      await expect(service.loadTrackedModel(lemonadeModel.id)).resolves.toEqual({ loaded: true });
      expect(ollamaBackend.unloadModel).toHaveBeenCalledTimes(2);
    });

    // R7: evicting first and only then finding the model was never downloaded left a 500 and the
    // other apps' models gone.
    it('refuses a model that is not downloaded here before planning or unloading anything', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Gemma-4-E4B-it-GGUF'] });

      const outcome = await service.loadTrackedModel(lemonadeModel.id, { scope: 'operator' });

      expect(outcome).toEqual({ loaded: false, reason: `${lemonadeModel.id} is not downloaded on this node; pull it first` });
      expect(memoryManager.canFitModel).not.toHaveBeenCalled();
      expect(memoryManager.planEviction).not.toHaveBeenCalled();
      expect(ollamaBackend.unloadModel).not.toHaveBeenCalled();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });

    it("loads an untracked model the engine's inventory lists", async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen3.8-27B-GGUF'] });
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });

      await expect(service.loadTrackedModel(lemonadeModel.id)).resolves.toEqual({ loaded: true });
      expect(modelPuller.loadModel).toHaveBeenCalled();
    });

    it("answers a failed load as a refusal with the engine's reason, not a throw", async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });
      modelPuller.loadModel.mockRejectedValueOnce(new Error('model "Qwen3.8-27B-GGUF" not found'));

      await expect(service.loadTrackedModel(lemonadeModel.id)).resolves.toEqual({
        loaded: false,
        reason: `Loading ${lemonadeModel.id} failed: model "Qwen3.8-27B-GGUF" not found`,
      });
      expect(memoryManager.invalidateObservation).toHaveBeenCalled();
    });

    it('drops the cached memory reading after a load, so the next plan sees the new model', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });

      await service.loadTrackedModel(lemonadeModel.id);

      const loadedAt = modelPuller.loadModel.mock.invocationCallOrder[0] ?? 0;
      const invalidatedAt = memoryManager.invalidateObservation.mock.invocationCallOrder.at(-1) ?? 0;
      expect(invalidatedAt).toBeGreaterThan(loadedAt);
    });

    // R5: two loads planning against the same free memory both went ahead; a second load of the
    // same model loaded it again.
    it('runs one load at a time, and a second load of the same model finds it resident', async () => {
      let resident = false;
      lemonadeBackend.isModelLoaded.mockImplementation(async () => resident);
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });
      let finishLoad!: () => void;
      modelPuller.loadModel.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishLoad = () => {
              resident = true;
              resolve();
            };
          }),
      );

      const first = service.loadTrackedModel(lemonadeModel.id);
      const second = service.loadTrackedModel(lemonadeModel.id);
      await vi.waitFor(() => expect(modelPuller.loadModel).toHaveBeenCalledTimes(1));
      // The second is queued behind the first: it has not even asked the engine yet.
      expect(lemonadeBackend.isModelLoaded).toHaveBeenCalledTimes(1);

      finishLoad();
      await expect(first).resolves.toEqual({ loaded: true });
      await expect(second).resolves.toEqual({ loaded: true });
      expect(modelPuller.loadModel).toHaveBeenCalledTimes(1);
    });

    it('lets the next load run after one that threw', async () => {
      lemonadeBackend.isModelLoaded.mockRejectedValueOnce(new Error('probe blew up')).mockResolvedValue(false);
      hardwareInspector.getProfile.mockRejectedValueOnce(new Error('inspector down'));
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });

      await expect(service.loadTrackedModel(lemonadeModel.id)).rejects.toThrow('inspector down');
      await expect(service.loadTrackedModel(lemonadeModel.id)).resolves.toEqual({ loaded: true });
    });

    // ── the window a load is sized at ──
    // The same number the Hub hands its apps as CI_LLM_NUM_CTX, so Ollama's first app request does
    // not reload the model and Lemonade (which takes no window per request) serves the one apps expect.

    it('sizes a Lemonade load by the ladder, and fit-checks what the model will hold at that window', async () => {
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 22_096 });

      await service.loadTrackedModel(lemonadeModel.id);

      // 24576 - 18000 = 6576 MB free for context → the 16k rung, charged at the ladder's 0.25 MB/token.
      expect(memoryManager.canFitModel).toHaveBeenCalledWith(defaultProfile, 18_000 + 16_384 * 0.25);
      expect(modelPuller.loadModel).toHaveBeenCalledWith(lemonadeModel.id, { contextLength: 16_384 });
    });

    it("uses the engine's measured per-token cost when it has one", async () => {
      const ollamaModel = {
        id: 'qwen3-8-27b-mtp',
        backend: 'ollama',
        backendModelId: 'qwen3.8:27b-mtp-q4_K_M',
        runtime: { memoryFootprintMb: 18_000, contextWindow: 262_144 },
      } as CuratedModel;
      modelRegistry.getTrackedModel.mockReturnValue({
        catalogId: ollamaModel.id,
        backend: 'ollama',
        backendModelId: ollamaModel.backendModelId,
        state: 'pulled',
      } as TrackedModel);
      modelRegistry.getCuratedModel.mockReturnValue(ollamaModel);
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      ollamaBackend.contextCostForModel.mockResolvedValue({ kvMbPerToken: 0.0625, weightMb: 16_000, source: 'geometry' });
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 23_120 });

      await service.loadTrackedModel(ollamaModel.id);

      // 24576 - 18000 - 1024 margin = 5552 MB; 65536 × 0.0625 = 4096 fits, the top unprompted rung.
      expect(memoryManager.canFitModel).toHaveBeenCalledWith(defaultProfile, 18_000 + 4_096 + 1_024);
      expect(modelPuller.loadModel).toHaveBeenCalledWith(ollamaModel.id, { contextLength: 65_536 });
    });

    it("caps the window at the operator's stated engine context", async () => {
      configuration.getInferencePreferences.mockReturnValue({ ...configuration.getInferencePreferences(), maxNumCtx: 8192 } as never);
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 20_048 });

      await service.loadTrackedModel(lemonadeModel.id);

      expect(modelPuller.loadModel).toHaveBeenCalledWith(lemonadeModel.id, { contextLength: 8192 });
    });

    it('sends no window for an embedding model', async () => {
      modelRegistry.getCuratedModel.mockReturnValue({ ...lemonadeModel, modality: 'embedding' } as CuratedModel);
      memoryManager.canFitModel.mockResolvedValue({ fits: true, availableMb: 24_000, requiredMb: 18_000 });

      await service.loadTrackedModel(lemonadeModel.id);

      expect(memoryManager.canFitModel).toHaveBeenCalledWith(defaultProfile, 18_000);
      expect(modelPuller.loadModel).toHaveBeenCalledWith(lemonadeModel.id, undefined);
    });

    it('tracks a model the engine already holds as loaded without touching memory', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      lemonadeBackend.isModelLoaded.mockResolvedValue(true);

      await expect(service.loadTrackedModel(lemonadeModel.id)).resolves.toEqual({ loaded: true });
      expect(modelRegistry.trackModel).toHaveBeenCalledWith(lemonadeModel.id, 'loaded');
      expect(memoryManager.canFitModel).not.toHaveBeenCalled();
      expect(modelPuller.loadModel).not.toHaveBeenCalled();
    });
  });

  // ─── routeCompletion ─────────────────────────────────
  describe('routeCompletion', () => {
    it('routes text completions to /v1/completions on the active backend', async () => {
      const tracked = { catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', backend: 'ollama', state: 'loaded' } as TrackedModel;
      modelRegistry.getTrackedModel.mockReturnValue(tracked);
      modelRegistry.getTrackedModels.mockReturnValue([tracked]);
      vi.mocked(axios.post).mockResolvedValueOnce({ data: { id: 'cmpl-123', choices: [{ text: 'console.log("hello")' }] }, headers: {} });

      const res = await service.routeCompletion({ model: 'qwen3.8:27b-mtp-q4_K_M', prompt: 'function greet() {' });
      expect(res.backend).toBe('ollama');
      expect(axios.post).toHaveBeenCalledWith(
        'http://ci-hub-ollama:11434/v1/completions',
        expect.objectContaining({ model: 'qwen3.8:27b-mtp-q4_K_M', prompt: 'function greet() {' }),
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });

    it('streams completions under a first-byte deadline, not an axios timeout', async () => {
      const tracked = { catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', backend: 'ollama', state: 'loaded' } as TrackedModel;
      modelRegistry.getTrackedModel.mockReturnValue(tracked);
      modelRegistry.getTrackedModels.mockReturnValue([tracked]);
      const mockStream = {} as NodeJS.ReadableStream;
      vi.mocked(axios.post).mockResolvedValueOnce({ data: mockStream, headers: {} });

      const res = await service.routeCompletion({ model: 'qwen3.8:27b-mtp-q4_K_M', prompt: 'hello', stream: true });
      expect(res.stream).toBe(mockStream);
      expect(axios.post).toHaveBeenCalledWith(
        'http://ci-hub-ollama:11434/v1/completions',
        expect.anything(),
        expect.objectContaining({ responseType: 'stream', timeout: 0, signal: expect.any(AbortSignal) }),
      );
    });

    it('answers a model nothing serves with a 404 model_not_found, not a bare Error the controller turned into a 502', async () => {
      const err = await service.routeCompletion({ model: 'nope:1b', prompt: 'def f(' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InferenceRouteError);
      expect(err).toMatchObject({ status: 404, type: 'invalid_request_error', code: 'model_not_found' });
      expect(axios.post).not.toHaveBeenCalled();
    });

    const cloud = (provider: CloudProviderConfig['provider'], baseUrl: string): CloudProviderConfig => ({
      provider,
      enabled: true,
      apiKey: 'sk-test',
      baseUrl,
      defaultModel: 'whatever',
    });

    it('refuses the cloud fallback to Anthropic, which has no /completions, with a 400 that says so — and sends nothing', async () => {
      cloudFallback.resolveProvider.mockReturnValue(cloud('anthropic', 'https://api.anthropic.com/v1'));

      const err = await service.routeCompletion({ model: 'claude-sonnet-4-5', prompt: 'def f(' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InferenceRouteError);
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'unsupported_endpoint' });
      expect((err as Error).message).toMatch(/anthropic.*\/v1\/chat\/completions/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it.each([
      ['google', 'https://generativelanguage.googleapis.com/v1beta/openai'],
      ['github-copilot', 'https://api.githubcopilot.com'],
    ] as const)('refuses the fallback to %s too, whose OpenAI-compatible surface is chat-only', async (provider, baseUrl) => {
      cloudFallback.resolveProvider.mockReturnValue(cloud(provider, baseUrl));
      await expect(service.routeCompletion({ model: 'some-model', prompt: 'x' })).rejects.toMatchObject({ status: 400 });
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('still falls back to OpenAI, which has the route', async () => {
      cloudFallback.resolveProvider.mockReturnValue(cloud('openai', 'https://api.openai.com/v1'));
      vi.mocked(axios.post).mockResolvedValueOnce({ data: { object: 'text_completion' }, headers: {} });

      const res = await service.routeCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x' });
      expect(res.backend).toBe('cloud:openai');
      // A whole answer gets the pool completion budget, not the 120 s it had.
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/completions',
        expect.anything(),
        expect.objectContaining({ timeout: 300_000 }),
      );
    });

    it('streams the OpenAI fallback under a header deadline, not an axios timeout that would cut a pause mid-stream', async () => {
      cloudFallback.resolveProvider.mockReturnValue(cloud('openai', 'https://api.openai.com/v1'));
      const mockStream = {} as NodeJS.ReadableStream;
      vi.mocked(axios.post).mockResolvedValueOnce({ data: mockStream, headers: {} });

      const res = await service.routeCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x', stream: true });

      expect(res.stream).toBe(mockStream);
      expect(axios.post).toHaveBeenCalledWith(
        'https://api.openai.com/v1/completions',
        expect.anything(),
        expect.objectContaining({ responseType: 'stream', timeout: 0, signal: expect.any(AbortSignal) }),
      );
    });

    it("abandons the OpenAI fallback when its client leaves: a stream's signal stays armed past the headers, a whole answer gets it as is", async () => {
      cloudFallback.resolveProvider.mockReturnValue(cloud('openai', 'https://api.openai.com/v1'));
      const clientClosed = new AbortController();
      vi.mocked(axios.post).mockResolvedValueOnce({ data: {} as NodeJS.ReadableStream, headers: {} });
      await service.routeCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x', stream: true }, clientClosed.signal);
      const streamed = vi.mocked(axios.post).mock.calls[0]?.[2]?.signal as AbortSignal;

      vi.mocked(axios.post).mockResolvedValueOnce({ data: { object: 'text_completion' }, headers: {} });
      await service.routeCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x' }, clientClosed.signal);
      expect(vi.mocked(axios.post).mock.calls[1]?.[2]).toMatchObject({ signal: clientClosed.signal });

      expect(streamed.aborted).toBe(false);
      clientClosed.abort();
      expect(streamed.aborted).toBe(true);
    });
  });

  // ─── How long a local request may wait ───────────────
  // The local path uses the pool's budgets. Before this, a streamed request got max(120 s, prompt)
  // and the pool max(300 s, prompt): the same prompt on the same CPU-bound node was cut locally at
  // two minutes and waited for through the pool.
  describe('local request budget', () => {
    const tracked = { catalogId: 'qwen3-8-27b-mtp', backendModelId: 'qwen3.8:27b-mtp-q4_K_M', backend: 'ollama', state: 'loaded' } as TrackedModel;
    const streamedTurn = (promptChars: number) => ({
      model: 'qwen3.8:27b-mtp-q4_K_M',
      messages: [{ role: 'user', content: 'x'.repeat(promptChars) }],
      stream: true,
    });

    beforeEach(() => {
      modelRegistry.getTrackedModel.mockReturnValue(tracked);
      modelRegistry.getTrackedModels.mockReturnValue([tracked]);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** An engine that never answers: the request settles only when its signal aborts it. */
    function engineThatNeverAnswers(): { signal: () => AbortSignal | undefined } {
      let signal: AbortSignal | undefined;
      vi.mocked(axios.post).mockImplementationOnce((_url, _body, config) => {
        signal = config?.signal as AbortSignal;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('canceled'))));
      });
      return { signal: () => signal };
    }

    it('gives a streamed 19 KB prompt the pool floor of 300 s to first byte, where it used to get 120 s', async () => {
      const engine = engineThatNeverAnswers();
      const outcome = service.routeChatCompletion(streamedTurn(19_000)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(axios.post).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ responseType: 'stream', timeout: 0 }));

      await vi.advanceTimersByTimeAsync(121_000);
      expect(engine.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(300_000 - 121_000 - 1);
      expect(engine.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.signal()?.aborted).toBe(true);

      const err = await outcome;
      expect((err as Error).message).toMatch(/no response headers within 300000ms/);
    });

    it("scales a big prompt's budget exactly as the pool does", async () => {
      const body = streamedTurn(160_000);
      const budget = firstByteBudgetMs(Buffer.byteLength(JSON.stringify(body)));
      expect(budget).toBeGreaterThanOrEqual(800_000);
      const engine = engineThatNeverAnswers();
      const outcome = service.routeChatCompletion(body).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(engine.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.signal()?.aborted).toBe(true);
      await outcome;
    });

    it('never aborts a stream once the engine has answered, however long the generation or its pauses', async () => {
      const upstream = new PassThrough();
      let config: { signal?: AbortSignal; timeout?: number } | undefined;
      vi.mocked(axios.post).mockImplementationOnce(async (_url, _body, cfg) => {
        config = cfg as typeof config;
        // A cold load: headers after 250 s, inside the 300 s budget.
        await new Promise((resolve) => setTimeout(resolve, 250_000));
        return { data: upstream, headers: {} };
      });

      const pending = service.routeChatCompletion(streamedTurn(19_000));
      await vi.advanceTimersByTimeAsync(250_000);
      const result = await pending;
      expect(result.stream).toBe(upstream);

      // An hour of generation, with a five-minute silence between tokens — as long as the budget.
      for (let minute = 0; minute < 60; minute += 5) {
        upstream.write('data: {"choices":[{"delta":{"content":"."}}]}\n\n');
        await vi.advanceTimersByTimeAsync(300_000);
      }
      expect(config?.signal?.aborted).toBe(false);
      expect(config?.timeout).toBe(0);
      expect(upstream.destroyed).toBe(false);
      // Nothing left armed that could fire later.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives a non-streamed request the pool completion budget, at least 300 s for the whole generation', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({ data: { object: 'chat.completion' }, headers: {} });
      await service.routeChatCompletion({ ...streamedTurn(19_000), stream: false });
      expect(axios.post).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ timeout: 300_000 }));
    });
  });

  // ─── Lemonade audio ───────────────────────────────────
  // Lemonade's health and model list send LEMONADE_API_KEY (#1664); the audio calls did not, so a
  // Lemonade that enforces a key read healthy and then answered every TTS/STT call with a 401.
  describe('Lemonade audio routes', () => {
    const LEMONADE_KEY = 'lemonade-test-key';

    beforeEach(() => {
      lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['kokoro-v1', 'whisper-v3-turbo'] });
      lemonadeBackend.getApiKey.mockReturnValue(undefined);
    });

    const speak = async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({ data: new ArrayBuffer(4), headers: {} });
      await expect(service.routeTts({ model: 'kokoro-v1', input: 'hello', voice: 'af_sky' })).resolves.toMatchObject({ backend: 'lemonade' });
      expect(axios.post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/audio/speech', expect.anything(), expect.anything());
      return vi.mocked(axios.post).mock.calls[0]?.[2];
    };

    const transcribe = async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({ data: { text: 'hello' }, headers: {} });
      await expect(service.routeStt(new FormData())).resolves.toMatchObject({ backend: 'lemonade' });
      expect(axios.post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/audio/transcriptions', expect.any(FormData), expect.anything());
      return vi.mocked(axios.post).mock.calls[0]?.[2];
    };

    it('sends the Lemonade API key on /v1/audio/speech when one is configured', async () => {
      lemonadeBackend.getApiKey.mockReturnValue(LEMONADE_KEY);
      const config = await speak();
      expect(config?.headers).toEqual({ Authorization: `Bearer ${LEMONADE_KEY}` });
      expect(config).toMatchObject({ responseType: 'arraybuffer' });
    });

    it('sends the Lemonade API key on /v1/audio/transcriptions when one is configured', async () => {
      lemonadeBackend.getApiKey.mockReturnValue(LEMONADE_KEY);
      const config = await transcribe();
      expect(config?.headers).toEqual({ Authorization: `Bearer ${LEMONADE_KEY}` });
    });

    it('sends no Authorization header on either audio route when no key is configured', async () => {
      const ttsConfig = await speak();
      expect(ttsConfig?.headers?.Authorization).toBeUndefined();
      vi.mocked(axios.post).mockClear();
      const sttConfig = await transcribe();
      expect(sttConfig?.headers?.Authorization).toBeUndefined();
    });
  });

  // ─── Tool-calling error preservation ─────────────────
  describe('tool calling error preservation', () => {
    it('preserves 400 errors from backend instead of silently stripping tools and retrying', async () => {
      const tracked = { catalogId: 'qwen3-0-6b', backendModelId: 'qwen3:0.6b', backend: 'ollama', state: 'loaded' } as TrackedModel;
      modelRegistry.getTrackedModel.mockReturnValue(tracked);
      modelRegistry.getTrackedModels.mockReturnValue([tracked]);

      const error400 = new Error('Request failed with status code 400');
      (error400 as unknown as { isAxiosError: boolean; response: { status: number; data: { error: string } } }).isAxiosError = true;
      (error400 as unknown as { response: { status: number; data: { error: string } } }).response = {
        status: 400,
        data: { error: 'model does not support tools' },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      vi.mocked(axios.post).mockRejectedValueOnce(error400);

      const bodyWithTools = {
        model: 'qwen3:0.6b',
        messages: [{ role: 'user', content: 'what is the weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
      };

      await expect(service.routeChatCompletion(bodyWithTools)).rejects.toThrow('Request failed with status code 400');
      // Must NOT have retried a second time with tools stripped
      expect(axios.post).toHaveBeenCalledTimes(1);
    });
  });
});
