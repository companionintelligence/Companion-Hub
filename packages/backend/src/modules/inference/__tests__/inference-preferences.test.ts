import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';

vi.mock('../../app-lifecycle/app-lifecycle.service', () => ({
  AppLifecycleService: class AppLifecycleService {},
}));

import { InferenceController } from '../inference.controller';
import { InferenceRouterService } from '../inference-router.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { MemoryManagerService } from '../memory-manager.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaInstallerService } from '../ollama-installer.service';
import { RocmInstallerService } from '../rocm-installer.service';
import { AppCredentialsService } from '../app-credentials.service';
import { inferencePreferencesSchema } from '../inference.dto';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { HostMetricsService } from '@/modules/system/host-metrics.service';

describe('InferenceController — preferences', () => {
  let controller: InferenceController;
  let configService: MockProxy<ConfigurationService>;
  let ollamaBackend: MockProxy<OllamaBackend>;

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
        { provide: LoggerService, useValue: mock<LoggerService>() },
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

    expect(configService.setInferencePreferences).toHaveBeenCalledWith('lemonade', undefined, undefined, undefined, undefined, undefined, undefined);
    expect(result).toEqual({
      preferredBackend: 'lemonade',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
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
    );
  }, 30_000);

  it('returns runtime models for a healthy selected backend', async () => {
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['mistral:latest'] } as any);
    ollamaBackend.listModels.mockResolvedValue([{ id: 'mistral:latest', name: 'mistral:latest', size: 0, loaded: true }]);

    const result = await controller.getRuntimeModels({ backend: 'ollama' });

    expect(result).toEqual({
      backend: 'ollama',
      discoveryUnavailable: false,
      models: [{ id: 'mistral:latest', name: 'mistral:latest', state: 'loaded' }],
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
});
