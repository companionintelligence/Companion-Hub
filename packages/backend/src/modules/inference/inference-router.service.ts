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
  TrackedModel,
} from '@ci-hub/common/types';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
import { sameModelId } from '@/common/helpers/hub-pool';
import { handoutContextLength, visionReserveMbFor } from './app-model-handout';
import { probeContextCost } from './context-cost.util';
import { estimateLoadedFootprintMb } from './context-length.util';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { type EvictionCandidate, type EvictionPlan, type EvictionScope, MemoryManagerService } from './memory-manager.service';
import { CloudFallbackService, speaksOpenAiCompletions } from './cloud-fallback.service';
import { ModelPullerService } from './model-puller.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { InferenceBackend } from './backends/backend.interface';
import { isCatalogModelInstalled, isServedModelForCatalog, resolveInstalledCatalogIds } from './model-availability.util';
import { InferenceRouteError, modelNotFound } from './inference-error-reply';
import { firstByteBudgetMs, forwardBudgetMs } from '@/modules/hub-pool/hub-pool-budget';
import { HubPoolLoadService } from '@/modules/hub-pool/hub-pool-load.service';
import { BUDGET_SETTINGS_HINT, postStreamUnderHeaderDeadline } from './upstream-stream';

/** How long {@link InferenceRouterService.loadTrackedModel} waits for evicted memory to show as free: 10 × 1 s. */
const EVICTION_SETTLE_ATTEMPTS = 10;
const EVICTION_SETTLE_INTERVAL_MS = 1_000;

/**
 * Engines that settle their own memory before a load: asked to load a model that does not fit
 * beside what they hold, they unload one of their own runners and wait for it to go, and a runner
 * still busy with a request is waited out, not loaded on top of. Ollama's scheduler does that
 * (`server/sched.go` `processPending`: `findRunnerToUnload`, then it blocks on `unloadedCh`).
 *
 * It is what makes a load safe after an eviction whose memory has not come back yet, and only
 * when the evicted model and the one being loaded are on the same such engine. Nothing arbitrates
 * between two engines: an Ollama runner that is finishing a request the Hub cannot see (an app
 * calling the engine directly) keeps its memory, and a Lemonade load beside it overcommits the
 * card. That is the freeze #1679 set out to fix. Lemonade is not listed: it evicts by count
 * (`max_loaded_models`), never for memory, so its own loads never wait for room.
 */
const SELF_ARBITRATING_BACKENDS: ReadonlySet<InferenceBackendType> = new Set<InferenceBackendType>(['ollama']);

/** What {@link InferenceRouterService.loadTrackedModel} did: the model is in memory, or why it is not. */
export type LoadOutcome = { loaded: true } | { loaded: false; reason: string };

/** Who asked for a load, and whether they are still waiting for it. */
export type LoadOptions = {
  /** What may be unloaded to make room; see {@link EvictionScope}. `request` when unset. */
  scope?: EvictionScope;
  /**
   * The client's hang-up (the pool proxy's `clientClosed`). Checked once this load's turn in the
   * per-node queue comes: a request abandoned while it waited behind another model's cold load
   * must not go on to evict and load for nobody.
   */
  signal?: AbortSignal;
};

/** A refusal that says what the plan could free and why no more: who asked, and what was busy. */
function describeRefusal(catalogId: string, footprintMb: number, availableMb: number, scope: EvictionScope, plan: EvictionPlan): string {
  const evictable = scope === 'operator' ? 'every idle unpinned model' : 'every idle model the Hub loaded itself';
  const busy =
    plan.busy.length > 0 ? `; ${plan.busy.join(', ')} ${plan.busy.length === 1 ? 'is' : 'are'} serving a request and will not be unloaded` : '';
  return `${catalogId} needs ${footprintMb} MB but only ${availableMb} MB is free, and unloading ${evictable} would free ${plan.freedMb} MB${busy}`;
}

/** A model {@link InferenceRouterService.loadTrackedModel} may load: what the registry and catalog know of it, and where it runs. */
type LoadTarget = {
  tracked: TrackedModel | undefined;
  curated: CuratedModel | undefined;
  backendType: InferenceBackendType;
  backendModelId: string;
};

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
  /** The tail of {@link loadTrackedModel}'s queue: every load on this node waits for the one before it. */
  private loadQueue: Promise<void> = Promise.resolve();

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
    // The pool's record of what this node's engines are working on right now (turns and embedding
    // batches), so a load never evicts a model mid-request. forwardRef: InferenceModule and
    // HubPoolModule import each other.
    // Optional for the same reason as `configuration`; without it nothing reads as busy.
    @Optional() @Inject(forwardRef(() => HubPoolLoadService)) private readonly poolLoad?: HubPoolLoadService,
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
    const prepared = await this.prepareTrackedModel(resolvedModel, { signal: clientClosed });
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

    const prepared = await this.prepareTrackedModel(resolvedModel, { signal: clientClosed });
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
   */
  async prepareTrackedModel(
    model: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ backend: InferenceBackendType; backendModelId: string } | null> {
    // Folded like every other engine-id comparison on this path: an app may send `nomic-embed-text`
    // or `nomic-embed-text:latest` for the one model.
    const tracked =
      this.modelRegistry.getTrackedModel(model) ?? this.modelRegistry.getTrackedModels().find((entry) => sameModelId(entry.backendModelId, model));
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

    const outcome = await this.loadTrackedModel(tracked.catalogId, { scope: 'request', signal: options.signal });
    return outcome.loaded ? served : null;
  }

  /**
   * Put a catalog model into memory, making room first: the one load path the pool proxy (through
   * {@link prepareTrackedModel}), an operator's pin or load, and MCP `hub_load_model` all take. The
   * pin used to call the engine's load straight away, with no fit check at all, and that is how a
   * Lemonade 27B went onto a card where Ollama already held one.
   *
   * Asks the engine first (a model another caller loaded is resident without the registry
   * knowing), then refuses a model that is not downloaded here, then fits. When the model does not
   * fit, `scope` decides what may be unloaded for it (see {@link EvictionScope}); a model with a
   * request in flight through the pool (a turn or an embedding batch) is never unloaded. Then:
   *
   * - The plan cannot make room: refused with the reason, and nothing has been unloaded.
   * - The plan can: its models are unloaded, and this one is loaded once the re-measure shows the
   *   room. When the re-measure has not caught up by the end of the settle wait, the load still goes
   *   ahead only where the engine itself will wait for the memory: every evicted model is on the
   *   target's own engine and that engine arbitrates its own memory ({@link SELF_ARBITRATING_BACKENDS}).
   *   There, stopping would not undo the unloads — on the request path the pool forwards the request
   *   anyway and the engine loads the model on its own terms — so a refusal would only add the cold
   *   reload of what was just evicted. Anywhere else the memory may still be held by work the Hub
   *   cannot see, and the load is refused rather than landing on top of it, as #1679 itself did.
   *   An unload the engine refused stops the plan at once: the rest would be lost for nothing.
   *
   * Serialized per node: fit, eviction and load run under one lock, so two loads cannot both plan
   * against the same free memory, and a second load of the same model finds it resident instead of
   * loading it again. A model that is already resident is answered before the lock: that check is
   * one engine call, and a request for it must not queue behind another model's cold load, which
   * takes up to two minutes.
   */
  async loadTrackedModel(catalogId: string, options: LoadOptions = {}): Promise<LoadOutcome> {
    const target = this.loadTarget(catalogId);
    if (!target) {
      return { loaded: false, reason: `Model ${catalogId} not found in catalog` };
    }
    if (await this.adoptIfResident(catalogId, target)) {
      return { loaded: true };
    }
    return this.withLoadLock(async () => {
      if (options.signal?.aborted) {
        return { loaded: false, reason: `The request for ${catalogId} was abandoned while it waited for another load to finish` };
      }
      return this.loadTrackedModelLocked(catalogId, options.scope ?? 'request');
    });
  }

  /** The registry's view of `catalogId` and where it is served, or `undefined` when neither the registry nor the catalog knows it. */
  private loadTarget(catalogId: string): LoadTarget | undefined {
    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    const served = tracked ?? curated;
    return served ? { tracked, curated, backendType: served.backend, backendModelId: served.backendModelId } : undefined;
  }

  /**
   * Whether the engine already holds the model, recording it as loaded when it does: another caller
   * may have loaded it without the registry knowing. A probe that fails reads as not resident.
   */
  private async adoptIfResident(catalogId: string, target: LoadTarget): Promise<boolean> {
    const resident = await this.backends
      .get(target.backendType)
      .isModelLoaded(target.backendModelId)
      .catch(() => false);
    if (!resident) {
      return false;
    }
    if (target.tracked) this.modelRegistry.updateModelState(catalogId, 'loaded');
    else this.modelRegistry.trackModel(catalogId, 'loaded');
    return true;
  }

  private async loadTrackedModelLocked(catalogId: string, scope: EvictionScope): Promise<LoadOutcome> {
    // Read again under the lock: the load this one queued behind may have loaded or evicted it.
    const target = this.loadTarget(catalogId);
    if (!target) {
      return { loaded: false, reason: `Model ${catalogId} not found in catalog` };
    }
    const { tracked, curated, backendType, backendModelId } = target;
    const backend = this.backends.get(backendType);

    if (await this.adoptIfResident(catalogId, target)) {
      return { loaded: true };
    }

    // Before anything is unloaded for it: a model that was never downloaded here can only fail to
    // load, and it used to do so after the eviction, as a 500, with the other apps' models gone.
    if (!(await this.isDownloaded(tracked, curated, backend))) {
      return { loaded: false, reason: `${catalogId} is not downloaded on this node; pull it first` };
    }

    const profile = await this.hardwareInspector.getProfile();
    const { contextLength, footprintMb: footprint } = await this.planLoad(curated, { backend: backendType, backendModelId }, profile);
    const fit = await this.memoryManager.canFitModel(profile, footprint);
    if (!fit.fits) {
      const deficit = footprint - fit.availableMb;
      const plan = await this.memoryManager.planEviction(
        profile,
        deficit,
        { backend: backendType, backendModelId },
        { scope, inUse: (engine) => this.poolLoad?.localBusyModelsOn(engine) ?? [] },
      );
      if (!plan.canFree) {
        return { loaded: false, reason: describeRefusal(catalogId, footprint, fit.availableMb, scope, plan) };
      }
      const evicted: EvictionCandidate[] = [];
      let refused: EvictionCandidate | null = null;
      for (const candidate of plan.candidates) {
        if (!(await this.evict(candidate))) {
          refused = candidate;
          break;
        }
        evicted.push(candidate);
      }
      if (refused && evicted.length === 0) {
        // Nothing was freed, so there is nothing to wait for.
        return { loaded: false, reason: `${catalogId} does not fit: ${refused.backend} refused to unload ${refused.backendModelId}` };
      }
      if (!(await this.waitForFit(footprint))) {
        const unloaded = evicted.map((c) => c.backendModelId).join(', ');
        if (refused) {
          return {
            loaded: false,
            reason: `${catalogId} still does not fit after unloading ${unloaded}: ${refused.backend} refused to unload ${refused.backendModelId}`,
          };
        }
        const arbitrated = SELF_ARBITRATING_BACKENDS.has(backendType) && evicted.every((c) => c.backend === backendType);
        if (!arbitrated) {
          return {
            loaded: false,
            reason:
              `${catalogId} still does not fit after unloading ${unloaded}: that memory has not come back, and ${unloaded} ` +
              `may still be finishing work the Hub cannot see, so loading on ${backendType} now could land on top of it`,
          };
        }
        this._logger.warn(
          `[Inference] Loading ${catalogId} although the memory freed by unloading ${unloaded} has not shown up yet; ${backendType} waits for it itself`,
        );
      }
    }

    try {
      await this.modelPuller.loadModel(catalogId, contextLength === null ? undefined : { contextLength });
      return { loaded: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { loaded: false, reason: `Loading ${catalogId} failed: ${msg}` };
    } finally {
      // The next plan must see this model's memory, not the 5 s-old reading from before it loaded.
      this.memoryManager.invalidateObservation();
    }
  }

  /**
   * Whether `catalogId`'s weights are on this node. The registry knows what the Hub pulled; the
   * engine's own inventory knows the rest (a model pulled with `ollama pull`, or before this Hub
   * process started).
   */
  private async isDownloaded(tracked: TrackedModel | undefined, curated: CuratedModel | undefined, backend: InferenceBackend): Promise<boolean> {
    if (tracked && (tracked.state === 'pulled' || tracked.state === 'loaded' || tracked.state === 'pinned')) {
      return true;
    }
    if (!curated) {
      return false;
    }
    const health = await backend.healthCheck().catch(() => null);
    const inventory = health?.modelsLoaded ?? [];
    return curated.backend === 'ollama'
      ? isCatalogModelInstalled(curated, inventory, false, this.modelRegistry.getCatalogBackendModelIds())
      : isServedModelForCatalog(curated, inventory);
  }

  /** Runs `fn` after every load already queued on this node has finished, whatever its outcome. */
  private withLoadLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.loadQueue.then(fn);
    this.loadQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The window to load a model at and what it will then occupy. The window is the one the Hub
   * hands its apps as `CI_LLM_NUM_CTX` for this model (`handoutContextLength`, same inputs, same
   * operator cap) minus any one app's floor: on Ollama a load at any other window is reloaded by
   * the apps' first native request, and on Lemonade, which takes no window per request, it is the
   * window every app gets. `null` for an embedding model, or one the catalog does not describe.
   */
  private async planLoad(
    curated: CuratedModel | undefined,
    target: { backend: InferenceBackendType; backendModelId: string },
    profile: HardwareProfile,
  ): Promise<{ contextLength: number | null; footprintMb: number }> {
    const catalogFootprint = curated?.runtime.memoryFootprintMb || 0;
    if (!curated || curated.modality === 'embedding') {
      return { contextLength: null, footprintMb: catalogFootprint };
    }
    const backend = this.backends.get(target.backend);
    const cost = await probeContextCost(backend, { ...curated, backendModelId: target.backendModelId });
    const contextLength = handoutContextLength({
      model: curated,
      servedLocally: true,
      effectiveInferenceMemoryMb: profile.effectiveInferenceMemoryMb,
      kvMbPerToken: cost?.kvMbPerToken ?? null,
      weightMb: cost?.weightMb ?? null,
      maxContextLength: this.localContextCap(),
    });
    const footprintMb = estimateLoadedFootprintMb({
      modelFootprintMb: catalogFootprint,
      numCtx: contextLength,
      kvMbPerToken: cost?.kvMbPerToken ?? null,
      weightMb: cost?.weightMb ?? null,
      visionReserveMb: visionReserveMbFor(curated),
    });
    return { contextLength, footprintMb };
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
   * reported, not thrown: the caller stops the plan there and lets the re-measure decide.
   */
  private async evict(candidate: EvictionCandidate): Promise<boolean> {
    this._logger.info(`[Inference] Evicting ${candidate.backendModelId} from ${candidate.backend} to make room`);
    try {
      const { catalogId } = candidate;
      if (catalogId && this.modelRegistry.getCuratedModel(catalogId)) {
        await this.modelPuller.unloadModel(catalogId);
      } else {
        await this.backends.get(candidate.backend).unloadModel(candidate.backendModelId);
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._logger.warn(`[Inference] Could not evict ${candidate.backendModelId} from ${candidate.backend}: ${msg}`);
      return false;
    }
  }

  /**
   * Re-measure until the model fits or the wait runs out. Engines release memory after the unload
   * call returns (Ollama stops its runner asynchronously), so one immediate reading can still show
   * the model just evicted.
   *
   * Both halves of the measurement are read again on every attempt: the engines' figures, and the
   * hardware profile with a MemAvailable sampled now. On a unified-memory node the fit is capped by
   * MemAvailable, so re-using the profile read before the unload capped it at the pre-eviction
   * figure, and an eviction that had worked was reported as a refusal (FIT-2 in the #1679 audit).
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
