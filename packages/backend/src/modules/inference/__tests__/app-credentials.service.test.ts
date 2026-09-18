import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AppCredentialsService } from '../app-credentials.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { ModelRegistryService } from '../model-registry.service';
import { ModelPullerService } from '../model-puller.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { OllamaBackend } from '../backends/ollama.backend';
import { VllmBackend } from '../backends/vllm.backend';
import { MtplxBackend } from '../backends/mtplx.backend';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { DsparkBackend } from '../backends/dspark.backend';
import { LuceboxBackend } from '../backends/lucebox.backend';
import { InferenceEndpointService } from '../inference-endpoint.service';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CloudProviderConfig, CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import { cloudProviderManagedKeys } from '../cloud-provider-env';
import { differingHandoutKeys, HANDOUT_RECORDS_PATH, type RecordedHandout } from '../app-handout-record';
import fs from 'node:fs';

const OLLAMA_BASE_URL = 'http://ci-hub-ollama:11434';
const OLLAMA_OPENAI_URL = `${OLLAMA_BASE_URL}/v1`;
const POOL_DIRECTIONS_ON = { outbound: { enabled: true, disabledBy: null }, inbound: { enabled: true, disabledBy: null } };

/** A connected peer row as the health poll leaves it: its last capability snapshot cached on the row. */
const makePeer = (
  name: string,
  modelsLoaded: string[],
  overrides: Partial<HubPoolPeer> = {},
  capabilities: Record<string, unknown> = {},
): HubPoolPeer =>
  ({
    id: `peer-${name}`,
    nodeFqdn: `${name}.tailnet.ts.net`,
    displayName: name,
    direction: 'outbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: new Date().toISOString(),
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded }], ...capabilities },
    ...overrides,
  }) as unknown as HubPoolPeer;

const makeLlm = (id: string, backendModelId: string, minVramMb = 0, minRamMb = 0, backend: CuratedModel['backend'] = 'ollama'): CuratedModel =>
  ({
    id,
    backend,
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
    // Both apps this service serves call tools, so a row without the flag is one the handout must
    // refuse. Every real catalog LLM row sets it explicitly; the fixture does the same.
    metadata: { capabilities: { tools: true } },
    tiers: { high: 'recommended', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as unknown as CuratedModel;

/** A catalog LLM row with the capability flags and window that decide whether an app may be handed it. */
const makeCapableLlm = (
  id: string,
  backendModelId: string,
  options: { tools: boolean; contextWindow: number; intelligenceIndex?: number },
): CuratedModel => {
  const base = makeLlm(id, backendModelId);
  return {
    ...base,
    runtime: { ...base.runtime, contextWindow: options.contextWindow },
    metadata: { intelligenceIndex: options.intelligenceIndex, capabilities: { tools: options.tools } },
  } as CuratedModel;
};

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
  let vllmBackend: MockProxy<VllmBackend>;
  let lemonadeBackend: MockProxy<LemonadeBackend>;
  let mtplxBackend: MockProxy<MtplxBackend>;
  let dsparkBackend: MockProxy<DsparkBackend>;
  let luceboxBackend: MockProxy<LuceboxBackend>;
  let configurationService: MockProxy<ConfigurationService>;
  let hubPoolPeerService: MockProxy<HubPoolPeerService>;
  let testingModule: TestingModule;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    hardwareInspector = mock<HardwareInspectorService>();
    modelRegistry = mock<ModelRegistryService>();
    modelPuller = mock<ModelPullerService>();
    cloudFallback = mock<CloudFallbackService>();
    ollamaBackend = mock<OllamaBackend>();
    vllmBackend = mock<VllmBackend>();
    lemonadeBackend = mock<LemonadeBackend>();
    mtplxBackend = mock<MtplxBackend>();
    dsparkBackend = mock<DsparkBackend>();
    luceboxBackend = mock<LuceboxBackend>();
    configurationService = mock<ConfigurationService>();
    hubPoolPeerService = mock<HubPoolPeerService>();
    // No connected peers by default — every existing case asserts the direct-backend shape, so the
    // pool override must be a no-op unless a test opts in explicitly. The always-on routing switch
    // is pinned OFF for the same reason; its own cases below turn it on.
    hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);
    configurationService.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: false } as never);

    configurationService.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    modelPuller.evaluatePull.mockResolvedValue({
      catalogId: 'hermes4-70b',
      alreadyInstalled: false,
      canPull: true,
      requiredDiskMb: 0,
      requiredMemoryMb: 0,
      availableDiskMb: 100000,
      availableMemoryMb: 100000,
    });
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
    modelPuller.startPull.mockResolvedValue({ catalogId: 'hermes4-70b', status: 'queued' });
    modelPuller.waitForPullCompletion.mockResolvedValue(undefined);
    cloudFallback.getEnabledProviders.mockReturnValue([]);
    cloudFallback.toAppEnv.mockReturnValue({});

    testingModule = await Test.createTestingModule({
      providers: [
        AppCredentialsService,
        { provide: LoggerService, useValue: logger },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
        { provide: ModelRegistryService, useValue: modelRegistry },
        { provide: ModelPullerService, useValue: modelPuller },
        { provide: CloudFallbackService, useValue: cloudFallback },
        { provide: OllamaBackend, useValue: ollamaBackend },
        { provide: VllmBackend, useValue: vllmBackend },
        { provide: LemonadeBackend, useValue: lemonadeBackend },
        { provide: MtplxBackend, useValue: mtplxBackend },
        { provide: DsparkBackend, useValue: dsparkBackend },
        { provide: LuceboxBackend, useValue: luceboxBackend },
        InferenceBackendRegistry,
        { provide: ConfigurationService, useValue: configurationService },
        { provide: HubPoolPeerService, useValue: hubPoolPeerService },
        // The real endpoint helper, not a mock: it is the shared code this service and
        // InferenceEnvResolver both delegate to, so stubbing it would stop these tests from
        // covering the backend/pool decisions at all.
        InferenceEndpointService,
      ],
    }).compile();

    service = testingModule.get<AppCredentialsService>(AppCredentialsService);
  });

  afterEach(async () => {
    // Drain handout-record writes so one test's file cannot land after the next test resets the volume.
    await service.onApplicationShutdown();
  });

  describe('getCredentials — local (direct Ollama) path', () => {
    it('throws NotFoundException for unknown slugs', async () => {
      await expect(service.getCredentials('unknown-app')).rejects.toThrow(NotFoundException);
    });

    it('treats companion-memory as unsupported because it is no longer a Hub-managed bootstrap client', async () => {
      await expect(service.getCredentials('companion-memory')).rejects.toThrow(NotFoundException);
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
        // 24576 MB budget, zero-footprint test model, 131072 window → top tier.
        HERMES_NUM_CTX: '65536',
        CI_INFERENCE_BACKEND: 'ollama',
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
        CI_LLM_NUM_CTX: '65536',
        CI_INFERENCE_BACKEND: 'ollama',
      });
    });

    it('floors hermes-agent context to its 64K minimum on memory-constrained hardware, but not openclaw', async () => {
      // ~12 GiB inference budget → memory ladder picks the 32768 tier. Hermes
      // declares a 64000-token minimum (it aborts below that), so its value is
      // floored up; openclaw has no minimum and keeps the ladder value.
      hardwareInspector.getProfile.mockResolvedValue({ ...baseProfile, effectiveInferenceMemoryMb: 12288 });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();

      const hermes = await service.getCredentials('hermes-agent');
      expect(hermes.env.HERMES_NUM_CTX).toBe('64000');

      const openclaw = await service.getCredentials('openclaw');
      expect(openclaw.env.CI_LLM_NUM_CTX).toBe('32768');
    });

    it('hands hermes-agent no model rather than one below its 64K minimum, and says why in CI_INFERENCE_ERROR', async () => {
      // This used to cap num_ctx to the model's 32K window, log "hermes-agent may refuse to start",
      // and hand the model out anyway — and Hermes then refused to start. An explicit error in a
      // 200 body is the only thing the bootstrap script will actually write into the app's env.
      const smallModel = {
        ...makeLlm('small-1b', 'small:1b', 1024, 2048),
        runtime: { ...makeLlm('small-1b', 'small:1b').runtime, contextWindow: 32768 },
      } as unknown as CuratedModel;
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['small:1b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([smallModel]);
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'small-1b' ? smallModel : undefined));
      service.invalidateCache();

      const config = await service.getCredentials('hermes-agent');
      await new Promise((resolve) => setImmediate(resolve));

      expect(config.chatModelId).toBeNull();
      expect(config.env.HERMES_DEFAULT_MODEL).toBeUndefined();
      expect(config.env.HERMES_NUM_CTX).toBeUndefined();
      expect(config.env.CI_INFERENCE_ERROR).toContain('small:1b');
      expect(config.env.CI_INFERENCE_ERROR).toContain('32768-token window (needs 64000)');
      expect(config.chatModelError).toBe(config.env.CI_INFERENCE_ERROR);
      // Managed even though unset, so the bootstrap script strips a model left from an earlier run.
      expect(config.managedKeys).toEqual(expect.arrayContaining(['HERMES_DEFAULT_MODEL', 'CI_INFERENCE_ERROR']));
      // Pulling a model the app would refuse spends the disk for nothing.
      expect(modelPuller.startPull).not.toHaveBeenCalledWith('small-1b', expect.anything());
    });

    it('hands openclaw no model that lacks tool calling, even when it is the only one installed', async () => {
      const noTools = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768 });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([noTools]);
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === 'gemma3-1b' ? noTools : undefined));
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.env.DEFAULT_MODEL).toBeUndefined();
      expect(config.env.CI_INFERENCE_ERROR).toContain('gemma3:1b (no tool calling)');
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
        CI_INFERENCE_BACKEND: 'ollama',
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
      expect(modelPuller.startPull).toHaveBeenCalledWith('nomic-embed-text', { bestEffort: true });
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

    it('falls back to Ollama when the stored preference names a backend that does not exist', async () => {
      // settings.json is read off disk and typed by assertion, never validated, so a retired or
      // mistyped `inferenceBackend` reaches the registry intact — `?? 'ollama'` only ever covered
      // the *absent* case. The registry used to return undefined behind a non-optional type and die
      // at `.healthCheck()`; it now throws, so this service branches on tryGet instead. Every
      // installed app fetches its credentials through here, so a stale settings.json must not take
      // credential resolution down Hub-wide.
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'llamacpp' as InferenceBackendType,
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();

      const config = await service.getCredentials('hermes-agent');

      // The fallback moves the backend *type*, not just the instance: `provider` is reported to the
      // app, and the same value indexes BACKEND_API_KEY, so leaving 'llamacpp' in place would ship
      // an undefined HERMES_OPENAI_API_KEY.
      expect(config.provider).toBe('ollama');
      expect(config.endpointUrl).toBe(OLLAMA_OPENAI_URL);
      expect(config.env.HERMES_OPENAI_API_KEY).toBe('ollama');
      expect(config.chatModelId).toBe('hermes4:70b');
      // The operator only finds the typo if the log names it.
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("'llamacpp'"));
    });
  });

  describe('getCredentials — vLLM backend', () => {
    const VLLM_BASE_URL = 'http://host.docker.internal:8000';
    const VLLM_OPENAI_URL = `${VLLM_BASE_URL}/v1`;

    beforeEach(() => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: 'qwen-vllm',
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: 'vllm-local',
        preferredVllmUrl: VLLM_BASE_URL,
      });
      vllmBackend.getBaseUrl.mockReturnValue(VLLM_BASE_URL);
      vllmBackend.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['Qwen/Qwen2.5-7B-Instruct'],
      });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text'] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([makeLlm('qwen-vllm', 'Qwen/Qwen2.5-7B-Instruct', 8000, 16000, 'vllm')]);
      modelRegistry.getCuratedModel.mockImplementation((id) => {
        if (id === 'qwen-vllm') return makeLlm('qwen-vllm', 'Qwen/Qwen2.5-7B-Instruct', 8000, 16000, 'vllm');
        if (id === 'nomic-embed-text') return makeEmbedding('nomic-embed-text', 'nomic-embed-text');
        return undefined;
      });
      modelRegistry.getTrackedModel.mockReturnValue(undefined);
      service.invalidateCache();
    });

    it('points openclaw at vLLM /v1 with the served model id, not a stale Ollama tag', async () => {
      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('vllm');
      expect(config.endpointUrl).toBe(VLLM_OPENAI_URL);
      expect(config.chatModelId).toBe('Qwen/Qwen2.5-7B-Instruct');
      expect(config.env).toEqual({
        OPENAI_API_BASE: VLLM_OPENAI_URL,
        OPENAI_API_KEY: 'vllm-local',
        DEFAULT_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
        OLLAMA_HOST: OLLAMA_BASE_URL,
        CI_LLM_NUM_CTX: '65536',
        CI_INFERENCE_BACKEND: 'vllm',
      });
    });

    it('falls back to the first served vLLM model when the preferred catalog model is absent', async () => {
      vllmBackend.healthCheck.mockResolvedValue({
        running: true,
        healthy: true,
        modelsLoaded: ['meta/custom-model'],
      });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([]);
      modelRegistry.getCuratedModel.mockReturnValue(undefined);
      modelRegistry.getModelsForTier.mockReturnValue([]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBe('meta/custom-model');
    });

    it('does not pre-pull chat models through Ollama when the backend is vLLM', async () => {
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.startPull).not.toHaveBeenCalledWith('qwen-vllm', expect.anything());
    });
  });

  describe('getCredentials — desktop-managed mlx-dspark', () => {
    it('hands the generated API key to direct sibling-app clients', async () => {
      const model = makeLlm('qwen-dspark', 'mlx-community/Qwen3-8B-8bit', 8000, 16000, 'dspark');
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'dspark',
        preferredModel: 'qwen-dspark',
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      dsparkBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:8080');
      dsparkBackend.getApiKey.mockReturnValue('managed-dspark-key');
      dsparkBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [model.backendModelId] });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([model]);
      modelRegistry.getCuratedModel.mockImplementation((id) => (id === model.id ? model : undefined));
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.env.OPENAI_API_KEY).toBe('managed-dspark-key');
      expect(config.endpointUrl).toBe('http://host.docker.internal:8080/v1');
    });
  });

  describe('getCredentials — cloud providers', () => {
    const cloudProvider: CloudProviderConfig = {
      provider: 'openai',
      apiKey: 'sk-operator-key',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
    };
    const cloudEnv = {
      CI_CLOUD_OPENAI_API_KEY: 'sk-operator-key',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
    };

    it('keeps the local backend as primary and attaches cloud provider env', async () => {
      cloudFallback.getEnabledProviders.mockReturnValue([cloudProvider]);
      cloudFallback.toAppEnv.mockReturnValue(cloudEnv);

      const config = await service.getCredentials('hermes-agent');

      expect(config.provider).toBe('ollama');
      expect(config.env.HERMES_OPENAI_API_KEY).toBe('ollama');
      expect(config.env.CI_INFERENCE_BACKEND).toBe('ollama');
      expect(config.env.CI_CLOUD_OPENAI_API_KEY).toBe('sk-operator-key');
      expect(config.env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
    });

    it('uses the first cloud provider as primary when the local backend is down', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      cloudFallback.getEnabledProviders.mockReturnValue([cloudProvider]);
      cloudFallback.toAppEnv.mockReturnValue(cloudEnv);

      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('cloud');
      expect(config.env.OPENAI_API_BASE).toBe('https://api.openai.com/v1');
      expect(config.env.OPENAI_API_KEY).toBe('sk-operator-key');
      expect(config.env.CI_CLOUD_OPENAI_API_KEY).toBe('sk-operator-key');
      expect(config.env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
    });
  });

  describe('getCredentials — multi-Hub pooling', () => {
    // The generated-app.env path (InferenceEnvResolver) has routed through the pool since pooling
    // shipped; this endpoint did not. Apps that bootstrap their inference config over HTTP rather
    // than from app.env — CI-OpenClaw and CI-Hermes, the only two slugs this endpoint serves — were
    // therefore the one class of app that never used the pool, on every pooled node. Both paths now
    // call InferenceEndpointService.resolvePoolRouting, so these assertions and the resolver's own
    // pooling block are pinning a single implementation.
    beforeEach(() => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([]);
      modelRegistry.getCatalog.mockReturnValue([makeLlm('hermes4-70b', 'hermes4:70b'), makeLlm('hermes4-8b', 'hermes4:8b')]);
      service.invalidateCache();
    });

    it('points the app at this Hub pool proxy once a peer is connected', async () => {
      const config = await service.getCredentials('openclaw');

      expect(config.endpointUrl).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(config.env.OPENAI_API_BASE).toBe(config.endpointUrl);
      expect(config.env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
      expect(config.routedThroughPool).toBe(true);
      // This node serves the model itself, so its own memory still sizes the context window.
      expect(config.chatModelId).toBe('hermes4:70b');
      expect(config.chatModelServedBy).toEqual(['this Hub']);
      expect(config.env.DEFAULT_MODEL).toBe('hermes4:70b');
      expect(config.provider).toBe('ollama');
      expect(config.env.CI_INFERENCE_BACKEND).toBe('ollama');
      expect(config.env.CI_LLM_NUM_CTX).toBe('65536');
    });

    it('serves the same pooled endpoint to hermes-agent under its own env keys', async () => {
      const config = await service.getCredentials('hermes-agent');

      expect(config.env.HERMES_OPENAI_BASE_URL).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(config.env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
    });

    it('hands the app the proxy with no peer connected when poolRouteAppsAlways is on (the default)', async () => {
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);
      configurationService.getHubPoolPreferences.mockReturnValue({ poolRouteAppsAlways: true } as never);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.endpointUrl).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(config.env.OLLAMA_HOST).toMatch(/\/api\/inference\/pool$/);
      expect(config.env.DEFAULT_MODEL).toBe('hermes4:70b');
    });

    it('leaves the app on the direct backend URL when no peer is connected', async () => {
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(false);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.endpointUrl).toBe(OLLAMA_OPENAI_URL);
      expect(config.env.OLLAMA_HOST).toBe(OLLAMA_BASE_URL);
    });

    it('does not put the pool in front of a cloud-primary endpoint', async () => {
      // Matching the resolver: a cloud answer means this node has no local inference to pool with,
      // and the app already holds a working endpoint. Routing an api.openai.com base URL through
      // the local pool proxy would break it outright.
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-operator-key', enabled: true, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
      ] as CloudProviderConfig[]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('cloud');
      expect(config.env.OPENAI_API_BASE).toBe('https://api.openai.com/v1');
    });
  });

  describe('getCredentials — pooled handout chooses from what the pool serves (core-4, 2026-09-17)', () => {
    // core-4's own Ollama held only gemma3:1b (no tools, 32K window). Its one peer, core-6, served
    // qwen3-coder:30b (tools, 262K). The operator's preferred model was qwen3-coder-30b. Both
    // bootstrap.env handouts named gemma3:1b with HERMES_NUM_CTX=32000, and the next fetch queued a
    // ~21 GB pull of qwen3-coder:30b onto core-4.
    const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32768, intelligenceIndex: 4.8 });
    const qwenCoder = makeCapableLlm('qwen3-coder-30b', 'qwen3-coder:30b', { tools: true, contextWindow: 262144, intelligenceIndex: 9.6 });
    const core6 = makePeer('core-6', ['qwen3-coder:30b', 'qwen3-coder-30b', 'nomic-embed-text:latest']);

    beforeEach(() => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      hardwareInspector.getProfile.mockResolvedValue({ ...baseProfile, effectiveInferenceMemoryMb: 6144, tier: 'low' });
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel: 'qwen3-coder-30b',
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      // The recommender lists the preferred model for this hardware, which is what made the old
      // handout queue a pull of it.
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([qwenCoder, gemma1b]);
      modelRegistry.getCatalog.mockReturnValue([gemma1b, qwenCoder, makeEmbedding('nomic-embed-text', 'nomic-embed-text')]);
      modelRegistry.getCuratedModel.mockImplementation((id) => [gemma1b, qwenCoder].find((m) => m.id === id));
      modelRegistry.getRecommendedEmbeddingModel.mockReturnValue(makeEmbedding('nomic-embed-text', 'nomic-embed-text'));
      hubPoolPeerService.hasConnectedPeers.mockResolvedValue(true);
      hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([core6]);
      service.invalidateCache();
    });

    it('hands openclaw and hermes-agent the model core-6 serves, not the local gemma3:1b', async () => {
      const openclaw = await service.getCredentials('openclaw');
      const hermes = await service.getCredentials('hermes-agent');

      for (const config of [openclaw, hermes]) {
        expect(config.routedThroughPool).toBe(true);
        expect(config.chatModelId).toBe('qwen3-coder:30b');
        expect(config.chatModelServedBy).toEqual(['core-6']);
        expect(config.chatModelReady).toBe(true);
        expect(config.chatModelError).toBeNull();
      }
      expect(openclaw.env.DEFAULT_MODEL).toBe('qwen3-coder:30b');
      expect(hermes.env.HERMES_DEFAULT_MODEL).toBe('qwen3-coder:30b');
    });

    it('sizes num_ctx for the peer that serves the model, not from core-4 memory, and still floors hermes-agent at 64000', async () => {
      const openclaw = await service.getCredentials('openclaw');
      const hermes = await service.getCredentials('hermes-agent');

      // core-4's 6 GB budget would have produced 16384; the model runs on core-6.
      expect(openclaw.env.CI_LLM_NUM_CTX).toBe('32768');
      expect(hermes.env.HERMES_NUM_CTX).toBe('64000');
    });

    it('does not queue a pull of a model the pool already serves when a credentials GET arrives', async () => {
      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));

      expect(modelPuller.startPull).not.toHaveBeenCalledWith('qwen3-coder-30b', expect.anything());
      const chat = config.prePull.find((decision) => decision.kind === 'chat');
      expect(chat).toEqual({ kind: 'chat', catalogId: 'qwen3-coder-30b', pull: false, reason: 'already served by pool node(s) core-6' });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('pre-pull decision slug=openclaw chat=qwen3-coder-30b pull=false'));
      // The embedder core-6 lists under its implicit :latest tag is not pulled either.
      expect(modelPuller.startPull).not.toHaveBeenCalledWith('nomic-embed-text', expect.anything());
    });

    it('skips a preferred model that fails the app and hands out the best one that meets it', async () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel: 'gemma3-1b',
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b', 'gemma3:1b'])]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBe('qwen3-coder:30b');
    });

    it('honours a preferred model the pool serves over a higher-ranked one', async () => {
      const qwen8b = makeCapableLlm('qwen3-8b', 'qwen3:8b', { tools: true, contextWindow: 40960, intelligenceIndex: 5 });
      modelRegistry.getCatalog.mockReturnValue([gemma1b, qwenCoder, qwen8b]);
      modelRegistry.getModelsForHardware.mockReturnValue([gemma1b, qwenCoder, qwen8b]);
      modelRegistry.getCuratedModel.mockImplementation((id) => [gemma1b, qwenCoder, qwen8b].find((m) => m.id === id));
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel: 'qwen3-8b',
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b', 'qwen3:8b'])]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBe('qwen3:8b');
    });

    it('hands out an explicit error, not gemma3:1b, when no pool node serves a model the app can use', async () => {
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['gemma3:1b'])]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');
      const dotenv = service.serializeAsDotenv(config);

      expect(config.chatModelId).toBeNull();
      expect(config.env.DEFAULT_MODEL).toBeUndefined();
      expect(config.env.CI_INFERENCE_ERROR).toContain("No chat model served by this Hub's pool meets openclaw's requirements (tool calling)");
      expect(config.env.CI_INFERENCE_ERROR).toContain('gemma3:1b (no tool calling)');
      expect(dotenv).toMatch(/^CI_INFERENCE_ERROR="No chat model/m);
      expect(config.managedKeys).toEqual(expect.arrayContaining(['DEFAULT_MODEL', 'CI_INFERENCE_ERROR']));
    });

    it('ignores peers the proxy would not send work to: outbound off, peer disabled, or not accepting work', async () => {
      const cases: Array<{ label: string; setup: () => void }> = [
        {
          label: 'outbound off',
          setup: () => hubPoolPeerService.directions.mockReturnValue({ ...POOL_DIRECTIONS_ON, outbound: { enabled: false, disabledBy: 'setting' } }),
        },
        { label: 'peer disabled', setup: () => hubPoolPeerService.listConnectedPeers.mockResolvedValue([{ ...core6, enabled: false }]) },
        {
          label: 'not accepting work',
          setup: () =>
            hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3-coder:30b'], {}, { acceptingWork: false })]),
        },
      ];
      for (const { label, setup } of cases) {
        hubPoolPeerService.directions.mockReturnValue(POOL_DIRECTIONS_ON);
        hubPoolPeerService.listConnectedPeers.mockResolvedValue([core6]);
        setup();
        service.invalidateCache();

        const config = await service.getCredentials('openclaw');

        expect({ label, model: config.chatModelId }).toEqual({ label, model: null });
      }
    });

    it('serves the pool instead of cloud when this node backend is down but a peer serves the app', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-operator-key', enabled: true, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
      ] as CloudProviderConfig[]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('ollama');
      expect(config.endpointUrl).toMatch(/\/api\/inference\/pool\/v1$/);
      expect(config.endpointReady).toBe(true);
      expect(config.chatModelId).toBe('qwen3-coder:30b');
    });

    it("does not pull this node's hardware recommendation for an app the pool already serves when no model was chosen", async () => {
      const qwen36 = makeCapableLlm('qwen3-6-27b', 'qwen3.6:27b', { tools: true, contextWindow: 262144, intelligenceIndex: 9 });
      modelRegistry.getCatalog.mockReturnValue([gemma1b, qwenCoder, qwen36]);
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([makePeer('core-6', ['qwen3.6:27b', 'nomic-embed-text:latest'])]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));

      expect(config.chatModelId).toBe('qwen3.6:27b');
      expect(config.prePull.find((d) => d.kind === 'chat')).toMatchObject({ catalogId: 'qwen3-coder-30b', pull: false });
      expect(modelPuller.startPull).not.toHaveBeenCalled();
    });

    it('still pulls when neither this node nor any pool node serves the recommended model', async () => {
      hubPoolPeerService.listConnectedPeers.mockResolvedValue([]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: [] });
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));

      expect(config.prePull.find((d) => d.kind === 'chat')).toMatchObject({ catalogId: 'qwen3-coder-30b', pull: true });
      expect(modelPuller.startPull).toHaveBeenCalledWith('qwen3-coder-30b', { bestEffort: true });
    });
  });

  describe('previewCredentials and lastHandout', () => {
    it('previews without pulling, caching, or recording a handout', async () => {
      const preview = await service.previewCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));

      // The same default setup makes getCredentials pre-pull hermes4-70b (see the pre-pull suite).
      expect(preview.prePull.find((d) => d.kind === 'chat')).toMatchObject({ catalogId: 'hermes4-70b', pull: true });
      expect(modelPuller.startPull).not.toHaveBeenCalled();
      expect(await service.lastHandout('openclaw')).toBeNull();

      await service.getCredentials('openclaw');
      expect(hardwareInspector.getProfile).toHaveBeenCalledTimes(2);
    });

    it('records what each app was actually served, including cache hits', async () => {
      const served = await service.getCredentials('openclaw');
      const first = await service.lastHandout('openclaw');
      expect(first).toMatchObject({ chatModelId: served.chatModelId, routedThroughPool: false, endpointUrl: served.endpointUrl });

      await service.getCredentials('openclaw');
      expect((await service.lastHandout('openclaw'))?.envDigests).toEqual(first?.envDigests);
      expect(await service.lastHandout('hermes-agent')).toBeNull();
    });

    it('still knows what an app holds after the Hub restarts, without writing its keys to disk', async () => {
      // App containers keep running through a Hub restart and fetch bootstrap.env only when they
      // start. A record lost with the process made every such app read as stale, and the next
      // refresh restarted it for nothing.
      cloudFallback.toAppEnv.mockReturnValue({ CI_CLOUD_OPENAI_API_KEY: 'sk-operator-secret' });
      const served = await service.getCredentials('openclaw');
      await service.onApplicationShutdown();

      const restarted = new AppCredentialsService(
        logger,
        hardwareInspector,
        modelRegistry,
        modelPuller,
        cloudFallback,
        ollamaBackend,
        configurationService,
        testingModule.get(InferenceEndpointService),
      );
      const record = await restarted.lastHandout('openclaw');

      expect(record).toMatchObject({ chatModelId: served.chatModelId, endpointUrl: served.endpointUrl });
      expect(differingHandoutKeys(record as RecordedHandout, await restarted.previewCredentials('openclaw'))).toEqual([]);
      expect(await fs.promises.readFile(HANDOUT_RECORDS_PATH, 'utf8')).not.toContain('sk-operator-secret');

      cloudFallback.toAppEnv.mockReturnValue({ CI_CLOUD_OPENAI_API_KEY: 'sk-rotated' });
      expect(differingHandoutKeys(record as RecordedHandout, await restarted.previewCredentials('openclaw'))).toEqual(['CI_CLOUD_OPENAI_API_KEY']);
    });
  });

  describe('getCredentials — preferred backend not running', () => {
    // A preference is a preference, not a veto. `inferenceBackend: "vllm"` with no vLLM process
    // running used to mean "this node has no local inference": the app was handed the dead vLLM URL
    // (or a cloud endpoint) and no chat model, while a healthy Ollama with models pulled sat on the
    // same host and was never even probed.
    beforeEach(() => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
      });
      vllmBackend.getBaseUrl.mockReturnValue('http://host.docker.internal:8000');
      vllmBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
    });

    it('falls back to the healthy local Ollama rather than to the dead preferred backend', async () => {
      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('ollama');
      expect(config.endpointUrl).toBe(OLLAMA_OPENAI_URL);
      expect(config.endpointReady).toBe(true);
      expect(config.env.CI_INFERENCE_BACKEND).toBe('ollama');
      // The catalog filter follows the backend type, so the fallback has to move the type as well
      // as the instance — leaving 'vllm' in place matches no curated ollama model and the app ends
      // up with no chat model at all.
      expect(config.chatModelId).toBe('hermes4:70b');
      expect(config.chatModelReady).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'vllm'"));
    });

    it('does not hand the app a cloud endpoint when a working local backend is available', async () => {
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-operator-key', enabled: true, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
      ] as CloudProviderConfig[]);
      cloudFallback.toAppEnv.mockReturnValue({ CI_CLOUD_OPENAI_API_KEY: 'sk-operator-key' });
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('ollama');
      expect(config.env.OPENAI_API_BASE).toBe(OLLAMA_OPENAI_URL);
      // The cloud provider stays attached as a secondary — it just stops being primary.
      expect(config.env.CI_CLOUD_OPENAI_API_KEY).toBe('sk-operator-key');
    });

    it('still falls through to cloud when nothing local is running at all', async () => {
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-operator-key', enabled: true, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
      ] as CloudProviderConfig[]);
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.provider).toBe('cloud');
      expect(config.env.OPENAI_API_BASE).toBe('https://api.openai.com/v1');
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
        routedThroughPool: false,
        chatModelServedBy: [],
        chatModelError: null,
        prePull: [],
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

    it('rejects unknown slugs', () => {
      expect(service.isSupported('something-else')).toBe(false);
    });

    it('reports endpointReady from ollamaBackend.healthCheck', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      expect(config.endpointReady).toBe(false);
    });

    it('exposes managedKeys covering env keys plus the always-managed num_ctx and error keys', async () => {
      // Default setup has no loaded model, so neither is emitted — but each must still be declared
      // managed so header consumers drop a stale value.
      const config = await service.getCredentials('hermes-agent');
      expect(config.env.HERMES_NUM_CTX).toBeUndefined();
      expect(config.env.HERMES_DEFAULT_MODEL).toBeUndefined();
      expect(config.managedKeys).toContain('HERMES_NUM_CTX');
      for (const k of Object.keys(config.env)) {
        expect(config.managedKeys).toContain(k);
      }
      const expected = [...new Set([...Object.keys(config.env), 'HERMES_NUM_CTX', 'CI_INFERENCE_ERROR', ...cloudProviderManagedKeys()])];
      expect(config.managedKeys.sort()).toEqual(expected.sort());
    });

    it("leaves an app's last model in place when the container starts before Ollama is up", async () => {
      // Declaring DEFAULT_MODEL managed here would make bootstrap-from-hub.sh strip a model that works
      // as soon as Ollama finishes starting, and the app would run with none until its next restart.
      ollamaBackend.healthCheck.mockResolvedValue({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBeNull();
      expect(config.managedKeys).not.toContain('DEFAULT_MODEL');
      expect(config.managedKeys).toEqual(expect.arrayContaining(['CI_LLM_NUM_CTX', 'CI_INFERENCE_ERROR']));
    });

    it('strips the stale model once a running backend has judged every installed model unsuitable', async () => {
      const gemma1b = makeCapableLlm('gemma3-1b', 'gemma3:1b', { tools: false, contextWindow: 32000 });
      modelRegistry.getRecommendedModelsForHardware.mockReturnValue([gemma1b]);
      ollamaBackend.healthCheck.mockResolvedValue({ running: true, healthy: true, modelsLoaded: ['gemma3:1b'] });
      service.invalidateCache();

      const config = await service.getCredentials('openclaw');

      expect(config.chatModelId).toBeNull();
      expect(config.chatModelError).toContain('gemma3:1b (no tool calling)');
      expect(config.managedKeys).toContain('DEFAULT_MODEL');
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
      expect(modelPuller.startPull).toHaveBeenCalledWith('hermes4-70b', { bestEffort: true });
    });

    it('does not pull when Ollama endpoint is unreachable', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: false, healthy: false, modelsLoaded: [] });
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.startPull).not.toHaveBeenCalled();
    });

    it('does not pull when the model is already loaded in Ollama (modelsLoaded includes backendModelId)', async () => {
      ollamaBackend.healthCheck.mockResolvedValueOnce({ running: true, healthy: true, modelsLoaded: ['hermes4:70b'] });
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.chatModelReady).toBe(true);
      expect(modelPuller.startPull).not.toHaveBeenCalled();
    });

    it('does not pull when registry reports state=pulled for the catalog id', async () => {
      modelRegistry.getTrackedModel.mockReturnValue({ catalogId: 'hermes4-70b', state: 'pulled' } as any);
      service.invalidateCache();
      const config = await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(config.chatModelReady).toBe(true);
      expect(modelPuller.startPull).not.toHaveBeenCalled();
    });

    it('de-dupes concurrent pre-pull requests for the same model via startPull in_progress', async () => {
      modelPuller.startPull
        .mockResolvedValueOnce({ catalogId: 'hermes4-70b', status: 'queued' })
        .mockResolvedValueOnce({ catalogId: 'hermes4-70b', status: 'in_progress' });
      await service.getCredentials('openclaw');
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.startPull).toHaveBeenCalledTimes(2);
    });

    it('still pre-pulls local chat models when cloud providers are also configured', async () => {
      cloudFallback.getEnabledProviders.mockReturnValue([
        { provider: 'openai', apiKey: 'sk-test', enabled: true, defaultModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
      ] as CloudProviderConfig[]);
      cloudFallback.toAppEnv.mockReturnValue({ CI_CLOUD_OPENAI_API_KEY: 'sk-test' });
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.startPull).toHaveBeenCalledWith('hermes4-70b', { bestEffort: true });
    });

    it('skips pre-pull when startPull reports blocked download', async () => {
      modelPuller.startPull.mockResolvedValueOnce({
        catalogId: 'hermes4-70b',
        status: 'skipped',
        reason: 'Not enough disk',
      });
      service.invalidateCache();
      await service.getCredentials('openclaw');
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelPuller.startPull).toHaveBeenCalledWith('hermes4-70b', { bestEffort: true });
    });
  });
});
