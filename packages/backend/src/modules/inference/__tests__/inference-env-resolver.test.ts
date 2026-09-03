import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceEnvResolver } from '../inference-env-resolver';
import { ModelRegistryService } from '../model-registry.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { DsparkBackend } from '../backends/dspark.backend';
import { CloudFallbackService } from '../cloud-fallback.service';
import type { CloudProviderConfig, CuratedModel, HardwareProfile } from '@ci-hub/common/types';

const OLLAMA_BASE_URL = 'http://host.docker.internal:11434';

const makeLlm = (id: string, backendModelId: string, vision = false, backend = 'ollama'): CuratedModel =>
  ({
    id,
    backend,
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
  let vllmBackend: MockProxy<VllmBackend>;
  let lemonadeBackend: MockProxy<LemonadeBackend>;
  let mtplxBackend: MockProxy<MtplxBackend>;
  let dsparkBackend: MockProxy<DsparkBackend>;
  let cloudFallback: MockProxy<CloudFallbackService>;

  beforeEach(async () => {
    config = mock<ConfigurationService>();
    logger = mock<LoggerService>();
    modelRegistry = mock<ModelRegistryService>();
    hardwareInspector = mock<HardwareInspectorService>();
    ollamaBackend = mock<OllamaBackend>();
    vllmBackend = mock<VllmBackend>();
    lemonadeBackend = mock<LemonadeBackend>();
    mtplxBackend = mock<MtplxBackend>();
    dsparkBackend = mock<DsparkBackend>();
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
    cloudFallback.toAppEnv.mockReturnValue({});
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
        { provide: VllmBackend, useValue: vllmBackend },
        { provide: LemonadeBackend, useValue: lemonadeBackend },
        { provide: MtplxBackend, useValue: mtplxBackend },
        { provide: DsparkBackend, useValue: dsparkBackend },
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
      CI_OLLAMA_EMBED_HOST: OLLAMA_BASE_URL,
      // 24576 MB inference budget, zero-footprint test model, 131072 window → top tier.
      CI_LLM_NUM_CTX: '65536',
      CI_INFERENCE_BACKEND: 'ollama',
    });
  });

  it('emits a hardware-aware num_ctx scaled to the inference memory budget', async () => {
    hardwareInspector.getProfile.mockResolvedValue({ ...baseProfile, effectiveInferenceMemoryMb: 4096 });

    const env = await service.resolve();

    // 4096 MB budget → 16384 tier (model window 131072 does not cap it).
    expect(env.CI_LLM_NUM_CTX).toBe('16384');
  });

  it('raises num_ctx to an app-specific minContextLength floor when given', async () => {
    // 4096 MB budget → 16384 tier, but the caller (e.g. hermes-agent) requires 64K.
    hardwareInspector.getProfile.mockResolvedValue({ ...baseProfile, effectiveInferenceMemoryMb: 4096 });

    const env = await service.resolve({ minContextLength: 64_000 });

    // Floored up to 64000 (model window 131072 leaves room).
    expect(env.CI_LLM_NUM_CTX).toBe('64000');
  });

  it('does not apply any floor when minContextLength is omitted (default behavior)', async () => {
    hardwareInspector.getProfile.mockResolvedValue({ ...baseProfile, effectiveInferenceMemoryMb: 4096 });

    const env = await service.resolve();

    expect(env.CI_LLM_NUM_CTX).toBe('16384');
  });

  it('omits all inference variables when Ollama is unavailable and no cloud provider is configured', async () => {
    ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });

    const env = await service.resolve();

    expect(env).toEqual({});
    expect(ollamaBackend.getBaseUrl).not.toHaveBeenCalled();
    expect(hardwareInspector.getProfile).not.toHaveBeenCalled();
    expect(modelRegistry.getRecommendedModelsForHardware).not.toHaveBeenCalled();
  });

  it('uses the first cloud provider as primary when the local backend is unavailable', async () => {
    const provider: CloudProviderConfig = {
      provider: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    };
    ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
    cloudFallback.getEnabledProviders.mockReturnValue([provider]);
    cloudFallback.toAppEnv.mockReturnValue({
      CI_CLOUD_OPENAI_API_KEY: 'sk-test',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
    });
    const env = await service.resolve();

    expect(env).toMatchObject({
      CI_LLM_BASE_URL: 'https://api.openai.com/v1',
      CI_LLM_API_KEY: 'sk-test',
      CI_CHAT_MODEL: 'gpt-4o',
      CI_INFERENCE_BACKEND: 'cloud',
    });
    expect(env.cloudProviderEnv).toEqual({
      CI_CLOUD_OPENAI_API_KEY: 'sk-test',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
    });
    expect(env.CI_EMBEDDING_MODEL).toBeUndefined();
    expect(env.OLLAMA_HOST).toBeUndefined();
  });

  it('keeps the local backend as primary and attaches every cloud provider', async () => {
    const provider: CloudProviderConfig = {
      provider: 'anthropic',
      enabled: true,
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-opus-4',
    };
    cloudFallback.getEnabledProviders.mockReturnValue([provider]);
    cloudFallback.toAppEnv.mockReturnValue({
      CI_CLOUD_ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
      CI_CLOUD_ANTHROPIC_MODEL: 'claude-opus-4',
      ANTHROPIC_API_KEY: 'sk-ant',
    });

    const env = await service.resolve();

    expect(env.CI_INFERENCE_BACKEND).toBe('ollama');
    expect(env.CI_LLM_API_KEY).toBe('ollama');
    expect(env.cloudProviderEnv).toEqual({
      CI_CLOUD_ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
      CI_CLOUD_ANTHROPIC_MODEL: 'claude-opus-4',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });

  it('prefers an installed recommended model over an unpulled higher-ranked one', async () => {
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b'), makeLlm('gemma4-31b', 'gemma4:31b')]);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma4:31b'] });

    const env = await service.resolve();

    expect(env.CI_CHAT_MODEL).toBe('gemma4:31b');
  });

  it('falls back from an unpulled preferred model to an installed recommended one', async () => {
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: 'preferred-llm',
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b'), makeLlm('gemma4-31b', 'gemma4:31b')]);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma4:31b'] });

    const env = await service.resolve();

    expect(env.CI_CHAT_MODEL).toBe('gemma4:31b');
  });

  it('uses the preferred model when it is installed', async () => {
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: 'preferred-llm',
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b')]);
    ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['preferred:latest', 'hermes4:70b'] });

    const env = await service.resolve();

    expect(env.CI_CHAT_MODEL).toBe('preferred:latest');
  });

  describe('vLLM backend with split-backend embeddings', () => {
    const VLLM_BASE_URL = 'http://ci-hub-vllm:8000';

    beforeEach(() => {
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      vllmBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen/Qwen3-8B'] });
      vllmBackend.getBaseUrl.mockReturnValue(VLLM_BASE_URL);
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('qwen3-8b-vllm', 'Qwen/Qwen3-8B', false, 'vllm')]);
      // Realistic catalog: embedders exist on Ollama only.
      modelRegistry.getRecommendedEmbeddingModel.mockImplementation((_tier, backend) =>
        backend === 'ollama' ? makeEmbedding('nomic-embed-text', 'nomic-embed-text') : undefined,
      );
      modelRegistry.getRecommendedVisionModel.mockReturnValue(undefined);
    });

    it('emits vLLM chat env plus the Ollama embed host + embedder when Ollama is healthy', async () => {
      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toBe(`${VLLM_BASE_URL}/v1`);
      expect(env.CI_LLM_API_KEY).toBe('vllm');
      expect(env.CI_CHAT_MODEL).toBe('Qwen/Qwen3-8B');
      // Chat runs on vLLM, so the native-Ollama chat host stays unset…
      expect(env.OLLAMA_HOST).toBeUndefined();
      // …but embeddings split to the healthy Ollama: dedicated host + its embedder.
      expect(env.CI_OLLAMA_EMBED_HOST).toBe(OLLAMA_BASE_URL);
      expect(env.CI_EMBEDDING_MODEL).toBe('nomic-embed-text');
    });

    it('uses a custom vLLM API key from Hub settings when set', async () => {
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: 'vllm-local',
      });

      const env = await service.resolve();

      expect(env.CI_LLM_API_KEY).toBe('vllm-local');
    });

    it('omits the embed host and embedding model when no Ollama is reachable', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });

      const env = await service.resolve();

      expect(env.CI_CHAT_MODEL).toBe('Qwen/Qwen3-8B');
      expect(env.CI_OLLAMA_EMBED_HOST).toBeUndefined();
      expect(env.CI_EMBEDDING_MODEL).toBeUndefined();
    });
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
