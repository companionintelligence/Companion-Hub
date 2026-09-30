import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceEnvResolver } from '../inference-env-resolver';
import { ModelRegistryService } from '../model-registry.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { OmlxBackend } from '../backends/omlx.backend';
import { CloudFallbackService } from '../cloud-fallback.service';
import { InferenceEndpointService } from '../inference-endpoint.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import type { CloudProviderConfig, CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';

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

const makeCapableLlm = (id: string, backendModelId: string, options: { tools: boolean; contextWindow: number }): CuratedModel => {
  const base = makeLlm(id, backendModelId);
  return {
    ...base,
    runtime: { ...base.runtime, contextWindow: options.contextWindow },
    metadata: { capabilities: { tools: options.tools } },
  } as CuratedModel;
};

const POOL_DIRECTIONS_ON = { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } };

const makePeer = (name: string, modelsLoaded: string[], capabilities: Record<string, unknown> = {}): HubPoolPeer =>
  ({
    id: `peer-${name}`,
    nodeFqdn: `${name}.tailnet.ts.net`,
    displayName: name,
    status: 'connected',
    enabled: true,
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded }], ...capabilities },
  }) as unknown as HubPoolPeer;

const makeEmbedding = (id: string, backendModelId: string, backend: CuratedModel['backend'] = 'ollama'): CuratedModel =>
  ({
    id,
    backend,
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
  let omlxBackend: MockProxy<OmlxBackend>;
  let cloudFallback: MockProxy<CloudFallbackService>;
  let hubPoolPeerService: MockProxy<HubPoolPeerService>;

  beforeEach(async () => {
    config = mock<ConfigurationService>();
    logger = mock<LoggerService>();
    modelRegistry = mock<ModelRegistryService>();
    hardwareInspector = mock<HardwareInspectorService>();
    ollamaBackend = mock<OllamaBackend>();
    vllmBackend = mock<VllmBackend>();
    lemonadeBackend = mock<LemonadeBackend>();
    omlxBackend = mock<OmlxBackend>();
    cloudFallback = mock<CloudFallbackService>();
    hubPoolPeerService = mock<HubPoolPeerService>();
    // No connected peers by default — every existing test asserts the pre-pooling env shape, so
    // the pool override must be a no-op unless a test opts in explicitly. The always-on routing
    // switch is pinned OFF here for the same reason; its own cases below turn it back on.
    hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);
    config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: false } as never);

    config.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      maxNumCtx: null,
    } as never);
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
        { provide: OmlxBackend, useValue: omlxBackend },
        InferenceBackendRegistry,
        { provide: CloudFallbackService, useValue: cloudFallback },
        { provide: HubPoolPeerService, useValue: hubPoolPeerService },
        // The real endpoint helper, not a mock: it is the shared code this resolver and
        // AppCredentialsService both delegate to, so stubbing it would stop these tests from
        // covering the backend/pool decisions at all.
        InferenceEndpointService,
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

  it('passes the host key to apps using oMLX', async () => {
    const omlxModel = makeLlm('qwen-omlx', 'mlx-community/Qwen3-8B-4bit', false, 'omlx');
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: 'omlx',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    omlxBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:8000');
    omlxBackend.getApiKey.mockReturnValue('managed-omlx-key');
    omlxBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [omlxModel.backendModelId] });
    modelRegistry.getRecommendedModelsForHardware.mockReturnValue([omlxModel]);
    modelRegistry.getRecommendedVisionModel.mockReturnValue(undefined);

    const env = await service.resolve();

    expect(env.CI_LLM_API_KEY).toBe('managed-omlx-key');

    // Through this Hub's proxy the same app gets the placeholder: the proxy authenticates apps by
    // origin, so OMLX_API_KEY would only be copied into the container.
    config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: true } as never);
    const pooled = await service.resolve();
    expect(pooled.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
    expect(pooled.CI_LLM_API_KEY).toBe('omlx');
  });

  it('falls back to Ollama when the stored preference names a backend that does not exist', async () => {
    // settings.json is read off disk and typed by assertion, never validated, so a retired or
    // mistyped `inferenceBackend` arrives here intact — and `?? 'ollama'` only ever covered the
    // *absent* case. The registry used to hand back undefined behind a non-optional type and the
    // failure surfaced at `.healthCheck()`; it now throws, so this resolver branches on tryGet.
    // Every app install/start runs through here, so one bad character in a hand-edited file must
    // not stop every installed app from getting its CI_* env.
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: 'tensorrt-llm' as InferenceBackendType,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });

    const env = await service.resolve();

    // Asserting the whole Ollama shape, not merely that it did not throw: the fallback has to move
    // the backend *type* as well as the instance. `backendType` feeds BACKEND_API_KEY, the catalog
    // filter, and CI_INFERENCE_BACKEND, so leaving 'tensorrt-llm' in place would hand apps an undefined
    // API key and a filter no curated model can match.
    expect(env.CI_INFERENCE_BACKEND).toBe('ollama');
    expect(env.CI_LLM_BASE_URL).toBe(`${OLLAMA_BASE_URL}/v1`);
    expect(env.CI_LLM_API_KEY).toBe('ollama');
    expect(env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
    expect(env.CI_CHAT_MODEL).toBe('hermes4:70b');
    // The operator only finds the typo if the log names it. Error, not warn: this silently
    // re-points every installed app's inference backend, API key, and catalog filter.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("'tensorrt-llm'"));
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

    // The vLLM key belongs to the vLLM server. It used to be written into CI_LLM_API_KEY whatever
    // CI_LLM_BASE_URL ended up as: through the pool proxy, which never reads it, and to a decode
    // override's server, which it does not belong to.
    describe('which bearer CI_LLM_API_KEY carries', () => {
      const keyed = (overrides: Record<string, unknown> = {}) =>
        config.getInferencePreferences.mockReturnValue({
          preferredBackend: 'vllm',
          preferredModel: null,
          preferredEmbeddingModel: null,
          preferredVisionModel: null,
          preferredVllmApiKey: 'vllm-secret',
          preferredDecodeEndpoint: null,
          ...overrides,
        } as never);

      beforeEach(() => {
        keyed();
        hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([]);
      });

      it('carries the key for an app pointed straight at vLLM', async () => {
        const env = await service.resolve();

        expect(env.CI_LLM_BASE_URL).toBe(`${VLLM_BASE_URL}/v1`);
        expect(env.CI_LLM_API_KEY).toBe('vllm-secret');
      });

      it('carries the placeholder once connected peers route the app through the pool', async () => {
        hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);

        const env = await service.resolve();

        expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
        expect(env.CI_LLM_API_KEY).toBe('vllm');
      });

      it('carries the placeholder when poolRouteAppsAlways fronts this node own vLLM with no peer', async () => {
        config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: true } as never);

        const env = await service.resolve();

        expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
        expect(env.CI_LLM_API_KEY).toBe('vllm');
      });

      it('keeps VLLM_API_KEY from the environment out of a pooled app too', async () => {
        keyed({ preferredVllmApiKey: null });
        vllmBackend.getApiKey.mockReturnValue('env-vllm-key');
        hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);

        const env = await service.resolve();

        expect(env.CI_LLM_API_KEY).toBe('vllm');
      });

      it('does not send the vLLM key to a decode override on another server', async () => {
        keyed({ preferredDecodeEndpoint: 'http://decode-box:9000/v1' });

        const env = await service.resolve();

        expect(env.CI_LLM_BASE_URL).toBe('http://decode-box:9000/v1');
        expect(env.CI_LLM_API_KEY).toBe('vllm');
      });

      it('keeps the key for a decode override that names the vLLM server itself, however it is spelled', async () => {
        keyed({ preferredDecodeEndpoint: 'HTTP://CI-HUB-VLLM:8000/v1/' });

        const env = await service.resolve();

        expect(env.CI_LLM_API_KEY).toBe('vllm-secret');
      });

      it('lets pool routing win over a decode override, and hands the placeholder', async () => {
        keyed({ preferredDecodeEndpoint: `${VLLM_BASE_URL}/v1` });
        hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);

        const env = await service.resolve();

        expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
        expect(env.CI_LLM_API_KEY).toBe('vllm');
      });
    });

    it('omits the embed host and embedding model when no Ollama is reachable', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });

      const env = await service.resolve();

      expect(env.CI_CHAT_MODEL).toBe('Qwen/Qwen3-8B');
      expect(env.CI_OLLAMA_EMBED_HOST).toBeUndefined();
      expect(env.CI_EMBEDDING_MODEL).toBeUndefined();
    });
  });

  describe('Lemonade backend embeddings: host and model always name the same engine', () => {
    const LEMONADE_BASE_URL = 'http://host.docker.internal:13305';

    beforeEach(() => {
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'lemonade',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen3.8-27B-GGUF'] });
      lemonadeBackend.getBaseUrl.mockReturnValue(LEMONADE_BASE_URL);
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('qwen3-8-27b-lemonade', 'Qwen3.8-27B-GGUF', false, 'lemonade')]);
      modelRegistry.getRecommendedEmbeddingModel.mockImplementation((_tier, backend) =>
        backend === 'ollama'
          ? makeEmbedding('nomic-embed-text', 'nomic-embed-text')
          : backend === 'lemonade'
            ? makeEmbedding('nomic-embed-text-v1-5-lemonade', 'nomic-embed-text-v1.5-GGUF', 'lemonade')
            : undefined,
      );
      modelRegistry.getRecommendedVisionModel.mockReturnValue(undefined);
    });

    it("hands out Ollama's embedder with Ollama's host when Ollama is healthy, never Lemonade's id on Ollama's host", async () => {
      const env = await service.resolve();

      expect(env.CI_CHAT_MODEL).toBe('Qwen3.8-27B-GGUF');
      expect(env.CI_OLLAMA_EMBED_HOST).toBe(OLLAMA_BASE_URL);
      expect(env.CI_EMBEDDING_MODEL).toBe('nomic-embed-text');
    });

    it("embeds on Lemonade itself when there is no Ollama (Lemonade serves Ollama's /api/embed)", async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });

      const env = await service.resolve();

      expect(env.CI_OLLAMA_EMBED_HOST).toBe(LEMONADE_BASE_URL);
      expect(env.CI_EMBEDDING_MODEL).toBe('nomic-embed-text-v1.5-GGUF');
    });

    // Lemonade 10.2.0 lists and serves a Hub-registered model only as `user.<id>` and answers the
    // bare id with "Model not found", so the bare id left Memory unable to embed anything.
    it('hands out the spelling Lemonade lists the registered embedder under', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      lemonadeBackend.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['Qwen3.8-27B-GGUF', 'user.nomic-embed-text-v1.5-GGUF'],
      });

      const env = await service.resolve();

      expect(env.CI_EMBEDDING_MODEL).toBe('user.nomic-embed-text-v1.5-GGUF');
      expect(env.CI_OLLAMA_EMBED_HOST).toBe(LEMONADE_BASE_URL);
    });

    it('asks Lemonade for its own name for an embedder it has not listed yet', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      lemonadeBackend.engineModelId.mockImplementation((id) => `user.${id}`);

      const env = await service.resolve();

      expect(env.CI_EMBEDDING_MODEL).toBe('user.nomic-embed-text-v1.5-GGUF');
    });

    // Until #1679 the Lemonade default was v1, a different vector space at the same 768 dimensions.
    it('keeps a host that embedded with v1 on v1 instead of mixing v1.5 vectors into its index', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      lemonadeBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['Qwen3.8-27B-GGUF', 'nomic-embed-text-v1-GGUF'] });
      modelRegistry.getCuratedModel.mockImplementation((id) =>
        id === 'nomic-embed-text-v1-lemonade' ? makeEmbedding('nomic-embed-text-v1-lemonade', 'nomic-embed-text-v1-GGUF', 'lemonade') : undefined,
      );

      const env = await service.resolve();

      expect(env.CI_EMBEDDING_MODEL).toBe('nomic-embed-text-v1-GGUF');
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

  describe('preferred backend not running', () => {
    // The counterpart of the AppCredentialsService suite of the same name — both go through
    // InferenceEndpointService.resolveActiveBackend, so a regression in either shows up in both.
    const VLLM_BASE_URL = 'http://ci-hub-vllm:8000';

    beforeEach(() => {
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      vllmBackend.getBaseUrl.mockReturnValue(VLLM_BASE_URL);
      vllmBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
    });

    it('does not strip every AI variable when a healthy Ollama is on the same host', async () => {
      // This is the regression. With no cloud provider configured, an unavailable preferred backend
      // took the `return {}` branch: every app on the node was generated with no CI_* inference env
      // at all, silently, with a working Ollama alongside it.
      const env = await service.resolve();

      expect(env.CI_INFERENCE_BACKEND).toBe('ollama');
      expect(env.CI_LLM_BASE_URL).toBe(`${OLLAMA_BASE_URL}/v1`);
      expect(env.CI_LLM_API_KEY).toBe('ollama');
      expect(env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
      // The catalog filter follows the backend type, so the fallback has to move the type as well
      // as the instance, or nothing in the ollama catalog matches.
      expect(env.CI_CHAT_MODEL).toBe('hermes4:70b');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'vllm'"));
    });

    it('prefers the healthy local Ollama over a configured cloud provider', async () => {
      const provider: CloudProviderConfig = {
        provider: 'openai',
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
      };
      cloudFallback.getEnabledProviders.mockReturnValue([provider]);
      cloudFallback.toAppEnv.mockReturnValue({ CI_CLOUD_OPENAI_API_KEY: 'sk-test' });

      const env = await service.resolve();

      expect(env.CI_INFERENCE_BACKEND).toBe('ollama');
      expect(env.CI_LLM_BASE_URL).toBe(`${OLLAMA_BASE_URL}/v1`);
      // Cloud stays attached as a secondary; it just stops being primary.
      expect(env.cloudProviderEnv).toEqual({ CI_CLOUD_OPENAI_API_KEY: 'sk-test' });
    });

    it('still routes the fallback backend through the pool when peers are connected', async () => {
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
    });

    it('falls through to cloud only when nothing local is running at all', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      const provider: CloudProviderConfig = {
        provider: 'openai',
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
      };
      cloudFallback.getEnabledProviders.mockReturnValue([provider]);

      const env = await service.resolve();

      expect(env.CI_INFERENCE_BACKEND).toBe('cloud');
      expect(env.CI_LLM_BASE_URL).toBe('https://api.openai.com/v1');
    });
  });

  describe('multi-Hub pooling', () => {
    beforeEach(() => {
      hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([]);
    });

    it('routes CI_LLM_BASE_URL and OLLAMA_HOST through the pool proxy once a peer is connected', async () => {
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      modelRegistry.getCatalog.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b')]);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
      expect(env.CI_OLLAMA_EMBED_HOST).toMatch(/\/api\/inference\/pool$/);
      expect(env.CI_CHAT_MODEL).toBe('hermes4:70b');
    });

    it('names the model a peer serves when this node only holds one the app cannot use (core-4, 2026-09-17)', async () => {
      // The app.env counterpart of the credentials handout fix: the model used to be chosen from
      // this node's own inventory and the URL rewritten afterwards, so ci-memory and hermes-agent
      // were baked gemma3:1b while core-6 served qwen3-coder:30b over the same proxy.
      const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768 });
      const qwenCoder = makeCapableLlm('qwen3-coder-30b', 'qwen3-coder:30b', { tools: true, contextWindow: 262144 });
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b'])]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([gemma1b]);
      modelRegistry.getCatalog.mockReturnValue([gemma1b, qwenCoder]);

      const env = await service.resolve({ appSlug: 'hermes-agent', minContextLength: 64_000 });

      expect(env.CI_CHAT_MODEL).toBe('qwen3-coder:30b');
      expect(env.CI_LLM_NUM_CTX).toBe('64000');
      expect(env.CI_INFERENCE_ERROR).toBeUndefined();
    });

    it('hands pooled apps an env instead of nothing when this node backend is down but a peer serves', async () => {
      // `inference-env-resolver` returned {} whenever the local backend was not ready, so an app
      // regenerated during a local Ollama restart lost its inference env although the pool was healthy.
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['hermes4:70b'])]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      modelRegistry.getCatalog.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b')]);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(env.CI_CHAT_MODEL).toBe('hermes4:70b');
      expect(env.CI_INFERENCE_BACKEND).toBe('ollama');
    });

    it('carries CI_INFERENCE_ERROR, not a model, when nothing in the pool meets the app', async () => {
      const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768 });
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['gemma3:1b'])]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      modelRegistry.getCatalog.mockReturnValue([gemma1b]);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_CHAT_MODEL).toBeUndefined();
      expect(env.CI_LLM_NUM_CTX).toBeUndefined();
      expect(env.CI_INFERENCE_ERROR).toContain('gemma3:1b (no tool calling)');
    });

    it('leaves CI_LLM_BASE_URL pointed directly at the backend when there are no connected peers and always-on routing is off', async () => {
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toBe(`${OLLAMA_BASE_URL}/v1`);
    });
  });

  describe('routing every app through this Hub (poolRouteAppsAlways)', () => {
    it('hands the app the proxy with no peer connected when the switch is on', async () => {
      config.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: true } as never);
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
      expect(env.CI_OLLAMA_EMBED_HOST).toMatch(/\/api\/inference\/pool$/);
      // Transport only: the model and window are what the direct path would have said.
      expect(env.CI_CHAT_MODEL).toBe('hermes4:70b');
      // The peer state is still read: it is what decides whether the pool inventory reaches past
      // this node, and so whether routing changes the model as well as the transport. With no peer
      // it does not, which is what the two assertions above pin.
    });

    it('treats a configuration that cannot answer as the default, which is on', async () => {
      config.getHubPoolPreferences.mockReturnValue(undefined as never);

      const env = await service.resolve();

      expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
    });
  });

  describe('the engine-runtime context cap (core-2, 2026-09-20)', () => {
    // core-2's Ollama runs OLLAMA_NUM_PARALLEL=4 at OLLAMA_CONTEXT_LENGTH=16384; the memory ladder
    // alone hands apps 65536, and the first app turn reloaded qwen3-coder:30b at 4 x 64k.
    const qwenCoder = makeCapableLlm('qwen3-coder-30b', 'qwen3-coder:30b', { tools: true, contextWindow: 262144 });
    const setCap = (maxNumCtx: number | null) =>
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: null,
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        maxNumCtx,
      } as never);

    beforeEach(() => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['qwen3-coder:30b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([qwenCoder]);
      modelRegistry.getCatalog.mockReturnValue([qwenCoder]);
    });

    it('caps CI_LLM_NUM_CTX at the configured cap on the direct path', async () => {
      setCap(16_384);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_LLM_NUM_CTX).toBe('16384');
    });

    it('lets the cap win over an app floor, and warns that the app may refuse to start', async () => {
      setCap(16_384);

      const env = await service.resolve({ appSlug: 'hermes-agent' });

      expect(env.CI_LLM_NUM_CTX).toBe('16384');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hermes-agent: the context cap (16384) is below its 64000-token floor'));
    });

    it('sizes exactly as before when no cap is set — the default is the old behaviour', async () => {
      setCap(null);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_LLM_NUM_CTX).toBe('65536');
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('context cap'));
    });

    it('warns, without changing the handout, when Ollama holds the model at a different window than it hands out', async () => {
      // No cap set: the ladder says 65536, /api/ps says the model is loaded at the daemon's 16384.
      // Handing out 65536 reloads it, and the next 16384 request reloads it back — the flip.
      ollamaBackend.residentContextLength.mockResolvedValue(16_384);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_LLM_NUM_CTX).toBe('65536');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('openclaw: ollama holds qwen3-coder:30b at a 16384-token window and the handout is 65536'),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('OLLAMA_CONTEXT_LENGTH'));
    });

    it('is quiet once the cap matches what the engine holds the model at', async () => {
      setCap(16_384);
      ollamaBackend.residentContextLength.mockResolvedValue(16_384);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_LLM_NUM_CTX).toBe('16384');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not ask Ollama about residency for a model only a peer serves', async () => {
      hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b'])]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });

      await service.resolve({ appSlug: 'openclaw' });

      expect(ollamaBackend.residentContextLength).not.toHaveBeenCalled();
      expect(ollamaBackend.contextCostForModel).not.toHaveBeenCalled();
    });

    /**
     * The bill-co fleet, 2026-09-21: core-17 (4×16384, prompt ceiling 14000) advertised 16384, and
     * the old pool-wide MINIMUM handed ci-hermes on core-2 — an uncapped node serving the model at
     * 65536 — `HERMES_NUM_CTX=16384`, below Hermes's 64000 floor. The proxy now keeps a 65536
     * request off core-17, so the handout is bound by the largest serving cap, or by none.
     */
    describe('through the pool', () => {
      beforeEach(() => {
        hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
        hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      });

      it('caps at the LARGEST cap among the nodes serving the model — placement keeps the request off the smaller ones', async () => {
        setCap(65_536);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([
          makePeer('core-17', ['qwen3-coder:30b'], { maxNumCtx: 16_384 }),
          makePeer('beta-max', ['qwen3-coder:30b'], { maxNumCtx: 32_768 }),
        ]);

        const env = await service.resolve({ appSlug: 'openclaw' });

        expect(env.CI_LLM_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
        expect(env.CI_LLM_NUM_CTX).toBe('65536');
      });

      it('is not capped at all when a serving node has no cap: core-2 hands its Hermes 65536, not core-17 16384', async () => {
        setCap(null);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([
          makePeer('core-17', ['qwen3-coder:30b'], { maxNumCtx: 16_384 }),
          makePeer('beta-max', ['qwen3-coder:30b'], { maxNumCtx: 32_768 }),
        ]);

        const env = await service.resolve({ appSlug: 'hermes-agent' });

        expect(env.CI_LLM_NUM_CTX).toBe('65536');
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('context cap'));
      });

      it('still binds a peer-served model to the largest cap among the peers that serve it', async () => {
        setCap(null);
        ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([
          makePeer('core-17', ['qwen3-coder:30b'], { maxNumCtx: 16_384 }),
          makePeer('beta-max', ['qwen3-coder:30b'], { maxNumCtx: 32_768 }),
        ]);

        const env = await service.resolve({ appSlug: 'hermes-agent' });

        // Peer-served: the 64000 floor before the cap, beta-max's 32768 after it — and a warning,
        // since no node serving the model has a window Hermes accepts.
        expect(env.CI_LLM_NUM_CTX).toBe('32768');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hermes-agent: the context cap (32768) is below its 64000-token floor'));
      });

      it('ignores the cap of a node that serves a different model', async () => {
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('beta-red', ['gemma3:1b'], { maxNumCtx: 4096 })]);

        const env = await service.resolve({ appSlug: 'openclaw' });

        expect(env.CI_LLM_NUM_CTX).toBe('65536');
      });

      it('does not fall back to this node cap for a model only an uncapped peer serves: the request runs there, not here', async () => {
        setCap(16_384);
        ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b'])]);

        const env = await service.resolve({ appSlug: 'openclaw' });

        // Peer-served default, uncapped: this node's 16384 says nothing about core-6's engine.
        expect(env.CI_LLM_NUM_CTX).toBe('32768');
      });

      it('lets this node cap bind when this node serves the model and every peer serving it is capped no higher', async () => {
        setCap(16_384);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-17', ['qwen3-coder:30b'], { maxNumCtx: 16_384 })]);

        const env = await service.resolve({ appSlug: 'openclaw' });

        expect(env.CI_LLM_NUM_CTX).toBe('16384');
      });

      it('says a handout above this node own cap is placed on other nodes, rather than warning of a reload here', async () => {
        // beta-max: its engine runs 32768 and holds the model there; the agent tier is uncapped.
        setCap(32_768);
        ollamaBackend.residentContextLength.mockResolvedValue(32_768);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-2', ['qwen3-coder:30b'])]);

        const env = await service.resolve({ appSlug: 'hermes-agent' });

        expect(env.CI_LLM_NUM_CTX).toBe('65536');
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("hermes-agent: handed 65536 for qwen3-coder:30b, above this node's own cap (32768)"),
        );
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('its first request reloads'));
      });

      it('reads a peer cap the way the wire is read: an unbelievable value is no cap', async () => {
        ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b'], { maxNumCtx: '16384' })]);

        const env = await service.resolve({ appSlug: 'openclaw' });

        expect(env.CI_LLM_NUM_CTX).toBe('32768');
      });
    });
  });

  describe('app requirements without pooling', () => {
    it('skips an installed model the app cannot use and emits the next suitable one', async () => {
      const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768 });
      const qwen8b = makeCapableLlm('qwen3-8b', 'qwen3:8b', { tools: true, contextWindow: 40960 });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b', 'qwen3:8b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([gemma1b, qwen8b]);

      const env = await service.resolve({ appSlug: 'openclaw' });

      expect(env.CI_CHAT_MODEL).toBe('qwen3:8b');
    });

    it('keeps handing an app with no requirements the top installed model, whatever its capabilities', async () => {
      const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768 });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([gemma1b]);

      const env = await service.resolve({ appSlug: 'ci-memory' });

      expect(env.CI_CHAT_MODEL).toBe('gemma3:1b');
      expect(env.CI_INFERENCE_ERROR).toBeUndefined();
    });
  });
});
