import { Injectable, forwardRef, Inject, type OnApplicationBootstrap, Optional } from '@nestjs/common';
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
import { inventoryListsModel, sameModelId } from '@/common/helpers/hub-pool';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { appInferenceRequirements, checkModelRequirements } from './app-inference-requirements';
import { handoutContextLength, visionReserveMbFor } from './app-model-handout';
import { kvSequencesFor, probeContextCost } from './context-cost.util';
import { estimateLoadedFootprintMb, FLOOR_CONTEXT, largestFittingWindow, type ModelMemoryInput } from './context-length.util';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import {
  type EvictionCandidate,
  type EvictionOptions,
  type EvictionPlan,
  type EvictionScope,
  MemoryManagerService,
  modelMemoryCeilingMb,
  modelPoolFor,
} from './memory-manager.service';
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
export type LoadOutcome =
  | { loaded: true }
  | {
      loaded: false;
      reason: string;
      /** Set when only generations in progress stood in the way: the load would have been made once they end (see {@link EvictionPlan.idleWouldFree}). */
      idleWouldFree?: true;
    };

/**
 * Who asked for a load. The one field decides both what the load may do: the window it is loaded at
 * ({@link InferenceRouterService.planLoad}) and what may be unloaded to make room for it
 * ({@link EvictionScope}, through {@link evictionScopeOf}). They used to be two options with opposite
 * defaults — a bare call planned its window as an operator's load and evicted as an app's request —
 * so the pin, which made a bare call, sized its window for an eviction it was then not allowed.
 *
 * - `operator`: a signed-in operator — the REST pin and load, or a run from the Hub UI's MCP tool
 *   runner. The Hub picks the window. Any idle unpinned model may be unloaded, including one an app
 *   loaded, and a model never measured here may be tried on a discrete card
 *   ({@link InferenceRouterService.loadUnmeasured}).
 * - `agent`: an MCP call on an API key (`hub_load_model`, `hub_pin_model`). The Hub picks the window,
 *   as for an operator: nothing about the call says what window it will run at. Only the Hub's own
 *   idle loads may be unloaded, as on the request path, and nothing is tried unmeasured, since Ollama
 *   would make that room itself among runners apps loaded.
 * - `request`: an app's generation reaching the pool proxy or the router. It runs at its own window
 *   (`numCtx`: its `options.num_ctx` on Ollama's native routes, null on `/v1`), so an Ollama load is
 *   made at that window. Only the Hub's own idle loads may be unloaded.
 */
export type LoadOrigin = 'operator' | 'agent' | 'request';

/** Who asked for a load (see {@link LoadOrigin}), and whether they are still waiting for it. */
export type LoadOptions = ({ origin: 'operator' | 'agent' } | { origin: 'request'; numCtx: number | null }) & {
  /**
   * The client's hang-up (the pool proxy's `clientClosed`). Checked once this load's turn in the
   * per-node queue comes: a request abandoned while it waited behind another model's cold load
   * must not go on to evict and load for nobody.
   */
  signal?: AbortSignal;
};

/** What a load from `origin` may unload: only a signed-in operator may clear a model an app loaded. */
export function evictionScopeOf(origin: LoadOrigin): EvictionScope {
  return origin === 'operator' ? 'operator' : 'request';
}

/** What a load with `scope` may unload, in the words a refusal or a warning uses. */
function evictableBy(scope: EvictionScope): string {
  return scope === 'operator' ? 'every idle unpinned model' : 'every idle model the Hub loaded itself';
}

/** The models a plan left alone because a request is running on them, as a clause, or nothing. */
function busyClause(busy: readonly string[]): string {
  return busy.length > 0 ? `; ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} serving a request and will not be unloaded` : '';
}

/** A refusal that says what the plan could free and why no more: who asked, and what was busy. */
function describeRefusal(catalogId: string, footprintMb: number, availableMb: number, scope: EvictionScope, plan: EvictionPlan): string {
  return `${catalogId} needs ${footprintMb} MB but only ${availableMb} MB is free, and unloading ${evictableBy(scope)} would free ${plan.freedMb} MB${busyClause(plan.busy)}`;
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

/** The window {@link InferenceRouterService.planLoad} chose for a load, and what the load then occupies. */
type LoadPlan = {
  contextLength: number | null;
  footprintMb: number;
  /**
   * Set when the window is below an installed app's floor only because what holds the card now could
   * not be unloaded for this load (a `held` {@link FloorShortfall}): it is for this residency, and an
   * engine that saves a model's window (Lemonade) must not replace a larger saved one with it. See
   * `LoadModelOptions.provisionalWindow`.
   */
  provisionalWindow?: true;
  /**
   * Set when the load is to be tried rather than fit-checked (see {@link InferenceRouterService.loadUnmeasured}):
   * an operator's Ollama load of a model never measured on this node, which only the catalog's figure
   * says no empty card here could hold. `ceilingMb` is what an empty card here holds. Never set for a
   * request's or an agent's load (see {@link LoadOrigin}).
   */
  unmeasured?: { ceilingMb: number };
};

/**
 * Why memory put a Lemonade load's window below an installed app's floor: not even an empty card here
 * holds the floor (`empty`, with the most it holds, or null for not even 4096), or an empty card would
 * but unloading what may be unloaded would not free enough of what is in use (`held`). `null` where
 * memory is not the reason: this node's `inferenceMaxNumCtx` caps the window below the floor.
 */
type FloorShortfall =
  | { kind: 'empty'; window: number | null }
  | { kind: 'held'; heldMb: number; freedMb: number; scope: EvictionScope; busy: string[] };

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

/** Why a Lemonade window is below an app's floor, for `planLoad`'s warning; see {@link FloorShortfall}. */
function describeFloorShortfall(shortfall: FloorShortfall | null, wanted: number, floor: number, localCap: number | null): string {
  if (shortfall?.kind === 'empty') {
    return shortfall.window === null
      ? 'not even an empty card here holds this model at 4096 tokens, so unloading other models cannot help; choose a smaller model for this node'
      : `an empty card here holds at most ${shortfall.window} tokens of it, so unloading other models cannot help; choose a smaller model for this node`;
  }
  if (shortfall?.kind === 'held') {
    // An app's request may not clear what an operator may: say so, or the advice reads as if nothing could.
    const remedy =
      shortfall.scope === 'operator'
        ? 'unpin or unload what holds the rest, then load this model again'
        : "an operator's load of this model may unload the models apps loaded; unload this model and load it again from the Hub";
    return (
      `an empty card here would hold the floor, but of the ${shortfall.heldMb} MB in use, unloading ${evictableBy(shortfall.scope)} ` +
      `would free ${shortfall.freedMb} MB${busyClause(shortfall.busy)}; ${remedy}`
    );
  }
  return wanted < floor && localCap !== null && localCap === wanted
    ? `this node's inferenceMaxNumCtx caps it at ${localCap}; raise the cap to serve the floor`
    : `the model's own window is ${wanted}`;
}

/**
 * Inference router — unified routing view over local backends + multi-node pool + cloud fallback.
 */
@Injectable()
export class InferenceRouterService implements OnApplicationBootstrap {
  /** The tail of {@link loadTrackedModel}'s queue: every load on this node waits for the one before it. */
  private loadQueue: Promise<void> = Promise.resolve();
  /** Whether {@link warnSlotsUnstated} has spoken yet. */
  private warnedSlotsUnstated = false;

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
    // Optional for the same reason: only a Lemonade load reads it, for installed apps' context floors.
    @Optional() private readonly apps?: AppsRepository,
  ) {}

  /**
   * Finds the pinned models the engines still hold, in the background: boot must not wait on an
   * engine probe, which costs up to 5 s for one that is not up yet.
   */
  onApplicationBootstrap(): void {
    void this.readoptPinnedModels().catch((err) => {
      this._logger.warn(`[Inference] Could not re-mark the pinned models after a restart: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Re-marks as pinned each model the operator pinned (persisted by the registry) that an engine still
   * holds, and returns the ones it found.
   *
   * A Hub restart leaves the engines as they were: Ollama keeps a pinned model at `keep_alive: -1`, so
   * it is still in memory, but the new Hub process tracks nothing, and until it did the model was an
   * eviction candidate for the next operator load (PIN-2 in the audit of #1679). Only what is resident
   * is tracked here; a pinned model an engine no longer holds (the engine restarted too) keeps its pin,
   * and is tracked pinned whenever this Hub next tracks it: a pull check, or a load through the Hub.
   */
  async readoptPinnedModels(): Promise<string[]> {
    const readopted: string[] = [];
    for (const catalogId of this.modelRegistry.getPinnedCatalogIds()) {
      const tracked = this.modelRegistry.getTrackedModel(catalogId);
      if (tracked?.state === 'pinned') continue;
      const target = this.loadTarget(catalogId);
      if (!target) continue;
      if (await this.adoptIfResident(catalogId, target)) readopted.push(catalogId);
    }
    if (readopted.length > 0) {
      this._logger.info(`[Inference] Still resident after the restart, and pinned again: ${readopted.join(', ')}`);
    }
    return readopted;
  }

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

  /**
   * Route an embeddings request to the engine that serves its model: a tracked model's own engine
   * (loaded if needed, through the same arbitration as a chat turn), else any healthy engine that
   * lists it. A request naming no model, or one nothing local lists, goes to a healthy Ollama as it
   * always did, then to cloud. Until 2026-09-30 every embeddings request went to Ollama whenever
   * Ollama was healthy, whatever its model: an app handed Lemonade's `nomic-embed-text-v1.5-GGUF`
   * (see `embeddingBackendFor`) on a host that also ran Ollama was told "model not found" by the
   * one engine that never had it.
   */
  async routeEmbeddings(body: Record<string, unknown>, clientClosed?: AbortSignal): Promise<{ data: unknown; backend: string }> {
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    if (requestedModel) {
      const prepared = await this.prepareTrackedModel(requestedModel, { signal: clientClosed });
      if (prepared) {
        return this.proxyToBackend(prepared.backend, prepared.backendModelId, body, '/v1/embeddings', clientClosed);
      }
      for (const [backendType, , health] of await this.probeBackends()) {
        if (health.running && health.healthy && inventoryListsModel(health.modelsLoaded, requestedModel)) {
          return this.proxyToBackend(backendType, requestedModel, body, '/v1/embeddings', clientClosed);
        }
      }
    }

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
   * `options.numCtx` is the window the request that triggered this runs at: its own `options.num_ctx`
   * on Ollama's native routes, null on `/v1`, where Ollama drops `options` and runs its default. An
   * Ollama load is made at exactly that window (none for null) so the request that follows finds the
   * model as loaded; any other window is reloaded by that very request — measured 2026-09-29, a load
   * at 8192 went to 32768 on the next `/v1` call. The default is the `/v1` answer, which is what the
   * Hub's own `/v1/chat/completions` and `/v1/completions` forward to. `options.signal` is the
   * client's hang-up; see {@link LoadOptions}.
   *
   * Always a `request` load (see {@link LoadOrigin}): only the Hub's own idle loads may be unloaded
   * for it, never a model an app loaded or one serving a request.
   */
  async prepareTrackedModel(
    model: string,
    options: { numCtx?: number | null; signal?: AbortSignal } = {},
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

    const outcome = await this.loadTrackedModel(tracked.catalogId, { origin: 'request', numCtx: options.numCtx ?? null, signal: options.signal });
    return outcome.loaded ? served : null;
  }

  /**
   * Put a catalog model into memory, making room first: the one load path the pool proxy (through
   * {@link prepareTrackedModel}), an operator's pin or load, and MCP `hub_load_model` all take. The
   * pin used to call the engine's load straight away, with no fit check at all, and that is how a
   * Lemonade 27B went onto a card where Ollama already held one.
   *
   * `options.origin` says who asked, and decides both the window the model is loaded at (see
   * {@link planLoad}) and what may be unloaded for it (see {@link LoadOrigin}). It has no default:
   * the two halves once read a bare call in opposite ways.
   *
   * Asks the engine first (a model another caller loaded is resident without the registry
   * knowing), then refuses a model that is not downloaded here, then fits. When the model does not
   * fit, the origin's {@link EvictionScope} decides what may be unloaded for it; a model with a
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
   * Serialized per node: fit, eviction and load — and an unmeasured trial load with the measurement
   * that follows it — run under one lock, so two loads cannot both plan against the same free memory,
   * and a second load of the same model finds it resident instead of loading it again. A model that
   * is already resident is answered before the lock: that check is one engine call, and a request for
   * it must not queue behind another model's cold load, which takes up to two minutes.
   */
  async loadTrackedModel(catalogId: string, options: LoadOptions): Promise<LoadOutcome> {
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
      return this.loadTrackedModelLocked(catalogId, options);
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
   *
   * The registry records `loaded` as `pinned` for a model the operator pinned
   * (`ModelRegistryService.updateModelState`). A request queued behind the pin of this very model
   * adopts it once the pin has run, and a REST load of a pinned model that is already in memory lands
   * here too: both used to show the model unpinned while it stayed pinned. The registry is read again
   * after the probe, which the pin may have finished during.
   */
  private async adoptIfResident(catalogId: string, target: LoadTarget): Promise<boolean> {
    const resident = await this.backends
      .get(target.backendType)
      .isModelLoaded(target.backendModelId)
      .catch(() => false);
    if (!resident) {
      return false;
    }
    if (this.modelRegistry.getTrackedModel(catalogId)) this.modelRegistry.updateModelState(catalogId, 'loaded');
    else this.modelRegistry.trackModel(catalogId, 'loaded');
    return true;
  }

  private async loadTrackedModelLocked(catalogId: string, options: LoadOptions): Promise<LoadOutcome> {
    const scope = evictionScopeOf(options.origin);
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

    // Here, after the not-downloaded refusal and under the lock: an unmeasured trial is a load like
    // any other, and the measurement taken after it must not race another load on this node.
    const profile = await this.hardwareInspector.getProfile();
    const plan = await this.planLoad(curated, { backend: backendType, backendModelId }, profile, options);
    const { contextLength, footprintMb: footprint } = plan;
    if (plan.unmeasured) {
      return this.loadUnmeasured(catalogId, { backend: backendType, backendModelId }, plan, plan.unmeasured.ceilingMb);
    }
    const fit = await this.memoryManager.canFitModel(profile, footprint);
    if (!fit.fits) {
      const deficit = footprint - fit.availableMb;
      const plan = await this.memoryManager.planEviction(profile, deficit, { backend: backendType, backendModelId }, this.evictionOptions(scope));
      if (!plan.canFree) {
        return {
          loaded: false,
          reason: describeRefusal(catalogId, footprint, fit.availableMb, scope, plan),
          ...(plan.idleWouldFree ? { idleWouldFree: true as const } : {}),
        };
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
      await this.modelPuller.loadModel(
        catalogId,
        contextLength === null ? undefined : { contextLength, ...(plan.provisionalWindow ? { provisionalWindow: true } : {}) },
      );
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

  /**
   * What a load with `scope` may unload, and what the pool has in flight on each engine right now,
   * which it may not. {@link planLoad}'s floor decision asks with exactly these, so it keeps a
   * Lemonade window at an app's floor only when the eviction the load then makes can pay for it.
   */
  private evictionOptions(scope: EvictionScope): EvictionOptions {
    return { scope, inUse: (engine) => this.poolLoad?.localBusyModelsOn(engine) ?? [] };
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
   * An operator's load of a model this node has never measured, which only the catalog's figure says
   * no empty card here could hold: tried, not refused, and measured as it lands.
   *
   * The catalog's figure is a guess where the engine has never been seen serving the model, and for
   * some models a poor one. It puts gemma4:e4b at 10,813 MB and its file is 9,163 MiB, while beta-red's
   * RTX 3080 serves it in 5,550 MiB (nvidia-smi) and `/api/ps` says 3.2 GiB across the fleet. Refusing
   * on it turned the fleet's default app model away from every 8 and 10 GB card the first time an
   * operator asked, and after every Hub restart until sightings were persisted.
   *
   * Only Ollama on a discrete card gets here ({@link planLoad} says when): its scheduler places a model
   * itself, making room among its own idle runners and putting in system RAM what the card cannot take,
   * so a catalog figure that was right costs speed, not a failed load or an overcommitted card. On
   * unified memory there is no system RAM to spill to that the OS is not already using, so the catalog
   * figure still refuses there. Nothing is evicted for it by the Hub: eviction is sized from the
   * estimate, and this estimate is the one thing not trusted. What the engine then holds is measured at
   * once, so the next fit check, pin and handout use it.
   *
   * Only an `operator` load is tried (see {@link LoadOrigin}): Ollama makes the room among its own idle
   * runners, including ones an app loaded, which is what an operator may unload and a request or an
   * agent may not. Called from {@link loadTrackedModelLocked}, so under the per-node lock and after the
   * not-downloaded refusal: the trial and the measurement after it cannot race another load.
   */
  private async loadUnmeasured(
    catalogId: string,
    target: { backend: InferenceBackendType; backendModelId: string },
    plan: LoadPlan,
    ceilingMb: number,
  ): Promise<LoadOutcome> {
    const window = plan.contextLength === null ? 'its default window' : `a ${plan.contextLength}-token window`;
    this._logger.warn(
      `[Inference] ${catalogId} has never been measured on this node, and its catalog figure (${plan.footprintMb} MB at ${window}) is more than ` +
        `an empty card here holds (${ceilingMb} MB); loading it without unloading anything, so ${target.backend} places it itself, and measuring what it takes`,
    );
    try {
      await this.modelPuller.loadModel(catalogId, plan.contextLength === null ? undefined : { contextLength: plan.contextLength });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { loaded: false, reason: `Loading ${catalogId}, which was never measured on this node, failed: ${msg}` };
    } finally {
      // Measured now, not from the reading taken before the load; a failed load may have left part of
      // the model behind, which the next plan must see too.
      this.memoryManager.invalidateObservation();
    }
    const profile = await this.hardwareInspector.getProfile();
    const measured = await this.memoryManager.footprintSighting(profile, target.backend, target.backendModelId).catch(() => null);
    if (measured) {
      this._logger.info(
        `[Inference] ${catalogId} measured on ${target.backend}: ${measured.footprintMb} MB at a ${measured.contextLength}-token window`,
      );
    } else {
      this._logger.warn(
        `[Inference] ${catalogId} is loaded, but could not be measured wholly on the card: ${target.backend} may have put part of it in system memory, ` +
          'where it runs slower. Its catalog figure still stands for the next fit check.',
      );
    }
    return { loaded: true };
  }

  /**
   * Pin a catalog model: load it the way {@link loadTrackedModel} does when it is not in memory, then
   * mark it pinned when the pinned models still fit this node's budget. The REST pin (`operator`) and
   * MCP `hub_pin_model` (`operator` from the Hub UI's tool runner, else `agent`) both take this path;
   * the origin decides the load's window and what it may unload, as for any load (see {@link LoadOrigin}).
   * An operator's pin can therefore still clear an idle model an app loaded; an agent's cannot.
   *
   * The pinned-sum check reads what the model was measured occupying here, and the catalog's figure
   * only for a model never measured here. A refusal on a measurement is final and loads nothing. A
   * refusal on the catalog's figure alone is not: the load measures the model, and the check is asked
   * again with that. The catalog's 10,813 MB for gemma4:e4b refused the pin outright on the 8 and
   * 10 GB cards that serve it in 5,550 MiB.
   *
   * The whole pin runs under the per-node load lock, not only its load. Between a load and the pin
   * that follows it the model is an idle Hub load, which is exactly what a queued request's load may
   * evict: without the lock a pin could load its model, lose it to the next load in the queue, and
   * then mark pinned a model that is no longer in memory.
   */
  async pinTrackedModel(catalogId: string, options: { origin: 'operator' | 'agent' }): Promise<{ pinned: true } | { pinned: false; reason: string }> {
    return this.withLoadLock(async () => {
      const curated = this.modelRegistry.getCuratedModel(catalogId);
      const served = this.modelRegistry.getTrackedModel(catalogId) ?? curated;
      const model = served ? { backend: served.backend, backendModelId: served.backendModelId } : undefined;
      const catalogMb = curated?.runtime.memoryFootprintMb || 0;

      const profile = await this.hardwareInspector.getProfile();
      const first = await this.memoryManager.canPinModel(profile, catalogMb, model);
      if (!first.canPin) {
        const measured = model ? await this.memoryManager.footprintSighting(profile, model.backend, model.backendModelId) : null;
        if (measured || !model) {
          return { pinned: false, reason: first.reason ?? `${catalogId} does not fit this node's pinned-model budget` };
        }
      }

      const tracked = this.modelRegistry.getTrackedModel(catalogId);
      if (!tracked || (tracked.state !== 'loaded' && tracked.state !== 'pinned')) {
        // The locked half of loadTrackedModel: this pin already holds the lock.
        const outcome = await this.loadTrackedModelLocked(catalogId, { origin: options.origin });
        if (!outcome.loaded) {
          return { pinned: false, reason: outcome.reason };
        }
      }

      if (!first.canPin) {
        this.memoryManager.invalidateObservation();
        const again = await this.memoryManager.canPinModel(await this.hardwareInspector.getProfile(), catalogMb, model);
        if (!again.canPin) {
          return { pinned: false, reason: `${catalogId} is loaded, but not pinned: ${again.reason}` };
        }
      }

      this.modelRegistry.pinModel(catalogId);
      return { pinned: true };
    });
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
   * - **An app's request on Ollama** (`origin: 'request'`) runs at its own window whatever the Hub
   *   loads at, so the load is made at that window and sized at it: `numCtx`, or — on `/v1`, which
   *   carries none — no window at all, sized at the default this node states for the engine (its own
   *   statement, else `inferenceMaxNumCtx`), else at the handout. Stepping the window down would only
   *   buy a reload by the very request that asked.
   * - **Otherwise** (an operator's or an agent's pin or load, and every Lemonade load, since Lemonade
   *   has no per-request window) the Hub picks: the window it hands its apps for this model, raised on
   *   Lemonade to the floor of any installed app it could be handed to, then stepped down — 65536,
   *   32768, … 4096 — to the largest that fits what is free now. Only when not even 4096 fits does
   *   it size for the largest window an empty card could hold, which is what eviction then frees.
   * - **A Lemonade floor** is not stepped under for memory that eviction can free. Lemonade serves
   *   the one window it loaded at to every app, so a window sized to what was free beside an idle
   *   Ollama model was saved below Hermes' 64000 on a card that holds 64000 when empty, and Hermes
   *   then refused to start. When the floor fits an empty card but not what is free now, the load is
   *   sized at the floor and eviction makes the room. What eviction can make is asked of the same
   *   plan, with the same scope and in-flight work, that the load path then executes: a request's
   *   load may unload only the Hub's own idle loads, so beside an idle model an app loaded it goes
   *   below the floor rather than keep one it could not pay for. It goes below the floor only when an
   *   empty card cannot hold it, or when what holds the card now cannot be unloaded for this load,
   *   and says which.
   * - **Never measured, and over an empty card by the catalog alone**: an operator's Ollama load onto
   *   a discrete card is tried instead of refused (`unmeasured`; see {@link loadUnmeasured}).
   * - `null` for anything but a text LLM, or a model the catalog does not describe: an embedding,
   *   TTS or STT model has no context window to size.
   */
  private async planLoad(
    curated: CuratedModel | undefined,
    target: { backend: InferenceBackendType; backendModelId: string },
    profile: HardwareProfile,
    options: LoadOptions,
  ): Promise<LoadPlan> {
    const request = options.origin === 'request' ? { numCtx: options.numCtx } : null;
    const scope = evictionScopeOf(options.origin);
    const catalogFootprint = curated?.runtime.memoryFootprintMb || 0;
    // Lemonade's kokoro and whisper rows carry a 0 window, fell back to 8192, and were charged a
    // phantom 2 GB of KV cache and sent a llama.cpp ctx_size they have no use for.
    if (curated?.modality !== 'llm') {
      return { contextLength: null, footprintMb: catalogFootprint };
    }
    const backend = this.backends.get(target.backend);
    const [cost, sighting, availableMb] = await Promise.all([
      probeContextCost(backend, { ...curated, backendModelId: target.backendModelId }),
      this.memoryManager.footprintSighting(profile, target.backend, target.backendModelId),
      this.memoryManager.loadHeadroomMb(profile),
    ]);
    const slots = this.statedSlots(target.backend, backend);
    this.warnSlotsUnstated(target.backend, slots, profile);
    const sizing: ModelMemoryInput = {
      modelFootprintMb: catalogFootprint,
      kvMbPerToken: cost?.kvMbPerToken ?? null,
      weightMb: cost?.weightMb ?? null,
      visionReserveMb: visionReserveMbFor(curated),
      kvSlots: kvSequencesFor(target.backend, cost, slots),
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
      const stated = request.numCtx ?? this.ollamaDefaultWindow(backend);
      if (stated === null) {
        this._logger.debug(
          `[Inference] ${curated.id} is fit-checked at its ${handout}-token handout: a /v1 request runs at OLLAMA_CONTEXT_LENGTH, which ` +
            'this node does not state. Set inferenceMaxNumCtx to it so the fit check sizes the window Ollama actually loads.',
        );
      }
      const runsAt = stated ?? handout;
      const window = modelWindow === null ? runsAt : Math.min(runsAt, modelWindow);
      return { contextLength: request.numCtx, footprintMb: estimateLoadedFootprintMb({ ...sizing, numCtx: window }) };
    }

    const floor = target.backend === 'lemonade' ? await this.installedAppFloor(curated) : null;
    let wanted = floor ? Math.max(handout, floor.minContextLength) : handout;
    if (modelWindow !== null) wanted = Math.min(wanted, modelWindow);
    if (localCap !== null) wanted = Math.min(wanted, localCap);

    const fitsNow = largestFittingWindow({ ...sizing, from: wanted, budgetMb: availableMb });
    let shortfall: FloorShortfall | null = null;
    if (floor) {
      // The floor as far as the caps let it go; below them nothing memory does can help.
      const floorWindow = Math.min(floor.minContextLength, wanted);
      if (fitsNow === null || fitsNow < floorWindow) {
        const emptyFit = largestFittingWindow({ ...sizing, from: floorWindow, budgetMb: ceilingMb });
        if (emptyFit === floorWindow) {
          const footprintMb = estimateLoadedFootprintMb({ ...sizing, numCtx: floorWindow });
          // Asked of the eviction plan the load path then follows — this load's own scope and what
          // the pool has in flight — so the floor is kept exactly when that path can make room for it.
          // What it may unload is its rule, not this one's.
          const eviction = await this.memoryManager.planEviction(profile, footprintMb - availableMb, target, this.evictionOptions(scope));
          if (eviction.canFree) {
            return { contextLength: floorWindow, footprintMb };
          }
          shortfall = { kind: 'held', heldMb: Math.max(0, ceilingMb - availableMb), freedMb: eviction.freedMb, scope, busy: eviction.busy };
        } else {
          shortfall = { kind: 'empty', window: emptyFit };
        }
      }
    }

    let contextLength = fitsNow;
    let footprintMb: number;
    let unmeasured: LoadPlan['unmeasured'];
    if (contextLength !== null) {
      footprintMb = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
    } else if (!request && sighting && sighting.footprintMb <= availableMb) {
      // What an operator or agent asked for has been measured running on this card in what is free
      // now; only the reserves charged on top of that measurement are over. That is worth a warning,
      // not a refusal, and it unloads nothing.
      contextLength = Math.min(wanted, sighting.contextLength);
      footprintMb = sighting.footprintMb;
      const charged = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
      this._logger.warn(
        `[Inference] ${curated.id} is charged ${charged} MB at a ${contextLength}-token window with its reserves, above the ${availableMb} MB free; ` +
          `loading it anyway, because ${target.backend} was measured serving it here at ${sighting.contextLength} in ${sighting.footprintMb} MB`,
      );
    } else {
      const emptyFit = largestFittingWindow({ ...sizing, from: wanted, budgetMb: ceilingMb });
      contextLength = emptyFit ?? Math.min(wanted, FLOOR_CONTEXT);
      footprintMb = estimateLoadedFootprintMb({ ...sizing, numCtx: contextLength });
      if (emptyFit === null && options.origin === 'operator' && !sighting && this.mayTryUnmeasured(target, profile)) {
        unmeasured = { ceilingMb };
      }
    }

    // Below the floor for want of memory this load may not free is a state of the card now, not of the
    // model, so the window is for this residency only. Saved, it outlived the shortfall: every later load
    // Lemonade made by itself, and every handout capped at the saved window, stayed below Hermes' floor
    // after the memory came back, until an operator reloaded the model.
    const provisionalWindow = floor !== null && floor.minContextLength > contextLength && shortfall?.kind === 'held';
    if (floor && floor.minContextLength > contextLength) {
      this._logger.warn(
        `[Inference] ${target.backend} will serve ${target.backendModelId} at ctx_size ${contextLength}, below the ${floor.minContextLength}-token floor of ` +
          `${floor.apps.join(', ')}: ${describeFloorShortfall(shortfall, wanted, floor.minContextLength, localCap)}. ` +
          `Apps are handed ${contextLength} for it and may refuse to start` +
          (provisionalWindow ? '; a larger window Lemonade already has saved for it is kept for its next load.' : '.'),
      );
    }
    return {
      contextLength,
      footprintMb,
      ...(unmeasured ? { unmeasured } : {}),
      ...(provisionalWindow ? { provisionalWindow: true as const } : {}),
    };
  }

  /**
   * Whether an operator's load of a model never measured here, which the catalog's figure alone says no
   * empty card here holds, may be tried instead of refused (see {@link loadUnmeasured}).
   *
   * - Ollama only: it puts what the card cannot take in system RAM rather than failing. Lemonade loads
   *   the whole model onto the card.
   * - A discrete card only: on unified memory the ceiling is what is free now, not an empty machine, and
   *   a spill would come out of the memory the OS itself runs in.
   * - Not while the Hub holds a pin on that engine: Ollama makes room among its own runners and knows
   *   nothing of the Hub's pins, so a guess that was right could unload a model the operator pinned.
   *   Every persisted pin counts, tracked or not: after a Hub restart the engine can still hold a
   *   pinned model this process has not re-marked yet (see {@link readoptPinnedModels}).
   */
  private mayTryUnmeasured(target: { backend: InferenceBackendType }, profile: HardwareProfile): boolean {
    if (target.backend !== 'ollama' || modelPoolFor(profile) !== 'vram') return false;
    const registry = this.modelRegistry;
    return !registry
      .getPinnedCatalogIds()
      .some((catalogId) => (registry.getTrackedModel(catalogId) ?? registry.getCuratedModel(catalogId))?.backend === target.backend);
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
   * Says, once per process, that an Ollama load on a discrete card is being sized for one slot because
   * nothing states more. The API does not expose `OLLAMA_NUM_PARALLEL` and the Hub cannot read the daemon's
   * environment from its container, so the only source is `inferenceOllamaSlots` — which a Hub reset
   * discards while the daemon's drop-in survives. beta-red ran four slots unstated (retest 2026-10-01): its
   * Hub sized one, admitted qwen3:8b at 16384, and Ollama allocated four times the KV cache and put 6.3 GB
   * of the model on the CPU.
   */
  private warnSlotsUnstated(backendType: InferenceBackendType, slots: number | null, profile: HardwareProfile): void {
    if (this.warnedSlotsUnstated || backendType !== 'ollama' || slots !== null || modelPoolFor(profile) !== 'vram') return;
    this.warnedSlotsUnstated = true;
    this._logger.warn(
      '[Inference] No Ollama slot count is stated for this node, so context windows are sized for one slot. If its daemon runs ' +
        'OLLAMA_NUM_PARALLEL above 1, the KV cache is that many times larger and a model sized this way spills to the CPU: ' +
        'state it with `cihub pool slots <n>` (or `PATCH /api/user-settings {"inferenceOllamaSlots": <n>}`).',
    );
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
