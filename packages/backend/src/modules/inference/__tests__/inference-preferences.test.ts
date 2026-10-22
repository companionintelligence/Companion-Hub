import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService, type SetInferencePreferencesOptions } from '@/core/config/configuration.service';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';

vi.mock('../../app-lifecycle/app-lifecycle.service', () => ({
  AppLifecycleService: class AppLifecycleService {},
}));
// The controller reaches the refresh service lazily; the stub class is the token the test module provides.
vi.mock('../../app-lifecycle/ai-app-inference-refresh.service', () => ({
  AiAppInferenceRefreshService: class AiAppInferenceRefreshService {},
}));

import { AiAppInferenceRefreshService } from '../../app-lifecycle/ai-app-inference-refresh.service';

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
import { MASKED_API_KEY, inferencePreferencesSchema } from '../inference.dto';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { ModelResidencyService } from '../model-residency.service';
import { BackendObserverService } from '../supervision/backend-observer.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OmlxBackend } from '../backends/omlx.backend';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';

describe('InferenceController — preferences', () => {
  let controller: InferenceController;
  let configService: MockProxy<ConfigurationService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let lemonadeBackend: MockProxy<LemonadeBackend>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let inferenceRefresh: { requestRefresh: ReturnType<typeof vi.fn> };
  let appCredentials: MockProxy<AppCredentialsService>;
  let cloudFallback: MockProxy<CloudFallbackService>;

  beforeEach(async () => {
    inferenceRefresh = { requestRefresh: vi.fn() };
    appCredentials = mock<AppCredentialsService>();
    const moduleRef = await Test.createTestingModule({
      controllers: [InferenceController],
      providers: [
        { provide: AiAppInferenceRefreshService, useValue: inferenceRefresh },
        { provide: InferenceRouterService, useValue: mock<InferenceRouterService>() },
        { provide: HardwareInspectorService, useValue: mock<HardwareInspectorService>() },
        { provide: MemoryManagerService, useValue: mock<MemoryManagerService>() },
        { provide: ModelRegistryService, useValue: mock<ModelRegistryService>() },
        { provide: ModelPullerService, useValue: mock<ModelPullerService>() },
        { provide: CloudFallbackService, useValue: mock<CloudFallbackService>() },
        { provide: OllamaInstallerService, useValue: mock<OllamaInstallerService>() },
        { provide: RocmInstallerService, useValue: mock<RocmInstallerService>() },
        { provide: AppCredentialsService, useValue: appCredentials },
        // AppContainerOriginGuard (on the bootstrap-handout routes) is built with the controller.
        { provide: DockerReadFacade, useValue: mock<DockerReadFacade>() },
        { provide: HostMetricsService, useValue: mock<HostMetricsService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: OllamaBackend, useValue: mock<OllamaBackend>() },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: OmlxBackend, useValue: mock<OmlxBackend>() },
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
    configService = moduleRef.get(ConfigurationService);
    ollamaBackend = moduleRef.get(OllamaBackend);
    lemonadeBackend = moduleRef.get(LemonadeBackend);
    modelRegistry = moduleRef.get(ModelRegistryService);
    cloudFallback = moduleRef.get(CloudFallbackService);
  });

  it('returns nulls when global preferences are unset', async () => {
    configService.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });

    const result = await controller.getPreferences();

    expect(result).toEqual({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
  });

  it('returns global preferred backend and model when persisted', async () => {
    configService.getInferencePreferences.mockReturnValue({
      preferredBackend: 'vllm',
      preferredModel: 'hermes4-70b',
      preferredEmbeddingModel: 'nomic-embed-text',
      preferredVisionModel: 'gemma4-27b',
    });

    const result = await controller.getPreferences();

    expect(result).toEqual({
      preferredBackend: 'vllm',
      preferredModel: 'hermes4-70b',
      preferredEmbeddingModel: 'nomic-embed-text',
      preferredVisionModel: 'gemma4-27b',
    });
  });

  it('updates the preferred backend and leaves the model unchanged when omitted', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'lemonade',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });

    const result = await controller.updatePreferences({ backend: 'lemonade' });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(expect.objectContaining({ backend: 'lemonade' }));
    expect(result).toEqual({
      preferredBackend: 'lemonade',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
  }, 30_000);

  it('hands a preference change to the same refresh PATCH /api/user-settings uses, instead of restarting every AI app itself', async () => {
    // This route restarted every AI app, Companion Memory included, while the user-settings route
    // restarted none. Both now land in AiAppInferenceRefreshService, which restarts only stale apps.
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'ollama',
      preferredModel: 'qwen3-coder-30b',
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });

    await controller.updatePreferences({ backend: 'ollama', model: 'qwen3-coder-30b' });
    await vi.waitFor(() => expect(inferenceRefresh.requestRefresh).toHaveBeenCalledWith('inference preferences changed'));

    expect(appCredentials.invalidateCache).toHaveBeenCalled();
  }, 30_000);

  it('passes the preferred chat, embedding, and vision models through when provided', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'ollama',
      preferredModel: 'hermes4-8b',
      preferredEmbeddingModel: 'nomic-embed-text',
      preferredVisionModel: 'gemma4-27b',
    });

    const result = await controller.updatePreferences({
      backend: 'ollama',
      model: 'hermes4-8b',
      embeddingModel: 'nomic-embed-text',
      visionModel: 'gemma4-27b',
    });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'ollama',
        model: 'hermes4-8b',
        embeddingModel: 'nomic-embed-text',
        visionModel: 'gemma4-27b',
      }),
    );
    expect(result).toEqual({
      preferredBackend: 'ollama',
      preferredModel: 'hermes4-8b',
      preferredEmbeddingModel: 'nomic-embed-text',
      preferredVisionModel: 'gemma4-27b',
    });
  }, 30_000);

  it('passes the vLLM endpoint URL and API key through when provided', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'vllm',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: 'vllm-local',
      preferredVllmUrl: 'http://192.168.1.50:8000',
    } as never);

    await controller.updatePreferences({
      backend: 'vllm',
      vllmApiKey: 'vllm-local',
      vllmUrl: 'http://192.168.1.50:8000',
    });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'vllm',
        vllmApiKey: 'vllm-local',
        vllmUrl: 'http://192.168.1.50:8000',
      }),
    );
  }, 30_000);

  it('reports a stored vLLM key masked, the way cloud provider keys are reported', async () => {
    configService.getInferencePreferences.mockReturnValue({
      preferredBackend: 'vllm',
      preferredVllmApiKey: 'vllm-secret',
      preferredVllmUrl: 'http://192.168.1.50:8000',
    } as never);

    const result = await controller.getPreferences();

    expect(result).toMatchObject({ preferredVllmApiKey: MASKED_API_KEY, preferredVllmUrl: 'http://192.168.1.50:8000' });
    expect(JSON.stringify(result)).not.toContain('vllm-secret');
  });

  it('keeps the stored vLLM key when a save sends the mask back, and answers masked', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm', preferredVllmApiKey: 'vllm-secret' } as never);

    const result = await controller.updatePreferences({ backend: 'vllm', vllmApiKey: MASKED_API_KEY });

    // `undefined` is "leave it as stored"; `null` or an empty key still clears it.
    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'vllm',
        vllmApiKey: undefined,
      }),
    );
    expect(result).toMatchObject({ preferredVllmApiKey: MASKED_API_KEY });
  }, 30_000);

  it('still clears the vLLM key on a null', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', preferredVllmApiKey: null } as never);

    await controller.updatePreferences({ backend: 'ollama', vllmApiKey: null });

    expect((configService.setInferencePreferences.mock.calls[0]?.[0] as SetInferencePreferencesOptions)?.vllmApiKey).toBeNull();
  }, 30_000);

  // The stored key belongs to the server it was saved for. Re-check never sends it to another one,
  // and a save that moves vLLM elsewhere must not either.
  describe('a save that changes the vLLM URL', () => {
    const savedVllmUrl = 'http://192.168.1.50:8000';
    const savedVllmEnv = process.env.VLLM_URL;

    beforeEach(() => {
      delete process.env.VLLM_URL;
      configService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredVllmApiKey: 'vllm-secret',
        preferredVllmUrl: savedVllmUrl,
      } as never);
      configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'vllm', preferredVllmApiKey: null } as never);
    });

    afterEach(() => {
      if (savedVllmEnv === undefined) delete process.env.VLLM_URL;
      else process.env.VLLM_URL = savedVllmEnv;
    });

    const storedKeyArg = () => (configService.setInferencePreferences.mock.calls[0]?.[0] as SetInferencePreferencesOptions)?.vllmApiKey;

    it('drops the stored key when the key comes back as the mask', async () => {
      await controller.updatePreferences({ backend: 'vllm', vllmApiKey: MASKED_API_KEY, vllmUrl: 'http://192.168.1.99:8000' });

      expect(storedKeyArg()).toBeNull();
    });

    it('drops the stored key when the key is left out', async () => {
      await controller.updatePreferences({ backend: 'vllm', vllmUrl: 'http://192.168.1.99:8000' });

      expect(storedKeyArg()).toBeNull();
    });

    it('drops the stored key when the URL is cleared and vLLM falls back to the default server', async () => {
      await controller.updatePreferences({ backend: 'vllm', vllmApiKey: MASKED_API_KEY, vllmUrl: null });

      expect(storedKeyArg()).toBeNull();
    });

    it('keeps the stored key for another spelling of the same server', async () => {
      await controller.updatePreferences({ backend: 'vllm', vllmApiKey: MASKED_API_KEY, vllmUrl: 'http://192.168.1.50:8000/v1/' });

      expect(storedKeyArg()).toBeUndefined();
    });

    it('stores a key typed for the new server', async () => {
      await controller.updatePreferences({ backend: 'vllm', vllmApiKey: 'new-server-key', vllmUrl: 'http://192.168.1.99:8000' });

      expect(storedKeyArg()).toBe('new-server-key');
    });
  });

  it('passes the oMLX endpoint URL through when provided', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'omlx',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredOmlxUrl: 'http://192.168.1.50:8000',
    } as never);

    await controller.updatePreferences({
      backend: 'omlx',
      omlxUrl: 'http://192.168.1.50:8000',
    });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'omlx',
        omlxUrl: 'http://192.168.1.50:8000',
      }),
    );
  }, 30_000);

  it('returns runtime models for a healthy selected backend', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['mistral:latest'] } as any);
    ollamaBackend.listModels.mockResolvedValue([{ id: 'mistral:latest', name: 'mistral:latest', size: 0, loaded: true }]);

    const result = await controller.getRuntimeModels({ backend: 'ollama' });

    expect(result).toEqual({
      backend: 'ollama',
      discoveryUnavailable: false,
      models: [{ id: 'mistral:latest', name: 'mistral:latest', state: 'available', resident: false }],
    });
  });

  it('marks a runtime model resident only when the engine says it is loaded', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['mistral:latest'] } as any);
    ollamaBackend.listModels.mockResolvedValue([
      { id: 'mistral:latest', name: 'mistral:latest', size: 0, loaded: true },
      { id: 'other:latest', name: 'other:latest', size: 0, loaded: true },
    ]);
    ollamaBackend.listResident.mockResolvedValue({
      backend: 'ollama',
      source: 'measured',
      models: [{ id: 'mistral:latest', engineGpuBytes: null, totalBytes: null, expiresAt: null, contextLength: null, quantization: null }],
    });

    const result = await controller.getRuntimeModels({ backend: 'ollama' });

    expect(result.models).toEqual([
      { id: 'mistral:latest', name: 'mistral:latest', state: 'available', resident: true },
      { id: 'other:latest', name: 'other:latest', state: 'available', resident: false },
    ]);
  });

  it('loads a downloaded model the catalog does not know by its engine id', async () => {
    modelRegistry.getCuratedModel.mockReturnValue(undefined);
    modelRegistry.getCatalog.mockReturnValue([]);
    lemonadeBackend.listModels.mockResolvedValue([{ id: 'Qwen3-Coder-30B', name: 'Qwen3-Coder-30B', size: 0, loaded: true }]);

    const result = await controller.loadModel({ modelId: 'Qwen3-Coder-30B', backend: 'lemonade' });

    expect(result).toEqual({ success: true, message: 'Model Qwen3-Coder-30B loaded' });
    expect(lemonadeBackend.loadModel).toHaveBeenCalledWith('Qwen3-Coder-30B');
  });

  it('refuses to load an engine id that is not downloaded', async () => {
    modelRegistry.getCuratedModel.mockReturnValue(undefined);
    modelRegistry.getCatalog.mockReturnValue([]);
    lemonadeBackend.listModels.mockResolvedValue([]);

    const result = await controller.loadModel({ modelId: 'Qwen3-Coder-30B', backend: 'lemonade' });

    expect(result.success).toBe(false);
    expect(lemonadeBackend.loadModel).not.toHaveBeenCalled();
  });

  it('returns empty model list when selected backend is unavailable', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] } as any);

    const result = await controller.getRuntimeModels({ backend: 'ollama' });

    expect(result).toEqual({
      backend: 'ollama',
      discoveryUnavailable: true,
      models: [],
    });
  });

  it('rejects invalid backend values in preferences schema', () => {
    const parsed = inferencePreferencesSchema.safeParse({ backend: 'invalid-backend' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an optional preferred model in the preferences schema', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', model: 'hermes4-70b' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', model: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', model: '' }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', embeddingModel: 'nomic-embed-text', visionModel: 'gemma4-27b' }).success).toBe(
      true,
    );
  });

  it('accepts the omlx backend and a valid omlxUrl in the preferences schema', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'omlx' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'omlx', omlxUrl: 'http://host.docker.internal:8000' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'omlx', omlxUrl: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'omlx', omlxUrl: 'not-a-url' }).success).toBe(false);
  });

  it('passes the context cap through, and a null to clear it', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', maxNumCtx: 16_384 } as never);

    await controller.updatePreferences({ backend: 'ollama', maxNumCtx: 16_384 });
    await controller.updatePreferences({ backend: 'ollama', maxNumCtx: null });

    expect(configService.setInferencePreferences).toHaveBeenNthCalledWith(1, expect.objectContaining({ backend: 'ollama', maxNumCtx: 16_384 }));
    expect(configService.setInferencePreferences).toHaveBeenNthCalledWith(2, expect.objectContaining({ backend: 'ollama', maxNumCtx: null }));
  }, 30_000);

  it('bounds the context cap in the preferences schema: an integer from 2048 to 2^20, or null', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', maxNumCtx: 16_384 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', maxNumCtx: null }).success).toBe(true);
    // A dropped digit, a fraction, and past the longest window on the fleet.
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', maxNumCtx: 1638 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', maxNumCtx: 16_384.5 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', maxNumCtx: 2 ** 21 }).success).toBe(false);
  });

  it('passes the Ollama slot count through, and a null to clear it', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', ollamaSlots: 4 } as never);

    await controller.updatePreferences({ backend: 'ollama', ollamaSlots: 4 });
    await controller.updatePreferences({ backend: 'ollama', ollamaSlots: null });
    // Both in one body: the cap and the slots land in their own positions, neither moves the other.
    await controller.updatePreferences({ backend: 'ollama', maxNumCtx: 32_768, ollamaSlots: 2 });

    expect(configService.setInferencePreferences).toHaveBeenNthCalledWith(1, expect.objectContaining({ backend: 'ollama', ollamaSlots: 4 }));
    expect(configService.setInferencePreferences).toHaveBeenNthCalledWith(2, expect.objectContaining({ backend: 'ollama', ollamaSlots: null }));
    expect(configService.setInferencePreferences).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ backend: 'ollama', maxNumCtx: 32_768, ollamaSlots: 2 }),
    );
  }, 30_000);

  it('bounds the Ollama slot count in the preferences schema: an integer from 1 to 64, or null', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 4 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 1 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 64 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama' }).success).toBe(true);
    // Zero slots is not a daemon, a fraction is not a slot, and past the bound `--ollama-parallel` accepts.
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 0 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: -1 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 2.5 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: 65 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaSlots: '4' }).success).toBe(false);
  });

  it('passes the Ollama keep-alive through in its own position, a null clearing it', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'ollama', ollamaKeepAlive: 86_400 } as never);

    await controller.updatePreferences({ backend: 'ollama', ollamaKeepAlive: 86_400 });
    await controller.updatePreferences({ backend: 'ollama', ollamaKeepAlive: null });

    const keepAliveArg = (call: unknown[]) => (call[0] as SetInferencePreferencesOptions)?.ollamaKeepAlive;
    expect(keepAliveArg(configService.setInferencePreferences.mock.calls[0] ?? [])).toBe(86_400);
    expect(keepAliveArg(configService.setInferencePreferences.mock.calls[1] ?? [])).toBeNull();
  }, 30_000);

  it('bounds the Ollama keep-alive in the preferences schema: whole seconds from -1 (forever) to a year, or null', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: 86_400 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: -1 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: 0 }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: -2 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: 1.5 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: 366 * 86_400 }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'ollama', ollamaKeepAlive: '24h' }).success).toBe(false);
  });

  it('rejects a retired backend name', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'dspark' }).success).toBe(false);
    expect(inferencePreferencesSchema.safeParse({ backend: 'mtplx' }).success).toBe(false);
  });

  // Settings > AI deletes a cleared cloud key through this route. Running AI apps hold the key in
  // their env, so they are refreshed the way a save refreshes them, or they would keep using it.
  it('removes a stored cloud key and asks for the same AI app refresh a save does', async () => {
    cloudFallback.removeProvider.mockResolvedValue(true);

    await expect(controller.removeCloudProvider('openai')).resolves.toEqual({ success: true, removed: true });

    expect(cloudFallback.removeProvider).toHaveBeenCalledWith('openai');
    expect(appCredentials.invalidateCache).toHaveBeenCalled();
    await vi.waitFor(() => expect(inferenceRefresh.requestRefresh).toHaveBeenCalledWith('cloud provider openai removed'));
  });

  it('refreshes nothing when the provider had nothing stored', async () => {
    cloudFallback.removeProvider.mockResolvedValue(false);

    await expect(controller.removeCloudProvider('google')).resolves.toEqual({ success: true, removed: false });

    expect(appCredentials.invalidateCache).not.toHaveBeenCalled();
  });

  // A base URL changed through the API or MCP never showed in Settings > AI. A key entered there
  // went to that URL.
  describe('GET cloud-providers', () => {
    beforeEach(() => {
      const real = new CloudFallbackService(mock<LoggerService>(), mock<ConfigurationService>());
      cloudFallback.getDefaultBaseUrl.mockImplementation((provider) => real.getDefaultBaseUrl(provider));
    });

    it('reports a base URL on another server, with or without a key', async () => {
      cloudFallback.listProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-stored', enabled: true, defaultModel: 'gpt-4o', baseUrl: 'https://llm-proxy.example.test/v1' },
        { provider: 'anthropic', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://llm-proxy.example.test/anthropic' },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers).toEqual([
        { provider: 'openai', enabled: true, configured: true, defaultModel: 'gpt-4o', baseUrl: 'https://llm-proxy.example.test/v1' },
        {
          provider: 'anthropic',
          enabled: true,
          configured: false,
          defaultModel: 'claude-opus-4',
          baseUrl: 'https://llm-proxy.example.test/anthropic',
        },
      ]);
      expect(JSON.stringify(providers)).not.toContain('sk-stored');
    });

    // Any signed-in member reads this route, so a password written into the URL stays on the Hub.
    it('leaves out a user name and password written into the base URL', async () => {
      cloudFallback.listProviders.mockReturnValue([
        {
          provider: 'openai',
          apiKey: 'sk-stored',
          enabled: true,
          defaultModel: 'gpt-4o',
          baseUrl: 'https://proxy-user:proxy-secret@llm-proxy.example.test/v1',
        },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers[0]?.baseUrl).toBe('https://llm-proxy.example.test/v1');
      expect(JSON.stringify(providers)).not.toContain('proxy-secret');
    });

    it('leaves out a query string and fragment written into the base URL', async () => {
      cloudFallback.listProviders.mockReturnValue([
        {
          provider: 'openai',
          apiKey: 'sk-stored',
          enabled: true,
          defaultModel: 'gpt-4o',
          baseUrl: 'https://llm-proxy.example.test/v1?api-key=query-secret#hash-secret',
        },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers[0]?.baseUrl).toBe('https://llm-proxy.example.test/v1');
      expect(JSON.stringify(providers)).not.toMatch(/query-secret|hash-secret/);
    });

    // `proxy-user:proxy-secret@...` parses as a URL with the scheme `proxy-user:`; the second doesn't parse.
    it('leaves the secret parts out of a base URL that is not http or https', async () => {
      cloudFallback.listProviders.mockReturnValue([
        {
          provider: 'openai',
          apiKey: 'sk-stored',
          enabled: true,
          defaultModel: 'gpt-4o',
          baseUrl: 'proxy-user:proxy-secret@llm-proxy/v1?key=query-secret',
        },
        {
          provider: 'anthropic',
          apiKey: 'sk-ant',
          enabled: true,
          defaultModel: 'claude-opus-4',
          baseUrl: 'https://proxy-user:proxy-secret@llm proxy/v1',
        },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers.map((p) => p.baseUrl)).toEqual(['llm-proxy/v1', 'https://llm proxy/v1']);
      expect(JSON.stringify(providers)).not.toMatch(/proxy-secret|query-secret/);
    });

    // A `/` or `?` in the password ends the host early. Neither URL parses, so the fallback has to
    // find the last `@`.
    it('leaves out a password with a slash or a question mark in it', async () => {
      cloudFallback.listProviders.mockReturnValue([
        {
          provider: 'openai',
          apiKey: 'sk-stored',
          enabled: true,
          defaultModel: 'gpt-4o',
          baseUrl: ' https://proxy-user:pass/word@llm-proxy.example.test/v1 ',
        },
        {
          provider: 'anthropic',
          apiKey: 'sk-ant',
          enabled: true,
          defaultModel: 'claude-opus-4',
          baseUrl: 'https://proxy-user:pass?word@llm-proxy.example.test/v1',
        },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers.map((p) => p.baseUrl)).toEqual(['https://llm-proxy.example.test/v1', 'https://llm-proxy.example.test/v1']);
      expect(JSON.stringify(providers)).not.toMatch(/pass|word/);
    });

    // Reading the URL made this route fail outright when one was stored as something other than text.
    it('still lists the providers when a base URL is not text', async () => {
      cloudFallback.listProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-stored', enabled: true, defaultModel: 'gpt-4o', baseUrl: 42 as unknown as string },
      ]);

      await expect(controller.getCloudProviders()).resolves.toEqual([
        { provider: 'openai', enabled: true, configured: true, defaultModel: 'gpt-4o' },
      ]);
    });

    it("leaves the base URL out when it is the provider's own server, however it is spelled", async () => {
      cloudFallback.listProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-stored', enabled: true, defaultModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        {
          provider: 'anthropic',
          apiKey: 'sk-ant-stored',
          enabled: true,
          defaultModel: 'claude-opus-4',
          baseUrl: 'https://API.anthropic.com:443/v1/',
        },
        {
          provider: 'google',
          apiKey: 'AIza-stored',
          enabled: false,
          defaultModel: 'gemini-2.5-pro',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        },
        { provider: 'github-copilot', apiKey: 'ghu-stored', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://api.githubcopilot.com/' },
      ]);

      const providers = await controller.getCloudProviders();

      expect(providers).toHaveLength(4);
      for (const provider of providers) {
        expect(provider).not.toHaveProperty('baseUrl');
      }
    });
  });
});
