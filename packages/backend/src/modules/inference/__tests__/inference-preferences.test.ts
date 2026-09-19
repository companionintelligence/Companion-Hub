import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { inferencePreferencesSchema } from '../inference.dto';
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

describe('InferenceController — preferences', () => {
  let controller: InferenceController;
  let configService: MockProxy<ConfigurationService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let inferenceRefresh: { requestRefresh: ReturnType<typeof vi.fn> };
  let appCredentials: MockProxy<AppCredentialsService>;

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
    configService = moduleRef.get(ConfigurationService);
    ollamaBackend = moduleRef.get(OllamaBackend);
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

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      'lemonade',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
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
      'ollama',
      'hermes4-8b',
      'nomic-embed-text',
      'gemma4-27b',
      undefined,
      undefined,
      undefined,
      undefined,
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
      'vllm',
      undefined,
      undefined,
      undefined,
      'vllm-local',
      'http://192.168.1.50:8000',
      undefined,
      undefined,
    );
  }, 30_000);

  it('passes the MTPLX endpoint URL through when provided', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'mtplx',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredMtplxUrl: 'http://192.168.1.50:8000',
    } as never);

    await controller.updatePreferences({
      backend: 'mtplx',
      mtplxUrl: 'http://192.168.1.50:8000',
    });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      'mtplx',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'http://192.168.1.50:8000',
      undefined,
    );
  }, 30_000);

  it('passes the mlx-dspark endpoint URL through when provided', async () => {
    configService.setInferencePreferences.mockResolvedValue({
      preferredBackend: 'dspark',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredDsparkUrl: 'http://192.168.1.50:8080',
    } as never);

    await controller.updatePreferences({
      backend: 'dspark',
      dsparkUrl: 'http://192.168.1.50:8080',
    });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith(
      'dspark',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'http://192.168.1.50:8080',
    );
  }, 30_000);

  it('returns runtime models for a healthy selected backend', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['mistral:latest'] } as any);
    ollamaBackend.listModels.mockResolvedValue([{ id: 'mistral:latest', name: 'mistral:latest', size: 0, loaded: true }]);

    const result = await controller.getRuntimeModels({ backend: 'ollama' });

    expect(result).toEqual({
      backend: 'ollama',
      discoveryUnavailable: false,
      models: [{ id: 'mistral:latest', name: 'mistral:latest', state: 'available' }],
    });
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

  it('accepts the mtplx backend and a valid mtplxUrl in the preferences schema', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'mtplx' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'mtplx', mtplxUrl: 'http://host.docker.internal:8000' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'mtplx', mtplxUrl: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'mtplx', mtplxUrl: 'not-a-url' }).success).toBe(false);
  });

  it('accepts the dspark backend and a valid dsparkUrl in the preferences schema', () => {
    expect(inferencePreferencesSchema.safeParse({ backend: 'dspark' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'dspark', dsparkUrl: 'http://host.docker.internal:8080' }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'dspark', dsparkUrl: null }).success).toBe(true);
    expect(inferencePreferencesSchema.safeParse({ backend: 'dspark', dsparkUrl: 'not-a-url' }).success).toBe(false);
  });
});
