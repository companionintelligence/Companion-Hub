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
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
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
  let omlxBackend: MockProxy<OmlxBackend>;
  let configuration: MockProxy<ConfigurationService>;

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
    // No operator preference by default, so every existing case resolves exactly as before.
    configuration.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
      preferredVllmUrl: null,
      preferredOmlxUrl: null,
    });

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
      configuration.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
        preferredVllmUrl: null,
        preferredOmlxUrl: null,
      });
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
      expect(modelPuller.loadModel).toHaveBeenCalledWith('qwen3-8-27b-mtp');
    });

    it('evicts what the memory manager names, then loads, when the model does not fit as is', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 20_000 } } as CuratedModel);
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 8_000, requiredMb: 20_000 });
      memoryManager.getModelsToEvict.mockReturnValue({ canFree: true, modelsToEvict: ['gemma4-e4b'], freedMb: 12_000 });

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.not.toBeNull();
      expect(modelPuller.unloadModel).toHaveBeenCalledWith('gemma4-e4b');
      expect(modelPuller.loadModel).toHaveBeenCalledWith('qwen3-8-27b-mtp');
    });

    it('answers null when nothing can be freed, leaving the engine to decide', async () => {
      modelRegistry.getTrackedModel.mockReturnValue(pulled);
      modelRegistry.getCuratedModel.mockReturnValue({ runtime: { memoryFootprintMb: 20_000 } } as CuratedModel);
      ollamaBackend.isModelLoaded.mockResolvedValue(false);
      memoryManager.canFitModel.mockResolvedValue({ fits: false, availableMb: 8_000, requiredMb: 20_000 });
      memoryManager.getModelsToEvict.mockReturnValue({ canFree: false, modelsToEvict: [], freedMb: 0 });

      await expect(service.prepareTrackedModel('qwen3-8-27b-mtp')).resolves.toBeNull();
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

    it('supports streaming completions with dynamic timeout', async () => {
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
        expect.objectContaining({ responseType: 'stream', timeout: expect.any(Number) }),
      );
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
