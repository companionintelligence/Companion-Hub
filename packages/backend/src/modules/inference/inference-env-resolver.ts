import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { OllamaBackend } from './backends/ollama.backend';
import { CloudFallbackService } from './cloud-fallback.service';
import { InferenceEndpointService } from './inference-endpoint.service';
import { isCatalogModelInstalled, isServedModelForCatalog } from './model-availability.util';
import { appInferenceRequirements, checkModelRequirements, type AppInferenceRequirements } from './app-inference-requirements';
import { describeContextHandout, describeNoSuitableChatModel, handoutContextLength, selectPoolChatModel } from './app-model-handout';
import { appBearerFor } from './engine-credential-scope';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';

/**
 * Standardized AI environment variables injected into an app's `app.env` when
 * that app opts in via `hub_integration.inference`.
 *
 * These follow a `CI_` prefix convention so apps can discover inference
 * capabilities uniformly — regardless of whether the Hub is using a local
 * Ollama instance or a cloud provider.
 */
export interface StandardizedAiEnv {
  /** OpenAI-compatible base URL (Ollama `/v1`, the pool proxy, or a cloud provider). */
  CI_LLM_BASE_URL?: string;
  /**
   * API key for the base URL. The engine's key only when the base URL is that engine; the backend's
   * placeholder (`"ollama"`, `"vllm"`, …) when it is this Hub's proxy or a decode override on
   * another server. See `appBearerFor`.
   */
  CI_LLM_API_KEY?: string;
  /** Default chat/general LLM backend model ID, if available. */
  CI_CHAT_MODEL?: string;
  /** Default embedding model backend ID, if available. */
  CI_EMBEDDING_MODEL?: string;
  /** Default vision-capable LLM backend model ID, if available. */
  CI_VISION_MODEL?: string;
  /** Native Ollama URL (not OpenAI-compatible — for direct Ollama API calls). */
  OLLAMA_HOST?: string;
  /**
   * Native Ollama URL dedicated to embeddings. Unlike OLLAMA_HOST (only set when
   * Ollama is the active chat backend), this is emitted whenever a healthy Ollama
   * is reachable — so apps can run chat on vLLM/Lemonade while keeping their
   * embedding pipeline (and any existing pgvector index) on Ollama.
   */
  CI_OLLAMA_EMBED_HOST?: string;
  /**
   * Hardware-aware default context window (num_ctx) for the chat model, in
   * tokens, as a string. Scaled to the host's memory, capped by the model's
   * window so apps don't inherit Ollama's oversized memory-based default, and
   * capped by the operator's `inferenceMaxNumCtx` — the engine's own context —
   * so an app never asks for a window that reloads the model. Through the pool
   * the cap is the largest among the nodes serving the model, and the proxy
   * places a request only on nodes whose cap can take its window.
   */
  CI_LLM_NUM_CTX?: string;
  /** Active inference backend (`ollama` | `vllm` | `lemonade` | `omlx` | `cloud`). */
  CI_INFERENCE_BACKEND?: string;
  /** Why no chat model was emitted, when the app declares requirements no available model meets. */
  CI_INFERENCE_ERROR?: string;
  /** Every enabled cloud provider (CI_CLOUD_* + conventional aliases). Additive. */
  cloudProviderEnv?: Record<string, string>;
}

export interface InferenceEnvResolveOptions {
  /**
   * The app the env is for. Selects its entry in the requirement table, so a model it would refuse
   * (no tool calling, a window below its floor) is never emitted as `CI_CHAT_MODEL`.
   */
  appSlug?: string | null;
  /**
   * App-specific floor for the recommended context window (tokens). Overrides the table's value
   * when set. Omit for apps with no minimum — the pure hardware ladder is used.
   */
  minContextLength?: number;
}

/**
 * Resolves the standardized `CI_*` AI environment variables that the Hub
 * injects into an app's `app.env` when that app opts in via
 * `hub_integration.inference` and `generateEnvFile`.
 *
 * Resolution order per variable:
 *   1. Hub-wide user preference (settings.json)
 *   2. Hardware-aware recommendation from the model registry
 *   3. Omitted (app must handle the variable being absent gracefully)
 */
@Injectable()
export class InferenceEnvResolver {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly cloudFallback: CloudFallbackService,
    private readonly endpoints: InferenceEndpointService,
  ) {}

  async resolve(options?: InferenceEnvResolveOptions): Promise<StandardizedAiEnv> {
    const requirements = resolveRequirements(options);
    const appLabel = options?.appSlug || 'this app';
    const cloudProviderEnv = this.cloudFallback.toAppEnv();
    const cloudProviders = this.cloudFallback.getEnabledProviders();
    const fallbackCloud = cloudProviders[0];

    const preferences = this.config.getInferencePreferences();
    // Shared with the credentials.env path: resolves an unknown *or* an unavailable
    // `inferenceBackend` preference down to a healthy local Ollama before anyone considers cloud.
    const {
      backendType,
      backend,
      health: backendHealth,
      ready: backendReady,
    } = await this.endpoints.resolveActiveBackend(preferences.preferredBackend, 'InferenceEnvResolver');

    // Multi-Hub pooling: once any peer is connected, the app's requests go through this Hub's pool
    // proxy, so the chat model comes from what the pool serves — see selectPoolChatModel. Decided
    // before the "backend not ready" exit, because a node whose own backend is down but whose
    // peers are healthy used to hand its apps no inference env at all.
    const poolRouting = await this.endpoints.resolvePoolRouting('InferenceEnvResolver');
    const poolChoice = poolRouting?.spansPeers
      ? selectPoolChatModel({
          appSlug: appLabel,
          inventory: poolRouting.inventory,
          catalog: this.modelRegistry.getCatalog() ?? [],
          preferredId: preferences.preferredModel,
          requirements,
        })
      : null;

    // `spansPeers`, not `poolRouting`: with `poolRouteAppsAlways` on and no peer connected the
    // proxy fronts this node's own backends, so a local backend that is down leaves the pool with
    // nothing to serve either — bail exactly as a peerless Hub did before.
    if (!backendReady && !poolChoice?.engineId && (fallbackCloud || !poolRouting?.spansPeers)) {
      if (fallbackCloud) {
        const env: StandardizedAiEnv = {
          CI_INFERENCE_BACKEND: 'cloud',
          cloudProviderEnv,
        };
        if (fallbackCloud.baseUrl) env.CI_LLM_BASE_URL = fallbackCloud.baseUrl;
        if (fallbackCloud.apiKey) env.CI_LLM_API_KEY = fallbackCloud.apiKey;
        if (fallbackCloud.defaultModel) env.CI_CHAT_MODEL = fallbackCloud.defaultModel;
        this.logger.info(
          `[InferenceEnvResolver] ${backendType} unavailable; using cloud ${fallbackCloud.provider} as primary ` +
            `(${cloudProviders.length} provider(s) provisioned)`,
        );
        return env;
      }
      this.logger.warn(`[InferenceEnvResolver] ${backendType} unavailable and no cloud provider configured; omitting AI env.`);
      return {};
    }

    const backendBaseUrl = backend.getBaseUrl();
    const profile = await this.hardwareInspector.getProfile();

    // ── Base URL + API key ────────────────────────────────────────────────
    const decodeOverride = preferences.preferredDecodeEndpoint?.trim();
    const decodeOrigin = decodeOverride?.replace(/\/$/, '').replace(/\/v1$/, '');
    const baseUrl = decodeOrigin ? `${decodeOrigin}/v1` : `${backendBaseUrl}/v1`;
    // The engine's own credential. It goes into the env only if the app ends up talking to the
    // engine directly, which is decided after pool routing below.
    const configuredVllmKey = preferences.preferredVllmApiKey?.trim();
    const engineKey = (backendType === 'vllm' && configuredVllmKey) || backend.getApiKey?.()?.trim();

    // ── Chat model ────────────────────────────────────────────────────────
    let chatCurated: CuratedModel | undefined;
    let chatModel: string | undefined;
    let chatServedLocally = true;
    let chatError: string | undefined;
    if (poolChoice) {
      chatCurated = poolChoice.model ?? undefined;
      chatModel = poolChoice.engineId ?? undefined;
      chatServedLocally = poolChoice.servedLocally;
      chatError = poolChoice.error ?? undefined;
      this.logger.info(
        `[InferenceEnvResolver] ${appLabel}: pool chat=${chatModel ?? 'none'} source=${poolChoice.source} ` +
          `servedBy=${poolChoice.servedBy.join(',') || 'none'}${poolChoice.preferredNote ? ` (${poolChoice.preferredNote})` : ''}`,
      );
    } else {
      const local = this.resolveLocalChatModel(
        backendType,
        backendHealth.modelsLoaded ?? [],
        preferences.preferredModel,
        profile,
        requirements,
        appLabel,
      );
      chatCurated = local.curated;
      chatModel = local.engineId;
      chatError = local.error;
    }

    // ── Embedding model + dedicated embed host ────────────────────────────
    // Embeddings are split-backend capable: chat can run on vLLM/Lemonade while
    // embeddings stay on Ollama (e.g. CI-Server's pgvector index is built on
    // Ollama's 768-dim nomic-embed-text; moving embedders would force a full
    // reindex). Resolve an embedder on the active backend first; when it has
    // none (vLLM ships no embedding rows in the catalog), fall back to a
    // healthy Ollama and expose its host separately as CI_OLLAMA_EMBED_HOST.
    const resolveEmbedding = (type: InferenceBackendType): string | undefined => {
      if (preferences.preferredEmbeddingModel) {
        const curated = this.modelRegistry.getCuratedModel(preferences.preferredEmbeddingModel);
        if (curated?.backend === type) return curated.backendModelId;
      }
      return this.modelRegistry.getRecommendedEmbeddingModel(profile.tier, type, profile)?.backendModelId;
    };

    const encodeOverride = preferences.preferredEncodeEndpoint?.trim();
    const decoderEmbeds = backendType === 'ollama' || backendType === 'omlx';
    let embeddingModel = resolveEmbedding(backendType);
    let embedHost = decoderEmbeds ? backendBaseUrl : undefined;
    if (!decoderEmbeds) {
      const ollamaHealth = await this.ollamaBackend.healthCheck().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[InferenceEnvResolver] ollama (embeddings fallback) health check failed: ${message}`);
        return { running: false, healthy: false, modelsLoaded: [] as string[] };
      });
      if (ollamaHealth.running && ollamaHealth.healthy) {
        embedHost = this.ollamaBackend.getBaseUrl();
        if (!embeddingModel) embeddingModel = resolveEmbedding('ollama');
      }
    }
    if (encodeOverride) {
      embedHost = encodeOverride.replace(/\/$/, '').replace(/\/v1$/, '');
    }

    // ── Vision model ──────────────────────────────────────────────────────
    let visionModel: string | undefined;
    if (preferences.preferredVisionModel) {
      const curated = this.modelRegistry.getCuratedModel(preferences.preferredVisionModel);
      if (curated?.backend === backendType && curated?.metadata?.capabilities?.vision) {
        visionModel = curated.backendModelId;
      }
    }
    if (!visionModel) {
      const recommended = this.modelRegistry.getRecommendedVisionModel(profile.tier, backendType, profile);
      visionModel = recommended?.backendModelId;
    }

    const env: StandardizedAiEnv = {
      CI_LLM_BASE_URL: baseUrl,
      CI_INFERENCE_BACKEND: backendType,
    };
    // OLLAMA_HOST is Ollama's native (non-OpenAI-compatible) protocol URL — only meaningful,
    // and only ever populated, when Ollama is the active backend.
    if (backendType === 'ollama') env.OLLAMA_HOST = backendBaseUrl;
    // The embeddings host, by contrast, points at Ollama whenever one is healthy —
    // even when chat runs on another backend (split-backend embeddings).
    if (embedHost) env.CI_OLLAMA_EMBED_HOST = embedHost;
    if (chatModel) env.CI_CHAT_MODEL = chatModel;
    else if (chatError) env.CI_INFERENCE_ERROR = chatError;
    if (embeddingModel) env.CI_EMBEDDING_MODEL = embeddingModel;
    if (visionModel) env.CI_VISION_MODEL = visionModel;

    // Context window for the chat model, so apps don't inherit Ollama's oversized memory-based
    // default (e.g. 262144 on unified-memory APUs). Sized from this node's memory only when this
    // node serves the model, and capped at what the engine that will serve it runs at; see
    // handoutContextLength.
    if (chatCurated && chatModel) {
      // Ask the engine what a token of context costs THIS model before falling back to the fixed
      // ladder — see `model-geometry.util`. Only Ollama can be asked, and only about a model this
      // node serves: a peer's geometry is not measurable from here, so a pool-served model keeps
      // the heuristic, as do the other backends.
      const askOllama = chatServedLocally && backendType === 'ollama';
      const [cost, residentContextLength] = await Promise.all([
        askOllama ? this.ollamaBackend.contextCostForModel(chatCurated.backendModelId) : null,
        askOllama ? this.ollamaBackend.residentContextLength(chatCurated.backendModelId) : null,
      ]);
      // Through the pool, the largest cap among the nodes serving the model — the proxy places a
      // request only on nodes whose cap can take its window, so no smaller node binds (see
      // `poolContextCap`); this node's own cap on the direct path.
      const localContextCap = this.endpoints.localContextCap();
      const maxContextLength = poolChoice ? poolChoice.contextCap : localContextCap;
      const numCtx = handoutContextLength({
        model: chatCurated,
        servedLocally: chatServedLocally,
        effectiveInferenceMemoryMb: profile.effectiveInferenceMemoryMb,
        minContextLength: requirements.minContextLength,
        kvMbPerToken: cost?.kvMbPerToken ?? null,
        weightMb: cost?.weightMb ?? null,
        maxContextLength,
      });
      env.CI_LLM_NUM_CTX = String(numCtx);
      for (const note of describeContextHandout({
        appSlug: appLabel,
        engineId: chatModel,
        numCtx,
        maxContextLength,
        minContextLength: requirements.minContextLength,
        residentContextLength: residentContextLength ?? null,
        ...(poolChoice && chatServedLocally ? { localContextCap } : {}),
      })) {
        this.logger.warn(`[InferenceEnvResolver] ${note}`);
      }
    }

    if (Object.keys(cloudProviderEnv).length > 0) {
      env.cloudProviderEnv = cloudProviderEnv;
    }

    const routed = this.endpoints.applyPoolRouting(
      { openAiBaseUrl: env.CI_LLM_BASE_URL, ollamaHost: env.OLLAMA_HOST, ollamaEmbedHost: env.CI_OLLAMA_EMBED_HOST },
      poolRouting,
      'InferenceEnvResolver',
    );
    env.CI_LLM_BASE_URL = routed.openAiBaseUrl;
    if (env.OLLAMA_HOST) env.OLLAMA_HOST = routed.ollamaHost;
    if (env.CI_OLLAMA_EMBED_HOST) env.CI_OLLAMA_EMBED_HOST = routed.ollamaEmbedHost;
    // Against the URL the app is actually handed: through the pool proxy, or to a decode override
    // on another server, the engine key would reach a server it does not belong to.
    env.CI_LLM_API_KEY = appBearerFor({ endpointUrl: env.CI_LLM_BASE_URL, backendType, engineUrl: backendBaseUrl, engineKey });

    this.logger.info(
      `[InferenceEnvResolver] backend=${backendType} chat=${chatModel ?? 'none'} embedding=${embeddingModel ?? 'none'} ` +
        `vision=${visionModel ?? 'none'} baseUrl=${env.CI_LLM_BASE_URL} backendReady=${backendReady} pool=${poolRouting !== null} ` +
        `cloudProviders=${cloudProviders.length}${chatError && !chatModel ? ` error="${chatError}"` : ''}`,
    );

    return env;
  }

  /**
   * The chat model when the app talks to this node's backend directly.
   *
   * Prefer a model that is actually present on the active backend: this env is written into an
   * app's app.env with no pre-pull on this path, so naming a merely-recommended (but unpulled) model
   * would 404 on the app's first request. Resolution: preference-if-installed → best installed
   * recommended model → preference, then top recommendation, as a last resort when nothing on this
   * backend is pulled yet. Every step skips a model the app's requirements rule out.
   */
  private resolveLocalChatModel(
    backendType: InferenceBackendType,
    modelsLoaded: string[],
    preferredId: string | null,
    profile: Awaited<ReturnType<HardwareInspectorService['getProfile']>>,
    requirements: AppInferenceRequirements,
    appLabel: string,
  ): { curated?: CuratedModel; engineId?: string; error?: string } {
    const rejected: Array<{ engineId: string; unmet: string[] }> = [];
    const suitable = (model: CuratedModel | undefined): model is CuratedModel => {
      if (!model) return false;
      const check = checkModelRequirements(model, requirements);
      if (check.verdict === 'fails') {
        if (this.isInstalled(model, modelsLoaded) && !rejected.some((r) => r.engineId === model.backendModelId)) {
          rejected.push({ engineId: model.backendModelId, unmet: check.unmet });
        }
        return false;
      }
      return true;
    };

    const preferredCurated = preferredId ? this.modelRegistry.getCuratedModel(preferredId) : undefined;
    const backendPreferredCurated = preferredCurated?.backend === backendType ? preferredCurated : undefined;
    const llmCandidates = this.modelRegistry
      .getRecommendedModelsForHardware(profile.tier, profile)
      .filter((m) => m.modality === 'llm' && m.backend === backendType);

    let chatCurated: CuratedModel | undefined;
    if (backendPreferredCurated && this.isInstalled(backendPreferredCurated, modelsLoaded) && suitable(backendPreferredCurated)) {
      chatCurated = backendPreferredCurated;
    } else {
      chatCurated = llmCandidates.find((m) => this.isInstalled(m, modelsLoaded) && suitable(m));
    }
    if (!chatCurated) {
      chatCurated = [backendPreferredCurated, ...llmCandidates].find((m) => suitable(m));
      if (chatCurated) {
        this.logger.warn(
          `[InferenceEnvResolver] no recommended ${backendType} chat model is pulled yet; ` +
            `emitting ${chatCurated.backendModelId} — apps will 404 until it is pulled.`,
        );
      }
    }
    let engineId = chatCurated?.backendModelId;
    // Host-managed vLLM/Lemonade can serve models outside the Hub catalog (e.g. an
    // operator's existing `vllm serve` on :8000). When nothing catalog-shaped matches
    // but the backend reports loaded models, emit the first runtime id so apps get a
    // working default instead of omitting CI_CHAT_MODEL entirely.
    const runtimeFallback = () => modelsLoaded.find((id) => this.servedModelVerdict(id, backendType, requirements) !== 'fails');
    if (engineId && modelsLoaded.length > 0 && backendType !== 'ollama' && !modelsLoaded.includes(engineId)) {
      const runtimeModel = runtimeFallback();
      if (runtimeModel) {
        this.logger.info(`[InferenceEnvResolver] catalog chat model ${engineId} is not loaded on ${backendType}; using runtime ${runtimeModel}`);
        engineId = runtimeModel;
      }
    } else if (!engineId && modelsLoaded.length > 0 && backendType !== 'ollama') {
      engineId = runtimeFallback();
      if (engineId) this.logger.info(`[InferenceEnvResolver] no catalog ${backendType} chat model matched runtime; using ${engineId}`);
    }

    if (!engineId && rejected.length > 0) {
      return { error: describeNoSuitableChatModel({ appSlug: appLabel, requirements, rejected, scope: 'local' }) };
    }
    return { curated: chatCurated, engineId };
  }

  /** The catalog's verdict on a host-served engine id, or `unverified` when no catalog row matches it. */
  private servedModelVerdict(engineId: string, backendType: InferenceBackendType, requirements: AppInferenceRequirements) {
    const row = (this.modelRegistry.getCatalog() ?? []).find(
      (m) => m.backend === backendType && m.modality === 'llm' && isServedModelForCatalog(m, [engineId]),
    );
    return checkModelRequirements(row ?? null, requirements).verdict;
  }

  /** True when the model is on disk on the active backend or tracked as pulled/loaded/pinned in the registry. */
  private isInstalled(model: CuratedModel, modelsLoaded: string[]): boolean {
    const tracked = this.modelRegistry.getTrackedModel(model.id);
    const trackedPulled = tracked?.state === 'pulled' || tracked?.state === 'loaded' || tracked?.state === 'pinned';
    if (model.backend === 'vllm' || model.backend === 'omlx') {
      return trackedPulled || isServedModelForCatalog(model, modelsLoaded);
    }
    return isCatalogModelInstalled(model, modelsLoaded, trackedPulled, this.modelRegistry.getCatalogBackendModelIds());
  }
}

/** The table's requirements for `appSlug`, with an explicit `minContextLength` taking precedence. */
function resolveRequirements(options: InferenceEnvResolveOptions | undefined): AppInferenceRequirements {
  const fromTable = appInferenceRequirements(options?.appSlug);
  if (options?.minContextLength === undefined) {
    return fromTable;
  }
  return { ...fromTable, minContextLength: options.minContextLength };
}
