import { Injectable, forwardRef, Inject, Optional } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { hubContainerName } from '@/common/constants';
import type { BackendHealthStatus, InferenceBackendType, InferenceModelInfo, InferenceStatus } from '@ci-hub/common/types';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { MemoryManagerService } from './memory-manager.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { ModelPullerService } from './model-puller.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { InferenceBackend } from './backends/backend.interface';
import { resolveInstalledCatalogIds } from './model-availability.util';

/** One parallel health sweep over every registered backend. */
type ProbedBackends = ReadonlyArray<readonly [InferenceBackendType, InferenceBackend, BackendHealthStatus]>;

/**
 * Inference router — unified routing view over local backends + multi-node pool + cloud fallback.
 */
@Injectable()
export class InferenceRouterService {
  constructor(
    readonly _logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly memoryManager: MemoryManagerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly backends: InferenceBackendRegistry,
    @Inject(forwardRef(() => ModelPullerService))
    private readonly modelPuller: ModelPullerService,
    // Optional and last: the router's own tests build it through Nest without configuration, and
    // only the `auto` resolution below reads a preference.
    @Optional() private readonly configuration?: ConfigurationService,
  ) {}

  /**
   * Health-check every backend once, concurrently.
   *
   * Concurrency is the point. A backend whose URL does not resolve does not fail fast — Node's
   * `getaddrinfo` blocks for the resolver timeout — so probing six of them in sequence costs the
   * sum of their stalls rather than the worst one.
   */
  private async probeBackends(): Promise<ProbedBackends> {
    return Promise.all(
      this.backends.entries().map(
        async ([type, backend]) =>
          [
            type,
            backend,
            // Per backend, because the routing paths below fold into this sweep and each carried its
            // own catch: one throwing backend must be skipped, not fail the whole request.
            await backend.healthCheck().catch(() => ({ running: false, healthy: false, modelsLoaded: [] as string[] })),
          ] as const,
      ),
    );
  }

  /** Get full inference status for MCP / API */
  async getStatus(): Promise<InferenceStatus> {
    const profile = await this.hardwareInspector.getProfile();
    // Side by side, not in sequence: the budget now asks the engines what they hold, which on a
    // node with one stalled backend costs the same probe timeout the health sweep is about to pay.
    const [budget, probed] = await Promise.all([this.memoryManager.calculateBudget(profile), this.probeBackends()]);
    const backends = probed.map(([type, backend, health]) => {
      const unservableModels = this.inBothIdSpaces(health.unservableModels ?? []);
      return {
        type,
        running: health.running,
        healthy: health.healthy,
        url: backend.getBaseUrl(),
        modelsLoaded: health.modelsLoaded.length,
        ...(unservableModels.length > 0 ? { unservableModels } : {}),
      };
    });

    // Build merged model list. Hand it the probe we just did: `listModels` otherwise repeats the
    // whole fan-out, and on a node with one slow backend that doubling is what blows the caller's
    // budget rather than the backend itself.
    const models = await this.listModels(probed);

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

  /**
   * Engine-native model ids plus the catalog ids they map onto, de-duplicated.
   *
   * A backend reports withheld models in its own id space (`gemma3:1b`), while everything built on
   * the catalog — the pool's advertised inventory above all — speaks catalog ids (`gemma3-1b`).
   * Neither consumer carries a lookup table, and the mapping lives here, next to the registry that
   * owns it, so the status carries both and either side can filter with a plain `includes`.
   */
  private inBothIdSpaces(backendModelIds: string[]): string[] {
    if (backendModelIds.length === 0) {
      return [];
    }
    // Exact-id backends (vLLM and friends) fall through the same helper unharmed: its first test is
    // equality, and only the Ollama tag suffixes below that are Ollama-shaped.
    return [...new Set([...backendModelIds, ...resolveInstalledCatalogIds(this.modelRegistry.getCatalog(), backendModelIds)])];
  }

  /**
   * List all available models (local + cloud).
   *
   * `probed` lets a caller that has already health-checked every backend hand the result in.
   * Without it this probes them itself — in parallel, never in sequence.
   */
  async listModels(probed?: ProbedBackends): Promise<InferenceModelInfo[]> {
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

    // Also include curated models not yet tracked (available state). Ollama cloud-proxied tags (e.g.
    // `deepseek-v4-pro:cloud`) are skipped — they don't download or run on this machine, so listing one
    // as `local: true` below would be a lie. The catalog is meant to carry none of these; this is a
    // backstop, matching the same guard in ModelRegistryService#getModelsForTier.
    for (const curated of this.modelRegistry.getCatalog()) {
      if (curated.backend === 'ollama' && curated.backendModelId?.endsWith(':cloud')) continue;
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
    for (const [backendType, , health] of probed ?? (await this.probeBackends())) {
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

  /**
   * The operator's Settings → Inference model, as the engine id, when a healthy backend actually
   * has it. This is the same answer `InferenceEnvResolver` writes into every app's
   * `DEFAULT_MODEL`/`CI_CHAT_MODEL`, so `auto` and "the default this Hub advertises" agree — before
   * this, with nothing pinned, `auto` fell through to whichever model the engine happened to list
   * first (beta-max: apps were told `qwen3.6:27b`, `auto` ran `qwen3.8:27b`). Costs nothing when no
   * preference is set; with one, it needs the same sweep the caller memoizes anyway.
   */
  private async preferredInstalledModel(probe: () => Promise<ProbedBackends>): Promise<string | undefined> {
    const preferredId = this.configuration?.getInferencePreferences().preferredModel;
    if (!preferredId) return undefined;
    const curated = this.modelRegistry.getCuratedModel(preferredId);
    const engineId = curated?.backendModelId ?? preferredId;
    for (const [backendType, , health] of await probe()) {
      if (!health.running || !health.healthy) continue;
      if (curated && curated.backend !== backendType) continue;
      if (health.modelsLoaded.includes(engineId)) return engineId;
    }
    return undefined;
  }

  /** Get default pinned model for chat */
  getDefaultModel(): string | undefined {
    const pinned = this.modelRegistry.getPinnedModels();
    const llmPinned = pinned.find((m) => {
      const curated = this.modelRegistry.getCuratedModel(m.catalogId);
      return curated?.modality === 'llm';
    });
    if (llmPinned) return llmPinned.catalogId;

    const loaded = this.modelRegistry.getLoadedModels();
    const llmLoaded = loaded.find((m) => {
      const curated = this.modelRegistry.getCuratedModel(m.catalogId);
      return curated?.modality === 'llm';
    });
    if (llmLoaded) return llmLoaded.catalogId;

    return undefined;
  }

  /**
   * Resolve 'auto' model by also checking running backends.
   *
   * `probe` is a thunk, not a {@link ProbedBackends} value, so the common answer — a pinned or
   * already-loaded model — still costs no health check at all, while a caller that needs the same
   * sweep afterwards (see {@link routeChatCompletion}) can hand in a memoized one.
   */
  async resolveAutoModel(probe: () => Promise<ProbedBackends> = () => this.probeBackends()): Promise<string | undefined> {
    const preferred = await this.preferredInstalledModel(probe);
    if (preferred) return preferred;

    const defaultModel = this.getDefaultModel();
    if (defaultModel) return defaultModel;

    // One concurrent sweep. Walking the registry with `await` per backend is what made a single
    // unresolvable backend URL cost the sum of every stall rather than the worst one (#1287).
    for (const [, , health] of await probe()) {
      if (!health.running || !health.healthy) continue;
      const chat = health.modelsLoaded.find((id) => this.canChat(id));
      if (chat) return chat;
    }

    return undefined;
  }

  /**
   * Whether an engine model id can serve a chat request. The last-resort `auto` fallback used to
   * take whatever an engine listed first, and on a node with only embeddings ahead of its LLMs that
   * was `nomic-embed-text` — every `auto` chat then failed with "does not support chat" (core-14,
   * beta-red, beta-glass, 2026-09-15). Catalogued ids answer by modality; an uncatalogued id is
   * taken unless its name says it embeds.
   */
  private canChat(engineId: string): boolean {
    const curated = this.modelRegistry.getCatalog().find((m) => m.backendModelId === engineId);
    if (curated) return curated.modality === 'llm';
    return !/embed/i.test(engineId);
  }

  /** Route chat completion request */
  async routeChatCompletion(body: Record<string, unknown>): Promise<{
    data: unknown;
    headers?: Record<string, string>;
    stream?: NodeJS.ReadableStream;
    backend: string;
  }> {
    const requestedModel = (body.model as string) || 'auto';

    // 1. Resolve "auto" to default pinned LLM
    // Memoized: the `auto` resolution and the direct-backend lookup in step 4 want the same sweep,
    // and running it twice per chat request repeats the doubling #1287 took out of `getStatus()` —
    // here on a hotter path. Lazy, so a request answered from the registry alone probes nothing.
    let probed: ProbedBackends | undefined;
    const probeOnce = async (): Promise<ProbedBackends> => (probed ??= await this.probeBackends());

    const resolvedModel = requestedModel === 'auto' ? await this.resolveAutoModel(probeOnce) : requestedModel;

    if (!resolvedModel) {
      // No local model, try cloud
      const provider = this.cloudFallback.getEnabledProviders()[0];
      if (provider) {
        const result = await this.cloudFallback.proxyChatCompletion(provider, { ...body, model: provider.defaultModel });
        return { data: result.data, stream: result.stream, headers: result.headers, backend: `cloud:${provider.provider}` };
      }
      throw new Error('No models available — no local models loaded and no cloud providers configured');
    }

    // 2 + 3. A tracked model: serve it if loaded, else make room and load it. Shared with the pool
    // proxy so an app that calls the engine's native routes gets the same arbitration.
    const prepared = await this.prepareTrackedModel(resolvedModel);
    if (prepared) {
      return this.proxyToBackend(prepared.backend, prepared.backendModelId, body);
    }

    // 4. Check if model is directly available on a local backend (not tracked/curated)
    for (const [backendType, , health] of await probeOnce()) {
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

  /** Route text / FIM completion request (e.g. for editor code completion) */
  async routeCompletion(body: Record<string, unknown>): Promise<{
    data: unknown;
    headers?: Record<string, string>;
    stream?: NodeJS.ReadableStream;
    backend: string;
  }> {
    const requestedModel = (body.model as string) || 'auto';
    let probed: ProbedBackends | undefined;
    const probeOnce = async (): Promise<ProbedBackends> => (probed ??= await this.probeBackends());

    const resolvedModel = requestedModel === 'auto' ? await this.resolveAutoModel(probeOnce) : requestedModel;
    if (!resolvedModel) {
      throw new Error('No models available — no local models loaded and no cloud providers configured');
    }

    const prepared = await this.prepareTrackedModel(resolvedModel);
    if (prepared) {
      return this.proxyToBackend(prepared.backend, prepared.backendModelId, body, '/v1/completions');
    }

    for (const [backendType, , health] of await probeOnce()) {
      if (health.running && health.healthy) {
        const modelNames = health.modelsLoaded;
        if (modelNames.some((m) => m === resolvedModel || m.startsWith(`${resolvedModel}:`))) {
          return this.proxyToBackend(backendType, resolvedModel, body, '/v1/completions');
        }
      }
    }

    // Cloud completion fallback if cloud provider is available
    const provider = this.cloudFallback.resolveProvider(resolvedModel);
    if (provider) {
      const baseUrl = provider.baseUrl || this.cloudFallback.getDefaultBaseUrl(provider.provider);
      const isStream = !!body.stream;
      const response = await axios.post(`${baseUrl}/completions`, body, {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: isStream ? 'stream' : 'json',
        timeout: 120000,
      });
      if (isStream) {
        return { data: null, stream: response.data, headers: response.headers as Record<string, string>, backend: `cloud:${provider.provider}` };
      }
      return { data: response.data, headers: response.headers as Record<string, string>, backend: `cloud:${provider.provider}` };
    }

    throw new Error(`Model ${resolvedModel} not found or not available for completions`);
  }

  /** Route TTS request */
  async routeTts(body: Record<string, unknown>): Promise<{ data: Buffer; backend: string }> {
    const lemonadeBackend = this.backends.tryGet('lemonade');
    if (lemonadeBackend) {
      const lemonadeHealth = await lemonadeBackend.healthCheck().catch(() => ({ running: false, healthy: false }));
      if (lemonadeHealth.running && lemonadeHealth.healthy) {
        try {
          const response = await axios.post(`${lemonadeBackend.getBaseUrl()}/v1/audio/speech`, body, {
            responseType: 'arraybuffer',
            timeout: 60000,
          });
          return { data: Buffer.from(response.data), backend: 'lemonade' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._logger.error(`[Inference] TTS request to Lemonade failed: ${msg}`);
          throw err;
        }
      }
    }

    const provider = this.cloudFallback.getEnabledProviders()[0];
    if (provider) {
      const data = await this.cloudFallback.proxyTts(provider, body);
      return { data, backend: `cloud:${provider.provider}` };
    }

    throw new Error('No TTS backend available');
  }

  /** Route STT request */
  async routeStt(formData: FormData): Promise<{ data: unknown; backend: string }> {
    const lemonadeBackend = this.backends.tryGet('lemonade');
    if (lemonadeBackend) {
      const lemonadeHealth = await lemonadeBackend.healthCheck().catch(() => ({ running: false, healthy: false }));
      if (lemonadeHealth.running && lemonadeHealth.healthy) {
        try {
          const response = await axios.post(`${lemonadeBackend.getBaseUrl()}/v1/audio/transcriptions`, formData, { timeout: 120000 });
          return { data: response.data, backend: 'lemonade' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._logger.error(`[Inference] STT request to Lemonade failed: ${msg}`);
          throw err;
        }
      }
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
    const ollamaBackend = this.backends.tryGet('ollama');
    if (ollamaBackend) {
      const ollamaHealth = await ollamaBackend.healthCheck().catch(() => ({ running: false, healthy: false }));
      if (ollamaHealth.running && ollamaHealth.healthy) {
        try {
          const response = await axios.post(`${ollamaBackend.getBaseUrl()}/v1/embeddings`, body, { timeout: 60000 });
          return { data: response.data, backend: 'ollama' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._logger.error(`[Inference] Embeddings request to Ollama failed: ${msg}`);
          throw err;
        }
      }
    }

    const provider = this.cloudFallback.getEnabledProviders()[0];
    if (provider) {
      const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
      try {
        const response = await axios.post(`${baseUrl}/embeddings`, body, {
          headers: { Authorization: `Bearer ${provider.apiKey}` },
          timeout: 60000,
        });
        return { data: response.data, backend: `cloud:${provider.provider}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._logger.error(`[Inference] Embeddings request to cloud provider ${provider.provider} failed: ${msg}`);
        throw err;
      }
    }

    throw new Error('No embeddings backend available');
  }

  /** Proxy request to a local backend */
  /**
   * Make a Hub-tracked model servable before a request reaches the engine, or say it is not one.
   *
   * `model` may be a catalog id (`qwen3-8-27b-mtp`, what `auto` resolves to) or the engine's own
   * tag (`qwen3.8:27b-mtp-q4_K_M`, what every app's `DEFAULT_MODEL` is). Apps only ever send the
   * latter, which is why this arbitration used to apply to `auto` alone.
   *
   * Order matters. The engine is asked first whether the model is already resident: the registry
   * only knows about loads the Hub itself made, so a model another caller loaded is `pulled` here
   * while occupying the card, and a fit check against the tracked state alone would try to evict
   * something to make room for a model that is already there — measured on a box where the chat
   * model was loaded by the app and the Hub then evicted it for its own copy. Only a model that is
   * genuinely absent goes through the fit check and, if needed, eviction.
   *
   * Null means "not a tracked model, or it does not fit and nothing can be freed"; the caller then
   * falls through to the engine as before. Never throws for a residency probe that fails.
   */
  async prepareTrackedModel(model: string): Promise<{ backend: InferenceBackendType; backendModelId: string } | null> {
    const tracked =
      this.modelRegistry.getTrackedModel(model) ?? this.modelRegistry.getTrackedModels().find((entry) => entry.backendModelId === model);
    if (!tracked) {
      return null;
    }
    const served = { backend: tracked.backend, backendModelId: tracked.backendModelId };
    if (tracked.state === 'loaded' || tracked.state === 'pinned') {
      return served;
    }
    if (tracked.state !== 'pulled') {
      return null;
    }

    const resident = await this.backends
      .get(tracked.backend)
      .isModelLoaded(tracked.backendModelId)
      .catch(() => false);
    if (resident) {
      this.modelRegistry.updateModelState(tracked.catalogId, 'loaded');
      return served;
    }

    const profile = await this.hardwareInspector.getProfile();
    const curated = this.modelRegistry.getCuratedModel(tracked.catalogId);
    const footprint = curated?.runtime.memoryFootprintMb || 0;
    const fit = await this.memoryManager.canFitModel(profile, footprint);
    if (fit.fits) {
      await this.modelPuller.loadModel(tracked.catalogId);
      return served;
    }

    const eviction = this.memoryManager.getModelsToEvict(profile, footprint - fit.availableMb);
    if (eviction.canFree) {
      for (const evictId of eviction.modelsToEvict) {
        await this.modelPuller.unloadModel(evictId);
      }
      await this.modelPuller.loadModel(tracked.catalogId);
      return served;
    }
    return null;
  }

  private async proxyToBackend(
    backendType: InferenceBackendType,
    backendModelId: string,
    body: Record<string, unknown>,
    endpointPath = '/v1/chat/completions',
  ): Promise<{ data: unknown; headers?: Record<string, string>; stream?: NodeJS.ReadableStream; backend: string }> {
    const backend = this.backends.get(backendType);
    const url = `${backend.getBaseUrl()}${endpointPath}`;

    const requestBody: Record<string, unknown> = { ...body, model: backendModelId };

    // Find catalog ID for recording usage
    const allTracked = this.modelRegistry.getTrackedModels();
    const tracked = allTracked.find((m) => m.backendModelId === backendModelId);
    if (tracked) {
      this.modelRegistry.recordUsage(tracked.catalogId);
    }

    const apiKey = backend.getApiKey?.();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    return this.sendToBackend(url, requestBody, backendType, !!body.stream, headers);
  }

  private async sendToBackend(
    url: string,
    requestBody: Record<string, unknown>,
    backendType: InferenceBackendType,
    stream: boolean,
    headers: Record<string, string>,
  ): Promise<{ data: unknown; headers?: Record<string, string>; stream?: NodeJS.ReadableStream; backend: string }> {
    // Dynamic timeout based on estimated prompt tokens, mirroring Hub Pool's firstByteBudgetMs:
    // Minimum 120s, scaling up for large prompts (e.g. 150KB system + tool definitions).
    const bodyBytes = Buffer.byteLength(JSON.stringify(requestBody));
    const dynamicTimeoutMs = Math.max(120_000, Math.ceil(bodyBytes / 4 / 50) * 1000);

    if (stream) {
      const response = await axios.post(url, requestBody, {
        responseType: 'stream',
        timeout: dynamicTimeoutMs,
        headers,
      });
      return { data: null, stream: response.data, backend: backendType };
    }

    const response = await axios.post(url, requestBody, {
      timeout: dynamicTimeoutMs,
      headers,
    });

    return { data: response.data, headers: response.headers as Record<string, string>, backend: backendType };
  }

  /** Get the inference endpoint URL for injection into app environments */
  getInferenceEndpoint(): string {
    const hubContainer = hubContainerName();
    const hubPort = process.env.API_PORT || '3000';
    return `http://${hubContainer}:${hubPort}/api/inference/v1`;
  }
}
