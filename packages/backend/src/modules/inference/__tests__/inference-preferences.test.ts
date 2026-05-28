import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Test } from '@nestjs/testing';
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
import { inferencePreferencesSchema } from '../inference.dto';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';

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
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: OllamaBackend, useValue: mock<OllamaBackend>() },
        { provide: VllmBackend, useValue: mock<VllmBackend>() },
        { provide: LemonadeBackend, useValue: mock<LemonadeBackend>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(InferenceController);
    configService = moduleRef.get(ConfigurationService);
    ollamaBackend = moduleRef.get(OllamaBackend);
  });

  it('returns null when global preferred backend is unset', async () => {
    configService.getInferencePreferences.mockReturnValue({ preferredBackend: null });

    const result = await controller.getPreferences();

    expect(result).toEqual({ preferredBackend: null });
  });

  it('returns global preferred backend when persisted', async () => {
    configService.getInferencePreferences.mockReturnValue({ preferredBackend: 'vllm' });

    const result = await controller.getPreferences();

    expect(result).toEqual({ preferredBackend: 'vllm' });
  });

  it('updates and returns global preferred backend', async () => {
    configService.setInferencePreferences.mockResolvedValue({ preferredBackend: 'lemonade' });

    const result = await controller.updatePreferences({ backend: 'lemonade' });

    expect(configService.setInferencePreferences).toHaveBeenCalledWith('lemonade');
    expect(result).toEqual({ preferredBackend: 'lemonade' });
  });

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
});
