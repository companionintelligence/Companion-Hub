import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceEnvResolver } from '../inference-env-resolver';
import { ModelRegistryService } from '../model-registry.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { CloudFallbackService } from '../cloud-fallback.service';
import type { CloudProviderConfig, CuratedModel, HardwareProfile } from '@ci-hub/common/types';

const OLLAMA_BASE_URL = 'http://host.docker.internal:11434';

const makeLlm = (id: string, backendModelId: string, vision = false): CuratedModel =>
  ({
    id,
    backend: 'ollama',
    backendModelId,
    modality: 'llm',
    purpose: 'general',
    displayName: id,
    description: '',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 0,
      minRamMb: 0,
      diskMb: 0,
      gpuVendors: ['nvidia', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 131072,
      maxTokens: 8192,
      reasoning: false,
      input: ['text'],
      quantization: 'q4_K_M',
      pinnedByDefault: false,
      memoryFootprintMb: 0,
    },
    metadata: {
      capabilities: {
        vision,
      },
    },
    tiers: { high: 'recommended', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as unknown as CuratedModel;

const makeEmbedding = (id: string, backendModelId: string): CuratedModel =>
  ({
    id,
    backend: 'ollama',
    backendModelId,
    modality: 'embedding',
    purpose: 'general',
    displayName: id,
    description: '',
    requirements: {
      minVramMb: 0,
      recommendedVramMb: 0,
      minRamMb: 0,
      diskMb: 0,
      gpuVendors: ['nvidia', 'cpu'],
      npuRequired: false,
      minTier: 'cpu-only',
    },
    runtime: {
      contextWindow: 8192,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      quantization: 'q4_K_M',
      pinnedByDefault: false,
      memoryFootprintMb: 0,
    },
    tiers: { high: 'recommended', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as unknown as CuratedModel;

const baseProfile: HardwareProfile = {
  gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '550.0', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 65536, availableMb: 60000 },
  cpu: { arch: 'x86_64', cores: 16, model: 'Test CPU' },
  effectiveInferenceMemoryMb: 24576,
  tier: 'high',
};

describe('InferenceEnvResolver', () => {
  let service: InferenceEnvResolver;
  let config: MockProxy<ConfigurationService>;
  let logger: MockProxy<LoggerService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let cloudFallback: MockProxy<CloudFallbackService>;

  beforeEach(async () => {
    config = mock<ConfigurationService>();
    logger = mock<LoggerService>();
    modelRegistry = mock<ModelRegistryService>();
    hardwareInspector = mock<HardwareInspectorService>();
    ollamaBackend = mock<OllamaBackend>();
    cloudFallback = mock<CloudFallbackService>();

    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    hardwareInspector.getProfile.mockResolvedValue(baseProfile);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    ollamaBackend.getBaseUrl.mockReturnValue(OLLAMA_BASE_URL);
    cloudFallback.getEnabledProviders.mockReturnValue([]);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b')]);
    modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(makeEmbedding('nomic-embed-text', 'nomic-embed-text'));
    modelRegistry.getRecommendedVisionModel.mockReturnValue(makeLlm('gemma4-27b', 'gemma4:27b', true));
    modelRegistry.getCuratedModel.mockImplementation((id) => {
      if (id === 'preferred-llm') return makeLlm('preferred-llm', 'preferred:latest');
      if (id === 'preferred-embed') return makeEmbedding('preferred-embed', 'preferred-embed:latest');
      if (id === 'vision-capable') return makeLlm('vision-capable', 'vision:latest', true);
      if (id === 'not-vision') return makeLlm('not-vision', 'text-only:latest');
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InferenceEnvResolver,
        { provide: LoggerService, useValue: logger },
        { provide: ConfigurationService, useValue: config },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: CloudFallbackService, useValue: cloudFallback },
      ],
    }).compile();

    service = module.get(InferenceEnvResolver);
  });

  it('returns local Ollama variables when Ollama is reachable', async () => {
    const env = await service.resolve();

    expect(env).toEqual({
      CI_LLM_BASE_URL: `${OLLAMA_BASE_URL}/v1`,
      CI_LLM_API_KEY: 'ollama',
      CI_CHAT_MODEL: 'hermes4:70b',
      CI_EMBEDDING_MODEL: 'nomic-embed-text',
      CI_VISION_MODEL: 'gemma4:27b',
      OLLAMA_HOST: OLLAMA_BASE_URL,
    });
  });

  it('omits all inference variables when Ollama is unavailable and no cloud provider is configured', async () => {
    ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });

    const env = await service.resolve();

    expect(env).toEqual({});
    expect(ollamaBackend.getBaseUrl).not.toHaveBeenCalled();
    expect(hardwareInspector.getProfile).not.toHaveBeenCalled();
    expect(modelRegistry.getRecommendedModelsForHardware).not.toHaveBeenCalled();
  });

  it('returns cloud connection variables even when Ollama is unavailable', async () => {
    const provider: CloudProviderConfig = {
      provider: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    };
    cloudFallback.getEnabledProviders.mockReturnValue([provider]);
    ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });

    const env = await service.resolve();

    expect(env).toMatchObject({
      CI_LLM_BASE_URL: 'https://api.openai.com/v1',
      CI_LLM_API_KEY: 'sk-test',
      CI_CHAT_MODEL: 'gpt-4o',
    });
    expect(env.CI_EMBEDDING_MODEL).toBeUndefined();
    expect(env.CI_VISION_MODEL).toBeUndefined();
    expect(env.OLLAMA_HOST).toBeUndefined();
  });

  it('omits Ollama-specific embedding and vision model IDs when a cloud provider overrides the base URL', async () => {
    const provider: CloudProviderConfig = {
      provider: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    };
    cloudFallback.getEnabledProviders.mockReturnValue([provider]);
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: 'preferred-llm',
      preferredEmbeddingModel: 'preferred-embed',
      preferredVisionModel: 'vision-capable',
    });

    const env = await service.resolve();

    expect(env).toEqual({
      CI_LLM_BASE_URL: 'https://api.openai.com/v1',
      CI_LLM_API_KEY: 'sk-test',
      CI_CHAT_MODEL: 'gpt-4o',
      OLLAMA_HOST: OLLAMA_BASE_URL,
    });
    expect(modelRegistry.getRecommendedEmbeddingModel).not.toHaveBeenCalled();
    expect(modelRegistry.getRecommendedVisionModel).not.toHaveBeenCalled();
  });

  it('honors preferred chat and embedding models and falls back for non-vision preferences', async () => {
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: 'preferred-llm',
      preferredEmbeddingModel: 'preferred-embed',
      preferredVisionModel: 'not-vision',
    });

    const env = await service.resolve();

    expect(env.CI_CHAT_MODEL).toBe('preferred:latest');
    expect(env.CI_EMBEDDING_MODEL).toBe('preferred-embed:latest');
    expect(env.CI_VISION_MODEL).toBe('gemma4:27b');
  });
});
