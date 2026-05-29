import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppBootstrapService } from '../app-bootstrap.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { InferenceRouterService } from '../inference-router.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';

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

describe('AppBootstrapService', () => {
  let service: AppBootstrapService;
  let logger: MockProxy<LoggerService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let inferenceRouter: MockProxy<InferenceRouterService>;
  let modelRegistry: MockProxy<ModelRegistryService>;
  let modelPuller: MockProxy<ModelPullerService>;
  let ollamaBackend: MockProxy<OllamaBackend>;
  let configurationService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    hardwareInspector = mock<HardwareInspectorService>();
    inferenceRouter = mock<InferenceRouterService>();
    modelRegistry = mock<ModelRegistryService>();
    modelPuller = mock<ModelPullerService>();
    ollamaBackend = mock<OllamaBackend>();
    configurationService = mock<ConfigurationService>();

    inferenceRouter.getInferenceEndpoint.mockReturnValue('http://ci-os-hub:3000/api/inference/v1');
    ollamaBackend.getBaseUrl.mockReturnValue('http://ci-hub-ollama:11434');
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
    hardwareInspector.getProfile.mockResolvedValue(baseProfile);
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([
      makeLlm('hermes4-70b', 'hermes4:70b', 42000, 126000),
      makeLlm('hermes4-8b', 'hermes4:8b', 4800, 14400),
    ]);
    modelRegistry.getModelsByModality.mockReturnValue([makeEmbedding('nomic-embed-text', 'nomic-embed-text')]);
    modelRegistry.getTrackedModel.mockReturnValue(undefined);
    modelRegistry.getCuratedModel.mockImplementation((id) => {
      if (id === 'hermes4-70b') return makeLlm('hermes4-70b', 'hermes4:70b');
      if (id === 'nomic-embed-text') return makeEmbedding('nomic-embed-text', 'nomic-embed-text');
      return undefined;
    });
    modelPuller.pullModel.mockResolvedValue(undefined);
    configurationService.getInferencePreferences.mockReturnValue({ preferredBackend: null, preferredModel: null });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppBootstrapService,
        { provide: LoggerService, useValue: logger },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: InferenceRouterService, useValue: inferenceRouter },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelPullerService, useValue: modelPuller },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: ConfigurationService, useValue: configurationService },
      ],
    }).compile();

    service = module.get<AppBootstrapService>(AppBootstrapService);
  });

  describe('getBootstrap', () => {
    it('throws NotFoundException for unknown slugs', async () => {
      await expect(service.getBootstrap('unknown-app')).rejects.toThrow(NotFoundException);
    });

    it('returns hermes-agent env keyed with HERMES_* and biggest runnable LLM', async () => {
      const config = await service.getBootstrap('hermes-agent');

      expect(config.app).toBe('hermes-agent');
      expect(config.endpointUrl).toBe('http://ci-os-hub:3000/api/inference/v1');
      expect(config.llmModelId).toBe('hermes4-70b');
      expect(config.llmBackendModelId).toBe('hermes4:70b');
      expect(config.embeddingsModelId).toBeNull();
      expect(config.env).toEqual({
        HERMES_OPENAI_BASE_URL: 'http://ci-os-hub:3000/api/inference/v1',
        HERMES_OPENAI_API_KEY: 'ollama',
        HERMES_DEFAULT_MODEL: 'hermes4-70b',
        HERMES_DEFAULT_MODEL_BACKEND_ID: 'hermes4:70b',
      });
    });

    it('returns openclaw env keyed with OPENAI_API_* and DEFAULT_MODEL', async () => {
      const config = await service.getBootstrap('openclaw');

      expect(config.app).toBe('openclaw');
      expect(config.env).toEqual({
        OPENAI_API_BASE: 'http://ci-os-hub:3000/api/inference/v1',
        OPENAI_API_KEY: 'ollama',
        DEFAULT_MODEL: 'hermes4-70b',
        DEFAULT_MODEL_BACKEND_ID: 'hermes4:70b',
      });
    });

    it('returns null model ids when no LLM is runnable on the hardware', async () => {
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
      modelRegistry.getModelsByModality.mockReturnValue([]);

      const config = await service.getBootstrap('openclaw');

      expect(config.llmModelId).toBeNull();
      expect(config.embeddingsModelId).toBeNull();
      expect(config.env).toEqual({
        OPENAI_API_BASE: 'http://ci-os-hub:3000/api/inference/v1',
        OPENAI_API_KEY: 'ollama',
      });
    });

    it('does not emit embeddings model fields when embeddings are not bootstrapped', async () => {
      modelRegistry.getModelsByModality.mockReturnValue([
        {
          ...makeEmbedding('huge-emb', 'huge-emb'),
          requirements: { ...makeEmbedding('huge-emb', 'huge-emb').requirements, minRamMb: 1_000_000 },
        } as CuratedModel,
        makeEmbedding('small-emb', 'small-emb'),
      ]);

      const config = await service.getBootstrap('openclaw');

      expect(config.embeddingsModelId).toBeNull();
      expect(config.env.EMBEDDINGS_MODEL).toBeUndefined();
      expect(config.env.EMBEDDINGS_MODEL_BACKEND_ID).toBeUndefined();
    });

    it('picks the first model returned by the registry (biggest first)', async () => {
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([
        makeLlm('biggest-700b', 'family:700b'),
        makeLlm('mid-70b', 'family:70b'),
        makeLlm('small-8b', 'family:8b'),
      ]);

      const config = await service.getBootstrap('hermes-agent');

      expect(config.llmModelId).toBe('biggest-700b');
    });

    it('honors the persisted preferred model when it is among the runnable candidates', async () => {
      configurationService.getInferencePreferences.mockReturnValue({ preferredBackend: 'ollama', preferredModel: 'hermes4-8b' });

      const config = await service.getBootstrap('hermes-agent');

      expect(config.llmModelId).toBe('hermes4-8b');
      expect(config.llmBackendModelId).toBe('hermes4:8b');
      expect(config.env.HERMES_DEFAULT_MODEL).toBe('hermes4-8b');
    });

    it('honors a preferred model outside the recommended list when it is a runnable LLM for the tier', async () => {
      configurationService.getInferencePreferences.mockReturnValue({ preferredBackend: 'ollama', preferredModel: 'mid-70b' });
      modelRegistry.getCuratedModel.mockReturnValue(makeLlm('mid-70b', 'family:70b'));
      modelRegistry.getModelsForTier.mockReturnValue([makeLlm('mid-70b', 'family:70b')]);

      const config = await service.getBootstrap('openclaw');

      expect(config.llmModelId).toBe('mid-70b');
      expect(config.env.DEFAULT_MODEL).toBe('mid-70b');
    });

    it('falls back to the top recommended model when the preferred model is not runnable on the hardware', async () => {
      configurationService.getInferencePreferences.mockReturnValue({ preferredBackend: 'ollama', preferredModel: 'gpt-oss-120b' });
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
      modelRegistry.getModelsForTier.mockReturnValue([]);

      const config = await service.getBootstrap('hermes-agent');

      expect(config.llmModelId).toBe('hermes4-70b');
    });
  });

  describe('serializeAsDotenv', () => {
    it('emits KEY=VALUE lines with no quoting for simple values', async () => {
      const config = await service.getBootstrap('openclaw');
      const dotenv = service.serializeAsDotenv(config);

      expect(dotenv).toContain('OPENAI_API_BASE=http://ci-os-hub:3000/api/inference/v1');
      expect(dotenv).toContain('OPENAI_API_KEY=ollama');
      expect(dotenv).toContain('DEFAULT_MODEL=hermes4-70b');
      expect(dotenv.endsWith('\n')).toBe(true);
    });

    it('quotes values containing whitespace, quotes, or = signs', () => {
      const config = {
        app: 'openclaw' as const,
        apiVersion: 1 as const,
        endpointUrl: '',
        endpointReady: false,
        llmModelId: null,
        llmBackendModelId: null,
        llmReady: false,
        embeddingsModelId: null,
        embeddingsBackendModelId: null,
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
    });

    it('reports endpointReady from ollamaBackend.healthCheck', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      const config = await service.getBootstrap('openclaw');
      expect(config.endpointReady).toBe(false);
    });

    it('exposes managedKeys matching env keys for header consumers', async () => {
      const config = await service.getBootstrap('hermes-agent');
      expect(config.managedKeys.sort()).toEqual(Object.keys(config.env).sort());
    });

    it('always defaults apiVersion to 1', async () => {
      const config = await service.getBootstrap('openclaw');
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
      await service.getBootstrap('openclaw');
      await service.getBootstrap('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(1);
      expect(ollamaBackend.healthCheck).toHaveBeenCalledTimes(1);
    });

    it('keeps the cache separate per slug', async () => {
      await service.getBootstrap('hermes-agent');
      await service.getBootstrap('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache() forces a fresh resolve', async () => {
      await service.getBootstrap('openclaw');
      service.invalidateCache();
      await service.getBootstrap('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(2);
    });
  });

  describe('pre-pull', () => {
    it('fires an async pull for the recommended LLM when Ollama is reachable and model not yet pulled', async () => {
      await service.getBootstrap('openclaw');
      // tick: pullModel is invoked via void promise chain, so it should be queued by now
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).toHaveBeenCalledWith('hermes4-70b');
    });

    it('does not pull when Ollama endpoint is unreachable', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      await service.getBootstrap('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('does not pull when the model is already loaded in Ollama (modelsLoaded includes backendModelId)', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getBootstrap('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.llmReady).toBe(true);
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('does not pull when registry reports state=pulled for the catalog id', async () => {
      modelRegistry.getTrackedModel.mockReturnValue({ catalogId: 'hermes4-70b', state: 'pulled' } as any);
      service.invalidateCache();
      const config = await service.getBootstrap('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.llmReady).toBe(true);
      expect(modelPuller.pullModel).not.toHaveBeenCalled();
    });

    it('de-dupes concurrent pre-pull requests for the same model', async () => {
      let resolvePull: () => void = () => {};
      modelPuller.pullModel.mockReturnValueOnce(
        new Promise<void>((r) => {
          resolvePull = r;
        }),
      );
      await service.getBootstrap('openclaw');
      service.invalidateCache();
      await service.getBootstrap('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.pullModel).toHaveBeenCalledTimes(1);
      resolvePull();
    });
  });

  describe('isSupported', () => {
    it('recognizes supported slugs', () => {
      expect(service.isSupported('hermes-agent')).toBe(true);
      expect(service.isSupported('openclaw')).toBe(true);
    });

    it('rejects unknown slugs', () => {
      expect(service.isSupported('something-else')).toBe(false);
    });
  });
});
