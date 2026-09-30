import { Injectable, forwardRef, Inject, Optional } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { hubContainerName } from '@/common/constants';
import type {
  BackendHealthStatus,
  CuratedModel,
  HardwareProfile,
  InferenceBackendType,
  InferenceModelInfo,
  InferenceStatus,
} from '@ci-hub/common/types';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { appInferenceRequirements, checkModelRequirements } from './app-inference-requirements';
import { handoutContextLength, visionReserveMbFor } from './app-model-handout';
import { kvSequencesFor, probeContextCost } from './context-cost.util';
import { estimateLoadedFootprintMb, FLOOR_CONTEXT, largestFittingWindow, type ModelMemoryInput } from './context-length.util';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { type EvictionCandidate, MemoryManagerService, modelMemoryCeilingMb } from './memory-manager.service';
import { CloudFallbackService, speaksOpenAiCompletions } from './cloud-fallback.service';
import { ModelPullerService } from './model-puller.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { InferenceBackend } from './backends/backend.interface';
import { resolveInstalledCatalogIds } from './model-availability.util';
import { InferenceRouteError, modelNotFound } from './inference-error-reply';
import { firstByteBudgetMs, forwardBudgetMs } from '@/modules/hub-pool/hub-pool-budget';
import { BUDGET_SETTINGS_HINT, postStreamUnderHeaderDeadline } from './upstream-stream';

/** How long {@link InferenceRouterService.loadTrackedModel} waits for evicted memory to show as free: 10 × 1 s. */
const EVICTION_SETTLE_ATTEMPTS = 10;
const EVICTION_SETTLE_INTERVAL_MS = 1_000;

/** One parallel health sweep over every registered backend. */
type ProbedBackends = ReadonlyArray<readonly [InferenceBackendType, InferenceBackend, BackendHealthStatus]>;

/**
 * `Authorization` for a backend that authenticates its requests (its `getApiKey()`: VLLM_API_KEY,
 * OMLX_API_KEY, LEMONADE_API_KEY), or no header at all. The chat/completion proxy and the Lemonade
 * audio routes share it, so a keyed engine is not probed healthy with its key and then sent work
 * without it (Lemonade TTS/STT did exactly that: healthy, then a 401 on every call).
 */
function backendAuthHeaders(backend: InferenceBackend): Record<string, string> {
  const apiKey = backend.getApiKey?.();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

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
    // Optional for the same reason: only a Lemonade load reads it, for installed apps' context floors.
    @Optional() private readonly apps?: AppsRepository,
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

  /**
   * Route chat completion request.
   *
   * `clientClosed` (`abortWhenClientCloses` in `upstream-stream.ts`) rides to whichever upstream
   * serves the request, local engine or cloud provider, so a client that leaves abandons it there
   * too — before the answer or mid-stream — instead of leaving the Hub holding the connection.
   */
  async routeChatCompletion(
    body: Record<string, unknown>,
    clientClosed?: AbortSignal,
  ): Promise<{
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
        const result = await this.cloudFallback.proxyChatCompletion(provider, { ...body, model: provider.defaultModel }, clientClosed);
        return { data: result.data, stream: result.stream, headers: result.headers, backend: `cloud:${provider.provider}` };
      }
      throw new Error('No models available — no local models loaded and no cloud providers configured');
    }

    // 2 + 3. A tracked model: serve it if loaded, else make room and load it. Shared with the pool
    // proxy so an app that calls the engine's native routes gets the same arbitration.
    const prepared = await this.prepareTrackedModel(resolvedModel);
    if (prepared) {
      return this.proxyToBackend(prepared.backend, prepared.backendModelId, body, '/v1/chat/completions', clientClosed);
    }

    // 4. Check if model is directly available on a local backend (not tracked/curated)
    for (const [backendType, , health] of await probeOnce()) {
      if (health.running && health.healthy) {
        const modelNames = health.modelsLoaded;
        if (modelNames.some((m) => m === resolvedModel || m.startsWith(`${resolvedModel}:`))) {
          return this.proxyToBackend(backendType, resolvedModel, body, '/v1/chat/completions', clientClosed);
        }
      }
    }

    // 5. Check if it's a cloud model
    const provider = this.cloudFallback.resolveProvider(resolvedModel);
    if (provider) {
      const result = await this.cloudFallback.proxyChatCompletion(provider, body, clientClosed);
      return { data: result.data, stream: result.stream, headers: result.headers, backend: `cloud:${provider.provider}` };
    }

    throw modelNotFound(`Model ${resolvedModel} not found or not available`);
  }

  /** Route text / FIM completion request (e.g. for editor code completion). `clientClosed` as for chat. */
  async routeCompletion(
    body: Record<string, unknown>,
    clientClosed?: AbortSignal,
  ): Promise<{
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
      return this.proxyToBackend(prepared.backend, prepared.backendModelId, body, '/v1/completions', clientClosed);
    }

    for (const [backendType, , health] of await probeOnce()) {
      if (health.running && health.healthy) {
        const modelNames = health.modelsLoaded;
        if (modelNames.some((m) => m === resolvedModel || m.startsWith(`${resolvedModel}:`))) {
          return this.proxyToBackend(backendType, resolvedModel, body, '/v1/completions', clientClosed);
        }
      }
    }

    // Cloud completion fallback, but only to a provider that has the route. `resolveProvider` sends a
    // `claude-…` model to Anthropic, which speaks its own Messages API and has no `/completions`, so
    // posting there failed every such request as a 502 — refuse it here, with the reason, instead.
    const provider = this.cloudFallback.resolveProvider(resolvedModel);
    if (provider && !speaksOpenAiCompletions(provider.provider)) {
      throw new InferenceRouteError(
        400,
        `Model ${resolvedModel} is not served by a local backend, and the cloud provider it falls back to (${provider.provider}) ` +
          'has no OpenAI-compatible /completions endpoint. Use /v1/chat/completions for this model.',
        'invalid_request_error',
        'unsupported_endpoint',
      );
    }
    if (provider) {
      const url = `${provider.baseUrl || this.cloudFallback.getDefaultBaseUrl(provider.provider)}/completions`;
      const headers = { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' };
      const bodyBytes = Buffer.byteLength(JSON.stringify(body));
      // The same budgets as the cloud chat path and the local engines: a header deadline for a
      // stream, the pool's completion budget for a whole answer.
      if (body.stream) {
        const response = await postStreamUnderHeaderDeadline(
          url,
          body,
          headers,
          {
            budgetMs: firstByteBudgetMs(bodyBytes),
            upstream: `cloud provider ${provider.provider}`,
            hint: ` ${BUDGET_SETTINGS_HINT}`,
          },
          clientClosed,
        );
        return { data: null, stream: response.data, headers: response.headers as Record<string, string>, backend: `cloud:${provider.provider}` };
      }
      const response = await axios.post(url, body, { headers, timeout: forwardBudgetMs(false, bodyBytes), signal: clientClosed });
      return { data: response.data, headers: response.headers as Record<string, string>, backend: `cloud:${provider.provider}` };
    }

    throw modelNotFound(`Model ${resolvedModel} not found or not available for completions`);
  }

  /** Route TTS request */
  async routeTts(body: Record<string, unknown>): Promise<{ data: Buffer; backend: string }> {
    const lemonadeBackend = this.backends.tryGet('lemonade');
    if (lemonadeBackend) {
      const lemonadeHealth = await lemonadeBackend.healthCheck().catch(() => ({ running: false, healthy: false }));
      if (lemonadeHealth.running && lemonadeHealth.healthy) {
        try {
          const response = await axios.post(`${lemonadeBackend.getBaseUrl()}/v1/audio/speech`, body, {
            headers: backendAuthHeaders(lemonadeBackend),
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
          const response = await axios.post(`${lemonadeBackend.getBaseUrl()}/v1/audio/transcriptions`, formData, {
            headers: backendAuthHeaders(lemonadeBackend),
            timeout: 120000,
          });
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
   *
   * `request.numCtx` is the window the request that triggered this runs at: its own `options.num_ctx`
   * on Ollama's native routes, null on `/v1`, where Ollama drops `options` and runs its default. An
   * Ollama load is made at exactly that window (none for null) so the request that follows finds the
   * model as loaded; any other window is reloaded by that very request — measured 2026-09-29, a load
   * at 8192 went to 32768 on the next `/v1` call. The default is the `/v1` answer, which is what the
   * Hub's own `/v1/chat/completions` and `/v1/completions` forward to.
   */
  async prepareTrackedModel(
    model: string,
    request: { numCtx: number | null } = { numCtx: null },
  ): Promise<{ backend: InferenceBackendType; backendModelId: string } | null> {
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

    const outcome = await this.loadTrackedModel(tracked.catalogId, { request });
    return outcome.loaded ? served : null;
  }

  /**
   * Put a catalog model into memory, making room first: the one load path both the pool proxy
   * (through {@link prepareTrackedModel}) and an operator's pin take. The pin used to call the
   * engine's load straight away, with no fit check at all, and that is how a Lemonade 27B went
   * onto a card where Ollama already held one.
   *
   * Asks the engine first (a model another caller loaded is resident without the registry
   * knowing), then fits, then evicts whatever unpinned models the engines hold — the Hub's own
   * loads or not — and re-measures before loading. It never loads on top of a card it could not
   * clear: a load that does not fit is refused with the reason, not attempted.
   *
   * `options.request` marks a load an app's request triggered, with the window that request runs at
   * (see {@link prepareTrackedModel}); without it this is an operator's pin or load, and the Hub
   * picks the window (see {@link planLoad}).
   */
  async loadTrackedModel(
    catalogId: string,
    options: { request?: { numCtx: number | null } } = {},
  ): Promise<{ loaded: true } | { loaded: false; reason: string }> {
    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    const target = tracked ?? curated;
    if (!target) {
      return { loaded: false, reason: `Model ${catalogId} not found in catalog` };
    }
    const backendType = target.backend;
    const backendModelId = target.backendModelId;

    const resident = await this.backends
      .get(backendType)
      .isModelLoaded(backendModelId)
      .catch(() => false);
    if (resident) {
      if (tracked) this.modelRegistry.updateModelState(catalogId, 'loaded');
      else this.modelRegistry.trackModel(catalogId, 'loaded');
      return { loaded: true };
    }

    const profile = await this.hardwareInspector.getProfile();
    const { contextLength, footprintMb: footprint } = await this.planLoad(
      curated,
      { backend: backendType, backendModelId },
      profile,
      options.request,
    );
    const fit = await this.memoryManager.canFitModel(profile, footprint);
    if (!fit.fits) {
      const deficit = footprint - fit.availableMb;
      const plan = await this.memoryManager.planEviction(profile, deficit, { backend: backendType, backendModelId });
      if (!plan.canFree) {
        return {
          loaded: false,
          reason: `${catalogId} needs ${footprint} MB but only ${fit.availableMb} MB is free, and unloading every unpinned model would free ${plan.freedMb} MB`,
        };
      }
      for (const candidate of plan.candidates) {
        await this.evict(candidate);
      }
      if (!(await this.waitForFit(footprint))) {
        return {
          loaded: false,
          reason: `${catalogId} still does not fit after unloading ${plan.candidates.map((c) => c.backendModelId).join(', ')}`,
        };
      }
    }

    await this.modelPuller.loadModel(catalogId, contextLength === null ? undefined : { contextLength });
    return { loaded: true };
  }

  /**
   * The window to load a model at, and what it will then occupy — the figure the fit check and any
   * eviction are sized to. `contextLength` null sends the engine no window.
   *
   * Everything is sized against the budget the fit check itself uses (`modelMemoryCeilingMb`, and
   * `loadHeadroomMb` for what is free now), from the engine's own measurements where it has them:
   * the per-token cost, the slot count it multiplies by, and what the model was last seen occupying
   * here (`MemoryManagerService.footprintSighting`), which replaces the catalog's figure.
   *
   * - **An app's request on Ollama** runs at its own window whatever the Hub loads at, so the load
   *   is made at that window and sized at it: `request.numCtx`, or — on `/v1`, which carries none —
   *   no window at all, sized at the default this node states for the engine (its own statement,
   *   else `inferenceMaxNumCtx`), else at the handout. Stepping the window down would only buy a
   *   reload by the very request that asked.
   * - **Otherwise** (an operator's pin or load, and every Lemonade load, since Lemonade has no
   *   per-request window) the Hub picks: the window it hands its apps for this model, raised on
   *   Lemonade to the floor of any installed app it could be handed to, then stepped down — 65536,
   *   32768, … 4096 — to the largest that fits what is free now. Only when not even 4096 fits does
   *   it size for the largest window an empty card could hold, which is what eviction then frees.
   * - `null` for anything but a text LLM, or a model the catalog does not describe: an embedding,
   *   TTS or STT model has no context window to size.
   */
  private async planLoad(
    curated: CuratedModel | undefined,
    target: { backend: InferenceBackendType; backendModelId: string },
    profile: HardwareProfile,
    request?: { numCtx: number | null },
  ): Promise<{ contextLength: number | null; footprintMb: number }> {
    const catalogFootprint = curated?.runtime.memoryFootprintMb || 0;
    // Lemonade's kokoro and whisper rows carry a 0 window, fell back to 8192, and were charged a
    // phantom 2 GB of KV cache and sent a llama.cpp ctx_size they have no use for.
    if (!curated || curated.modality !== 'llm') {
      return { contextLength: null, footprintMb: catalogFootprint };
    }
    const backend = this.backends.get(target.backend);
    const [cost, sighting, availableMb] = await Promise.all([
      probeContextCost(backend, { ...curated, backendModelId: target.backendModelId }),
      this.memoryManager.footprintSighting(profile, target.backend, target.backendModelId),
      this.memoryManager.loadHeadroomMb(profile),
    ]);
    const sizing: ModelMemoryInput = {
      modelFootprintMb: catalogFootprint,
      kvMbPerToken: cost?.kvMbPerToken ?? null,
      weightMb: cost?.weightMb ?? null,
      visionReserveMb: visionReserveMbFor(curated),
      kvSlots: kvSequencesFor(target.backend, cost, this.statedSlots(target.backend, backend)),
      sighting,
    };
    const ceilingMb = modelMemoryCeilingMb(profile);
    const localCap = this.localContextCap();
    const handout = handoutContextLength({
      model: curated,
      servedLocally: true,
      effectiveInferenceMemoryMb: ceilingMb,
      kvMbPerToken: sizing.kvMbPerToken,
      weightMb: sizing.weightMb,
      kvSlots: sizing.kvSlots,
      sighting,
      maxContextLength: localCap,
    });
    const modelWindow = curated.runtime.contextWindow > 0 ? Math.floor(curated.runtime.contextWindow) : null;

    if (request && target.backend === 'ollama') {
      const runsAt = request.numCtx ?? this.ollamaDefaultWindow(backend) ?? handout;
      const window = modelWindow === null ? runsAt : Math.min(runsAt, modelWindow);
      return { contextLength: request.numCtx, footprintMb: estimateLoadedFootprintMb({ ...sizing, numCtx: window }) };
    }

    const floor = target.backend === 'lemonade' ? await this.installedAppFloor(curated) : null;
    let wanted = floor ? Math.max(handout, floor.minContextLength) : handout;
    if (modelWindow !== null) wanted = Math.min(wanted, modelWindow);
    if (localCap !== null) wanted = Math.min(wanted, localCap);

    let contextLength = largestFittingWindow({ ...sizing, from: wanted, budgetMb: availableMb });
    let footprintMb: number;
    if (contextLength !== null) {
      footprintMb = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
    } else if (!request && sighting && sighting.footprintMb <= availableMb) {
      // What the operator asked for has been measured running on this card in what is free now; only
      // the reserves charged on top of that measurement are over. That is worth a warning, not a refusal.
      contextLength = Math.min(wanted, sighting.contextLength);
      footprintMb = sighting.footprintMb;
      const charged = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
      this._logger.warn(
        `[Inference] ${curated.id} is charged ${charged} MB at a ${contextLength}-token window with its reserves, above the ${availableMb} MB free; ` +
          `loading it anyway, because ${target.backend} was measured serving it here at ${sighting.contextLength} in ${sighting.footprintMb} MB`,
      );
    } else {
      contextLength = largestFittingWindow({ ...sizing, from: wanted, budgetMb: ceilingMb }) ?? Math.min(wanted, FLOOR_CONTEXT);
      footprintMb = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
    }

    if (floor && floor.minContextLength > contextLength) {
      this._logger.warn(
        `[Inference] ${target.backend} will serve ${target.backendModelId} at ctx_size ${contextLength}, below the ${floor.minContextLength}-token floor of ` +
          `${floor.apps.join(', ')}: that is all this node has room for, so apps are handed ${contextLength} for it and may refuse to start. ` +
          'Free memory or choose a smaller model for this node.',
      );
    }
    return { contextLength, footprintMb };
  }

  /**
   * The largest context floor among installed apps `model` could be handed to — an app with a floor
   * whose requirements the model meets — or null when there is none.
   *
   * Lemonade serves one window per model to every caller, so an app that needs 64000 tokens (Hermes)
   * is only served that if the model was loaded at it; a load sized for the handout alone saved 32768
   * while Hermes was told 64000. Every installed app the model qualifies for counts, not only the one
   * handed it right now: the saved window outlives the handout, and the pool can route any of them to
   * it. An app list that cannot be read costs the floor, never the load.
   */
  private async installedAppFloor(model: CuratedModel): Promise<{ minContextLength: number; apps: string[] } | null> {
    if (!this.apps) return null;
    let installed: { appName: string }[];
    try {
      installed = await this.apps.getApps();
    } catch (err) {
      this._logger.debug(`[Inference] Could not read installed apps for their context floors: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    let minContextLength = 0;
    const apps: string[] = [];
    for (const { appName } of installed) {
      const requirements = appInferenceRequirements(appName);
      const appFloor = requirements.minContextLength ?? 0;
      if (appFloor <= 0 || checkModelRequirements(model, requirements).verdict !== 'meets') continue;
      apps.push(appName);
      minContextLength = Math.max(minContextLength, appFloor);
    }
    return apps.length > 0 ? { minContextLength, apps } : null;
  }

  /**
   * How many requests `backend` runs at once, as far as this node knows: the engine's own statement,
   * else — for Ollama, whose `OLLAMA_NUM_PARALLEL` the API does not expose — the operator's
   * `inferenceOllamaSlots`. Null when neither says.
   */
  private statedSlots(backendType: InferenceBackendType, backend: InferenceBackend): number | null {
    const stated = backend.engineCapabilities?.()?.slots ?? null;
    if (stated !== null || backendType !== 'ollama') return stated;
    try {
      return this.configuration?.getInferencePreferences()?.ollamaSlots ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The window Ollama runs a request that names none at: its own statement when it makes one, else
   * this node's `inferenceMaxNumCtx`, which the operator sets to `OLLAMA_CONTEXT_LENGTH` because the
   * API does not expose it. The same reading the pool proxy's `localEngineWindow` makes.
   */
  private ollamaDefaultWindow(backend: InferenceBackend): number | null {
    return clampContextCap(backend.engineCapabilities?.()?.contextLength) ?? this.localContextCap();
  }

  /** This node's `inferenceMaxNumCtx`, as `InferenceEndpointService.localContextCap` reads it. */
  private localContextCap(): number | null {
    try {
      return clampContextCap(this.configuration?.getInferencePreferences()?.maxNumCtx);
    } catch {
      return null;
    }
  }

  /**
   * Unload one eviction candidate. A catalog model goes through the puller so the registry's
   * state follows; anything else is unloaded on its engine directly. A failure is logged and
   * skipped — the re-measure after the whole plan is what decides whether the load goes ahead.
   */
  private async evict(candidate: EvictionCandidate): Promise<void> {
    this._logger.info(`[Inference] Evicting ${candidate.backendModelId} from ${candidate.backend} to make room`);
    try {
      const { catalogId } = candidate;
      if (catalogId && this.modelRegistry.getCuratedModel(catalogId)) {
        await this.modelPuller.unloadModel(catalogId);
      } else {
        await this.backends.get(candidate.backend).unloadModel(candidate.backendModelId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._logger.warn(`[Inference] Could not evict ${candidate.backendModelId} from ${candidate.backend}: ${msg}`);
    }
  }

  /**
   * Re-measure until the model fits or the wait runs out. Engines release memory after the unload
   * call returns (Ollama stops its runner asynchronously), so one immediate reading can still show
   * the model just evicted.
   *
   * Each attempt re-reads the hardware profile with a fresh RAM sample. On unified memory the fit is
   * capped by live MemAvailable, and the profile read before the unload kept that cap at its
   * pre-eviction value however much the unload freed: an eviction that worked was reported as "still
   * does not fit", and the operator's retry then succeeded.
   */
  private async waitForFit(footprintMb: number): Promise<boolean> {
    for (let attempt = 0; attempt < EVICTION_SETTLE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.delay(EVICTION_SETTLE_INTERVAL_MS);
      this.memoryManager.invalidateObservation();
      const profile = await this.hardwareInspector.getProfile({ freshRam: true });
      if ((await this.memoryManager.canFitModel(profile, footprintMb)).fits) return true;
    }
    return false;
  }

  /** Separate so tests can skip the wait. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async proxyToBackend(
    backendType: InferenceBackendType,
    backendModelId: string,
    body: Record<string, unknown>,
    endpointPath = '/v1/chat/completions',
    clientClosed?: AbortSignal,
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...backendAuthHeaders(backend),
    };

    return this.sendToBackend(url, requestBody, backendType, !!body.stream, headers, clientClosed);
  }

  private async sendToBackend(
    url: string,
    requestBody: Record<string, unknown>,
    backendType: InferenceBackendType,
    stream: boolean,
    headers: Record<string, string>,
    clientClosed?: AbortSignal,
  ): Promise<{ data: unknown; headers?: Record<string, string>; stream?: NodeJS.ReadableStream; backend: string }> {
    // The pool's own budgets (`hub-pool-budget.ts`), not a copy of their formula: a request must wait
    // as long on this node whether or not the Hub has peers. A local 120 s floor cut a streamed 19 KB
    // prompt on a CPU-bound node (27–37 tok/s prefill), or any cold load past two minutes, where the
    // pool would have waited 300 s for the very same engine.
    const bodyBytes = Buffer.byteLength(JSON.stringify(requestBody));

    if (stream) {
      // A header deadline, not axios's `timeout`, which would also cut the stream mid-generation;
      // see `postStreamUnderHeaderDeadline`.
      const response = await postStreamUnderHeaderDeadline(
        url,
        requestBody,
        headers,
        {
          budgetMs: firstByteBudgetMs(bodyBytes),
          upstream: backendType,
          hint: ` — it may still be loading the model or reading a long prompt ${BUDGET_SETTINGS_HINT}`,
        },
        clientClosed,
      );
      return { data: null, stream: response.data, backend: backendType };
    }

    // Non-streamed: the engine sends its headers only with the finished completion, so axios's
    // `timeout` here is the whole generation — which is what the pool's completion budget sizes.
    // `clientClosed` here too: an engine that is still generating a whole answer for a client that
    // left holds its sequence slot for nobody until the budget runs out.
    const response = await axios.post(url, requestBody, {
      timeout: forwardBudgetMs(false, bodyBytes),
      headers,
      signal: clientClosed,
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
