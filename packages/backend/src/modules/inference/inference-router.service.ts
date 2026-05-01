import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackendType, InferenceModelInfo, InferenceStatus } from '@ci-hub/common/types';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { MemoryManagerService } from './memory-manager.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import type { InferenceBackend } from './backends/backend.interface';
import axios from 'axios';

@Injectable()
export class InferenceRouterService {
  constructor(
    readonly _logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly memoryManager: MemoryManagerService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
  ) {}

  private getBackend(type: InferenceBackendType): InferenceBackend {
    switch (type) {
      case 'ollama':
        return this.ollamaBackend;
      case 'vllm':
        return this.vllmBackend;
      case 'lemonade':
        return this.lemonadeBackend;
    }
  }

  /** Get full inference status for MCP / API */
  async getStatus(): Promise<InferenceStatus> {
    const profile = await this.hardwareInspector.getProfile();
    const budget = this.memoryManager.calculateBudget(profile);

    const backends = await Promise.all(
      (['ollama', 'vllm', 'lemonade'] as InferenceBackendType[]).map(async (type) => {
        const backend = this.getBackend(type);
        const health = await backend.healthCheck();
        return {
          type,
          running: health.running,
          healthy: health.healthy,
          url: backend.getBaseUrl(),
          modelsLoaded: health.modelsLoaded.length,
        };
      }),
    );

    // Build merged model list
    const models = await this.listModels();

    const cloudProviders = this.cloudFallback.listProviders().map((p) => ({
      provider: p.provider,
      enabled: p.enabled,
      configured: !!p.apiKey,
    }));

    return {
      hardwareTier: profile.tier,
      backends,
      models,
      memoryBudget: budget,
      cloudProviders,
    };
  }

  /** List all available models (local + cloud) */
  async listModels(): Promise<InferenceModelInfo[]> {
    const models: InferenceModelInfo[] = [];
    const now = Math.floor(Date.now() / 1000);

    // Local models from tracked state
    for (const tracked of this.modelRegistry.getTrackedModels()) {
      const curated = this.modelRegistry.getCuratedModel(tracked.catalogId);
      models.push({
        id: tracked.catalogId,
        object: 'model',
        created: now,
        owned_by: `local:${tracked.backend}`,
        state: tracked.state,
        backend: tracked.backend,
        modality: curated ? [curated.modality === 'llm' ? 'text' : curated.modality] : ['text'],
        local: true,
        context_window: curated?.runtime.contextWindow,
        max_tokens: curated?.runtime.maxTokens,
      });
    }

    // Also include curated models not yet tracked (available state)
    for (const curated of this.modelRegistry.getCatalog()) {
      if (!this.modelRegistry.getTrackedModel(curated.id)) {
        models.push({
          id: curated.id,
          object: 'model',
          created: now,
          owned_by: `catalog:${curated.backend}`,
          state: 'available',
          backend: curated.backend,
          modality: [curated.modality === 'llm' ? 'text' : curated.modality],
          local: true,
          context_window: curated.runtime.contextWindow,
          max_tokens: curated.runtime.maxTokens,
        });
      }
    }

    // Cloud models
    for (const provider of this.cloudFallback.getEnabledProviders()) {
      models.push({
        id: provider.defaultModel,
        object: 'model',
        created: now,
        owned_by: `cloud:${provider.provider}`,
        state: 'available',
        backend: 'cloud',
        modality: ['text'],
        local: false,
      });
    }

    // Discovered models from backends (not in curated catalog or tracked)
    const knownIds = new Set(models.map((m) => m.id));
    for (const backendType of ['ollama', 'vllm', 'lemonade'] as InferenceBackendType[]) {
      const backend = this.getBackend(backendType);
      const health = await backend.healthCheck();
      if (health.running && health.healthy) {
        for (const modelName of health.modelsLoaded) {
          if (!knownIds.has(modelName)) {
            models.push({
              id: modelName,
              object: 'model',
              created: now,
              owned_by: `local:${backendType}`,
              state: 'loaded',
              backend: backendType,
              modality: ['text'],
              local: true,
            });
            knownIds.add(modelName);
          }
        }
      }
    }

    return models;
  }

  /** Route a chat completion request */
  async routeChatCompletion(body: Record<string, unknown>): Promise<{
    data: unknown;
    headers?: Record<string, string>;
    stream?: NodeJS.ReadableStream;
    backend: string;
  }> {
    const requestedModel = (body.model as string) || 'auto';

    // 1. Resolve "auto" to default pinned LLM (checks curated catalog + discovered backends)
    const resolvedModel = requestedModel === 'auto' ? await this.resolveAutoModel() : requestedModel;

    if (!resolvedModel) {
      // No local model, try cloud
      const provider = this.cloudFallback.getEnabledProviders()[0];
      if (provider) {
        const result = await this.cloudFallback.proxyChatCompletion(provider, { ...body, model: provider.defaultModel });
        return { data: result.data, stream: result.stream, headers: result.headers, backend: `cloud:${provider.provider}` };
      }
      throw new Error('No models available — no local models loaded and no cloud providers configured');
    }

    // 2. Check if model is loaded locally
    const tracked = this.modelRegistry.getTrackedModel(resolvedModel);
    if (tracked && (tracked.state === 'loaded' || tracked.state === 'pinned')) {
      return this.proxyToBackend(tracked.backend, tracked.backendModelId, body);
    }

    // 3. Check if model is pulled but not loaded — try to load it
    if (tracked && tracked.state === 'pulled') {
      const profile = await this.hardwareInspector.getProfile();
      const curated = this.modelRegistry.getCuratedModel(resolvedModel);
      const footprint = curated?.runtime.memoryFootprintMb || 0;
      const fit = this.memoryManager.canFitModel(profile, footprint);

      if (fit.fits) {
        await this.modelPuller.loadModel(resolvedModel);
        return this.proxyToBackend(tracked.backend, tracked.backendModelId, body);
      }

      // Try eviction
      const eviction = this.memoryManager.getModelsToEvict(profile, footprint - fit.availableMb);
      if (eviction.canFree) {
        for (const evictId of eviction.modelsToEvict) {
          await this.modelPuller.unloadModel(evictId);
        }
        await this.modelPuller.loadModel(resolvedModel);
        return this.proxyToBackend(tracked.backend, tracked.backendModelId, body);
      }
    }

    // 4. Check if model is directly available on a local backend (not tracked/curated)
    for (const backendType of ['ollama', 'vllm', 'lemonade'] as InferenceBackendType[]) {
      const backend = this.getBackend(backendType);
      const health = await backend.healthCheck();
      if (health.running && health.healthy) {
        const modelNames = health.modelsLoaded;
        if (modelNames.some((m) => m === resolvedModel || m.startsWith(`${resolvedModel}:`))) {
          return this.proxyToBackend(backendType, resolvedModel, body);
        }
      }
    }

    // 5. Check if it's a cloud model
    const provider = this.cloudFallback.resolveProvider(resolvedModel);
    if (provider) {
      const result = await this.cloudFallback.proxyChatCompletion(provider, body);
      return { data: result.data, stream: result.stream, headers: result.headers, backend: `cloud:${provider.provider}` };
    }

    throw new Error(`Model ${resolvedModel} not found or not available`);
  }

  /** Route TTS request */
  async routeTts(body: Record<string, unknown>): Promise<{ data: Buffer; backend: string }> {
    // Try Lemonade first
    const lemonadeHealth = await this.lemonadeBackend.healthCheck();
    if (lemonadeHealth.running && lemonadeHealth.healthy) {
      const response = await axios.post(`${this.lemonadeBackend.getBaseUrl()}/v1/audio/speech`, body, {
        responseType: 'arraybuffer',
        timeout: 60000,
      });
      return { data: Buffer.from(response.data), backend: 'lemonade' };
    }

    // Cloud fallback
    const provider = this.cloudFallback.getEnabledProviders()[0];
    if (provider) {
      const data = await this.cloudFallback.proxyTts(provider, body);
      return { data, backend: `cloud:${provider.provider}` };
    }

    throw new Error('No TTS backend available');
  }

  /** Route STT request */
  async routeStt(formData: FormData): Promise<{ data: unknown; backend: string }> {
    const lemonadeHealth = await this.lemonadeBackend.healthCheck();
    if (lemonadeHealth.running && lemonadeHealth.healthy) {
      const response = await axios.post(`${this.lemonadeBackend.getBaseUrl()}/v1/audio/transcriptions`, formData, { timeout: 120000 });
      return { data: response.data, backend: 'lemonade' };
    }

    const provider = this.cloudFallback.getEnabledProviders()[0];
    if (provider) {
      const data = await this.cloudFallback.proxyStt(provider, formData);
      return { data, backend: `cloud:${provider.provider}` };
    }

    throw new Error('No STT backend available');
  }

  /** Route embeddings request */
  async routeEmbeddings(body: Record<string, unknown>): Promise<{ data: unknown; backend: string }> {
    // Try Ollama first
    const ollamaHealth = await this.ollamaBackend.healthCheck();
    if (ollamaHealth.running && ollamaHealth.healthy) {
      const response = await axios.post(`${this.ollamaBackend.getBaseUrl()}/v1/embeddings`, body, { timeout: 60000 });
      return { data: response.data, backend: 'ollama' };
    }

    const provider = this.cloudFallback.getEnabledProviders()[0];
    if (provider) {
      const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
      const response = await axios.post(`${baseUrl}/embeddings`, body, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        timeout: 60000,
      });
      return { data: response.data, backend: `cloud:${provider.provider}` };
    }

    throw new Error('No embeddings backend available');
  }

  /** Get default pinned model for chat */
  private getDefaultModel(): string | undefined {
    const pinned = this.modelRegistry.getPinnedModels();
    const llmPinned = pinned.find((m) => {
      const curated = this.modelRegistry.getCuratedModel(m.catalogId);
      return curated?.modality === 'llm';
    });
    if (llmPinned) return llmPinned.catalogId;

    // Any loaded LLM from curated catalog
    const loaded = this.modelRegistry.getLoadedModels();
    const llmLoaded = loaded.find((m) => {
      const curated = this.modelRegistry.getCuratedModel(m.catalogId);
      return curated?.modality === 'llm';
    });
    if (llmLoaded) return llmLoaded.catalogId;

    // Fallback: pick the first discovered model from any running backend
    // This handles cases where Ollama has models pulled but they aren't in the curated catalog
    return undefined;
  }

  /** Resolve 'auto' model by also checking running backends */
  private async resolveAutoModel(): Promise<string | undefined> {
    const defaultModel = this.getDefaultModel();
    if (defaultModel) return defaultModel;

    // Check running backends for any available model
    for (const backendType of ['ollama', 'vllm', 'lemonade'] as InferenceBackendType[]) {
      const backend = this.getBackend(backendType);
      const health = await backend.healthCheck();
      if (health.running && health.healthy && health.modelsLoaded.length > 0) {
        return health.modelsLoaded[0];
      }
    }

    return undefined;
  }

  /** Proxy request to a local backend */
  private async proxyToBackend(
    backendType: InferenceBackendType,
    backendModelId: string,
    body: Record<string, unknown>,
  ): Promise<{ data: unknown; headers?: Record<string, string>; stream?: NodeJS.ReadableStream; backend: string }> {
    const backend = this.getBackend(backendType);
    const url = `${backend.getBaseUrl()}/v1/chat/completions`;

    const requestBody: Record<string, unknown> = { ...body, model: backendModelId };

    // Find catalog ID for recording usage
    const allTracked = this.modelRegistry.getTrackedModels();
    const tracked = allTracked.find((m) => m.backendModelId === backendModelId);
    if (tracked) {
      this.modelRegistry.recordUsage(tracked.catalogId);
    }

    try {
      return await this.sendToBackend(url, requestBody, backendType, !!body.stream);
    } catch (err) {
      // If the backend rejects tools (e.g. model doesn't support function calling),
      // retry without tools/tool_choice so basic chat still works
      if (axios.isAxiosError(err) && err.response?.status === 400 && (requestBody.tools || requestBody.tool_choice)) {
        const errMsg = typeof err.response?.data === 'object' ? JSON.stringify(err.response.data) : String(err.response?.data ?? '');
        if (errMsg.includes('does not support tools') || errMsg.includes('tool')) {
          this._logger.warn(`[Inference] Model ${backendModelId} does not support tools, retrying without`);
          const { tools: _t, tool_choice: _tc, ...bodyWithoutTools } = requestBody;
          return await this.sendToBackend(url, bodyWithoutTools, backendType, !!body.stream);
        }
      }
      throw err;
    }
  }

  private async sendToBackend(
    url: string,
    requestBody: Record<string, unknown>,
    backendType: InferenceBackendType,
    stream: boolean,
  ): Promise<{ data: unknown; headers?: Record<string, string>; stream?: NodeJS.ReadableStream; backend: string }> {
    if (stream) {
      const response = await axios.post(url, requestBody, {
        responseType: 'stream',
        timeout: 0,
        headers: { 'Content-Type': 'application/json' },
      });
      return { data: null, stream: response.data, backend: backendType };
    }

    const response = await axios.post(url, requestBody, {
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });

    return { data: response.data, headers: response.headers as Record<string, string>, backend: backendType };
  }

  /** Get the inference endpoint URL for injection into app environments */
  getInferenceEndpoint(): string {
    const hubContainerName = process.env.HUB_CONTAINER_NAME || 'ci-os-hub';
    const hubPort = process.env.API_PORT || '3000';
    return `http://${hubContainerName}:${hubPort}/api/inference/v1`;
  }
}
