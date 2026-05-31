import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppCredentialsService } from '../app-credentials.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CloudProviderConfig, CuratedModel, HardwareProfile } from '@ci-hub/common/types';

const OLLAMA_BASE_URL = 'http://ci-hub-ollama:11434';
const OLLAMA_OPENAI_URL = `${OLLAMA_BASE_URL}/v1`;

const makeLlm = (id: string, backendModelId: string, minVramMb = 0, minRamMb = 0): CuratedModel =>
  ({
    id,
    backend: 'ollama',
    backendModelId,
    modality: 'llm',
    purpose: 'general',
    displayName: id,
    description: '',
    requirements: {
      minVramMb,
      recommendedVramMb: minVramMb,
      minRamMb,
      diskMb: 0,
      gpuVendors: ['nvidia', 'cpu'],
      npuRequired: false,
      minTier: 'high',
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
      minRamMb: 2048,
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
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as unknown as CuratedModel;

const baseProfile: HardwareProfile = {
  gpu: { available: true, vendor: 'nvidia', model: 'RTX 4090', vramMb: 24576, unifiedMemory: false, driverVersion: '550.0', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 65536, availableMb: 60000 },
  cpu: { arch: 'x86_64', cores: 16, model: 'Test CPU' },
  effectiveInferenceMemoryMb: 24576,
  tier: 'high',
};

describe('AppCredentialsService', () => {
  let service: AppCredentialsService;
  let logger: MockProxy<LoggerService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let modelPuller: MockProxy<ModelPullerService>;
  let cloudFallback: MockProxy<CloudFallbackService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let configurationService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    hardwareInspector = mock<HardwareInspectorService>();
    modelRegistry = mock<ModelRegistryService>();
    modelPuller = mock<ModelPullerService>();
    cloudFallback = mock<CloudFallbackService>();
    ollamaBackend = mock<OllamaBackend>();
    configurationService = mock<ConfigurationService>();

    configurationService.getInferencePreferences.mockReturnValue({ preferredBackend: null, preferredModel: null });
    ollamaBackend.getBaseUrl.mockReturnValue(OLLAMA_BASE_URL);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    hardwareInspector.getProfile.mockResolvedValue(baseProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([
      makeLlm('hermes4-70b', 'hermes4:70b', 42000, 126000),
      makeLlm('hermes4-8b', 'hermes4:8b', 4800, 14400),
    ]);
    modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(null);
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    modelRegistry.getCuratedModel.mockImplementation((id) => {
      if (id === 'hermes4-70b') return makeLlm('hermes4-70b', 'hermes4:70b');
      if (id === 'nomic-embed-text') return makeEmbedding('nomic-embed-text', 'nomic-embed-text');
      return undefined;
    });
    modelPuller.pullModel.mockResolvedValue(undefined);
    cloudFallback.getEnabledProviders.mockReturnValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppCredentialsService,
        { provide: LoggerService, useValue: logger },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelPullerService, useValue: modelPuller },
        { provide: CloudFallbackService, useValue: cloudFallback },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: ConfigurationService, useValue: configurationService },
      ],
    }).compile();

    service = module.get<AppCredentialsService>(AppCredentialsService);
  });

  describe('getCredentials — local (direct Ollama) path', () => {
    it('throws NotFoundException for unknown slugs', async () => {
      await expect(service.getCredentials('unknown-app')).rejects.toThrow(NotFoundException);
    });

    it('points hermes-agent at the DIRECT Ollama /v1 with the NATIVE chat model id', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getCredentials('hermes-agent');

      expect(config.app).toBe('hermes-agent');
      expect(config.provider).toBe('ollama');
      // DIRECT ollama endpoint, NOT /api/inference
      expect(config.endpointUrl).toBe(OLLAMA_OPENAI_URL);
      // chat model is the NATIVE backend id, not the catalog id
      expect(config.chatModelId).toBe('hermes4:70b');
      expect(config.env).toEqual({
        HERMES_OPENAI_BASE_URL: OLLAMA_OPENAI_URL,
        HERMES_OPENAI_API_KEY: 'ollama',
        HERMES_DEFAULT_MODEL: 'hermes4:70b',
        OLLAMA_HOST: OLLAMA_BASE_URL,
      });
    });

    it('points openclaw at the DIRECT Ollama /v1 keyed with OPENAI_API_* and native DEFAULT_MODEL', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');

      expect(config.app).toBe('openclaw');
      expect(config.env).toEqual({
        OPENAI_API_BASE: OLLAMA_OPENAI_URL,
        OPENAI_API_KEY: 'ollama',
        DEFAULT_MODEL: 'hermes4:70b',
        OLLAMA_HOST: OLLAMA_BASE_URL,
      });
    });

    it('always includes OLLAMA_HOST (direct native ollama url) even when no model is runnable', async () => {
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
      modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(null);

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBeNull();
      expect(config.embeddingsModelId).toBeNull();
      expect(config.env).toEqual({
        OPENAI_API_BASE: OLLAMA_OPENAI_URL,
        OPENAI_API_KEY: 'ollama',
        OLLAMA_HOST: OLLAMA_BASE_URL,
      });
    });

    it('does not emit an embeddings key when no embedding model is recommended', async () => {
      modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(null);

      const config = await service.getCredentials('openclaw');

      expect(config.embeddingsModelId).toBeNull();
      expect(config.env.EMBEDDINGS_MODEL).toBeUndefined();
    });

    it('emits the native embeddings model id and pre-pulls it when one is recommended', async () => {
      modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(makeEmbedding('nomic-embed-text', 'nomic-embed-text'));

      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));

      expect(config.embeddingsModelId).toBe('nomic-embed-text');
      expect(config.env.EMBEDDINGS_MODEL).toBe('nomic-embed-text');
      expect(modelPuller.pullModel).toHaveBeenCalledWith('nomic-embed-text');
    });

    it('returns companion-memory env keyed with LLM_* (direct Ollama + native ids) including embeddings', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b', 'nomic-embed-text'] });
      modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(makeEmbedding('nomic-embed-text', 'nomic-embed-text'));
      service.invalidateCache();

      const config = await service.getCredentials('companion-memory');

      expect(config.app).toBe('companion-memory');
      expect(config.env).toEqual({
        LLM_API_BASE: OLLAMA_OPENAI_URL,
        LLM_API_KEY: 'ollama',
        LLM_DEFAULT_CHAT_MODEL: 'hermes4:70b',
        LLM_DEFAULT_EMBEDDING_MODEL: 'nomic-embed-text',
        OLLAMA_HOST: OLLAMA_BASE_URL,
      });
    });

    it('picks the first (biggest) recommended model and uses its native id', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['family:700b', 'family:70b', 'family:8b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([
        makeLlm('biggest-700b', 'family:700b'),
        makeLlm('mid-70b', 'family:70b'),
        makeLlm('small-8b', 'family:8b'),
      ]);

      const config = await service.getCredentials('hermes-agent');

      expect(config.chatModelId).toBe('family:700b');
    });

    it('does not emit DEFAULT_MODEL when the recommended model is not present in Ollama', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBeNull();
      expect(config.env.DEFAULT_MODEL).toBeUndefined();
    });
  });

  describe('getCredentials — cloud override', () => {
    const cloudProvider: CloudProviderConfig = {
      provider: 'openai',
      apiKey: 'sk-operator-key',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    };

    it('OVERRIDES base/key/model with the first enabled cloud provider', async () => {
      cloudFallback.getEnabledProviders.mockReturnValue([cloudProvider]);

      const config = await service.getCredentials('hermes-agent');

      expect(config.provider).toBe('cloud');
      expect(config.endpointUrl).toBe('https://api.openai.com/v1');
      expect(config.chatModelId).toBe('gpt-4o');
      expect(config.env).toEqual({
        HERMES_OPENAI_BASE_URL: 'https://api.openai.com/v1',
        HERMES_OPENAI_API_KEY: 'sk-operator-key',
        HERMES_DEFAULT_MODEL: 'gpt-4o',
        // OLLAMA_HOST is still exposed so the app can reach Ollama natively too
        OLLAMA_HOST: OLLAMA_BASE_URL,
      });
    });

    it('still exposes OLLAMA_HOST as the direct native ollama url under a cloud override', async () => {
      cloudFallback.getEnabledProviders.mockReturnValue([cloudProvider]);

      const config = await service.getCredentials('openclaw');

      expect(config.env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
      expect(config.env.OPENAI_API_BASE).toBe('https://api.openai.com/v1');
      expect(config.env.OPENAI_API_KEY).toBe('sk-operator-key');
    });
  });

  describe('serializeAsDotenv', () => {
    it('emits KEY=VALUE lines with no quoting for simple values', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      const dotenv = service.serializeAsDotenv(config);

      expect(dotenv).toContain(`OPENAI_API_BASE=${OLLAMA_OPENAI_URL}`);
      expect(dotenv).toContain('OPENAI_API_KEY=ollama');
      expect(dotenv).toContain('DEFAULT_MODEL=hermes4:70b');
      expect(dotenv).toContain(`OLLAMA_HOST=${OLLAMA_BASE_URL}`);
      expect(dotenv.endsWith('\n')).toBe(true);
    });

    it('quotes values containing whitespace, quotes, or = signs', () => {
      const config = {
        app: 'openclaw' as const,
        apiVersion: 1 as const,
        endpointUrl: '',
        endpointReady: false,
        chatModelId: null,
        embeddingsModelId: null,
        chatModelReady: false,
        provider: 'ollama' as const,
        env: {
          SIMPLE: 'plain',
          WITH_SPACES: 'foo bar',
          WITH_QUOTE: 'has"quote',
          WITH_EQ: 'a=b',
        },
        managedKeys: ['SIMPLE', 'WITH_SPACES', 'WITH_QUOTE', 'WITH_EQ'],
      };
      const dotenv = service.serializeAsDotenv(config);

      expect(dotenv).toContain('SIMPLE=plain');
      expect(dotenv).toContain('WITH_SPACES="foo bar"');
      expect(dotenv).toContain('WITH_QUOTE="has\\"quote"');
      expect(dotenv).toContain('WITH_EQ="a=b"');
    });
  });

  describe('isSupported', () => {
    it('recognizes supported slugs', () => {
      expect(service.isSupported('hermes-agent')).toBe(true);
      expect(service.isSupported('openclaw')).toBe(true);
      expect(service.isSupported('companion-memory')).toBe(true);
    });

    it('rejects unknown slugs', () => {
      expect(service.isSupported('something-else')).toBe(false);
    });

    it('reports endpointReady from ollamaBackend.healthCheck', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      expect(config.endpointReady).toBe(false);
    });

    it('exposes managedKeys matching env keys for header consumers', async () => {
      const config = await service.getCredentials('hermes-agent');
      expect(config.managedKeys.sort()).toEqual(Object.keys(config.env).sort());
    });

    it('always defaults apiVersion to 1', async () => {
      const config = await service.getCredentials('openclaw');
      expect(config.apiVersion).toBe(1);
    });
  });

  describe('parseApiVersion', () => {
    it('defaults to 1 when undefined', () => {
      expect(service.parseApiVersion(undefined)).toBe(1);
    });
    it('defaults to 1 when empty string', () => {
      expect(service.parseApiVersion('')).toBe(1);
    });
    it('accepts the version 1 literal', () => {
      expect(service.parseApiVersion('1')).toBe(1);
    });
    it('takes the first value of an array (query string repeats)', () => {
      expect(service.parseApiVersion(['1', '99'])).toBe(1);
    });
    it('rejects unknown versions with BadRequestException', () => {
      expect(() => service.parseApiVersion('99')).toThrow(BadRequestException);
    });
    it('rejects non-numeric values', () => {
      expect(() => service.parseApiVersion('latest')).toThrow(BadRequestException);
    });
  });

  describe('caching', () => {
    it('returns the cached value on a second call within TTL without re-querying hardware', async () => {
      await service.getCredentials('openclaw');
      await service.getCredentials('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(1);
      expect(ollamaBackend.healthCheck).toHaveBeenCalledTimes(1);
    });

    it('keeps the cache separate per slug', async () => {
      await service.getCredentials('hermes-agent');
      await service.getCredentials('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache() forces a fresh resolve', async () => {
      await service.getCredentials('openclaw');
      service.invalidateCache();
      await service.getCredentials('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(2);
    });
  });

  describe('pre-pull', () => {
    it('fires an async pull for the recommended chat model when Ollama is reachable and not yet pulled', async () => {
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).toHaveBeenCalledWith('hermes4-70b');
    });

    it('does not pull when Ollama endpoint is unreachable', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('does not pull when the model is already loaded in Ollama (modelsLoaded includes backendModelId)', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.chatModelReady).toBe(true);
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('does not pull when registry reports state=pulled for the catalog id', async () => {
      modelRegistry.getTrackedModel.mockReturnValue({ catalogId: 'hermes4-70b', state: 'pulled' } as any);
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.chatModelReady).toBe(true);
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('de-dupes concurrent pre-pull requests for the same model', async () => {
      let resolvePull: () => void = () => {};
      modelPuller.pullModel.mockReturnValueOnce(
        new Promise<void>((r) => {
          resolvePull = r;
        }),
      );
      await service.getCredentials('openclaw');
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).toHaveBeenCalledTimes(1);
      resolvePull();
    });
  });
});
