import { BadRequestException, Injectable, NotFoundException, type OnApplicationShutdown, Optional } from '@nestjs/common';
import { probeLocalSizing } from './context-cost.util';
import { MemoryManagerService, modelMemoryCeilingMb } from './memory-manager.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaBackend } from './backends/ollama.backend';
import { InferenceEndpointService } from './inference-endpoint.service';
import type { CuratedModel, HardwareProfile, HardwareTier, InferenceBackendType } from '@ci-hub/common/types';
import { isCatalogModelInstalled, isServedModelForCatalog } from './model-availability.util';
import { appBearerFor } from './engine-credential-scope';
import { cloudProviderManagedKeys } from './cloud-provider-env';
import { appInferenceRequirements, checkModelRequirements, type AppInferenceRequirements } from './app-inference-requirements';
import {
  capHandoutAtServedWindow,
  decideModelPrePull,
  describeContextHandout,
  describeNoSuitableChatModel,
  handoutContextLength,
  INFERENCE_ERROR_ENV_KEY,
  nodesServing,
  selectPoolChatModel,
  type PrePullDecision,
} from './app-model-handout';
import { handoutRecord, readHandoutRecords, writeHandoutRecords, type RecordedHandout } from './app-handout-record';
import { embedderEngineId, embeddingBackendFor, pickEmbeddingModel } from './embedder-handout';

// Only Hub-managed sibling apps use the bootstrap credentials endpoints.
// Standalone services (for example companion-memory / CI-Server) receive
// inference config through their own app env wiring instead.
export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw', 'ci-mentra'] as const;
export type AppSlug = (typeof SUPPORTED_APP_SLUGS)[number];

export const SUPPORTED_API_VERSIONS = [1] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];
export const DEFAULT_API_VERSION: ApiVersion = 1;

export interface AppCredentialsConfig {
  app: AppSlug;
  apiVersion: ApiVersion;
  /** Where the app should send inference requests directly (Ollama /v1, the pool proxy, or a cloud provider). */
  endpointUrl: string;
  endpointReady: boolean;
  /** Chat model id the app should request. Native backend id for Ollama, provider model for cloud. */
  chatModelId: string | null;
  /** Embeddings model id (native backend id for Ollama). */
  embeddingsModelId: string | null;
  /** True once the chat model can be served: pulled into the local backend, or listed by a pool node. */
  chatModelReady: boolean;
  /** Which connection the app was handed: the active local backend, or a cloud provider. */
  provider: InferenceBackendType | 'cloud';
  /** True when `endpointUrl` is this Hub's pool proxy, so the model was chosen from what the pool serves. */
  routedThroughPool: boolean;
  /** Pool nodes that serve `chatModelId`; empty when the app is not routed through the pool. */
  chatModelServedBy: string[];
  /** Why no chat model was handed out, when none was. Also sent as `CI_INFERENCE_ERROR`. */
  chatModelError: string | null;
  /** Every pull this handout considered, with the reason it did or did not start one. */
  prePull: PrePullDecision[];
  env: Record<string, string>;
  managedKeys: string[];
}

const APP_ENV_KEYS: Record<AppSlug, { baseUrl: string; model: string; embeddings: string; apiKey: string; numCtx: string }> = {
  'hermes-agent': {
    baseUrl: 'HERMES_OPENAI_BASE_URL',
    model: 'HERMES_DEFAULT_MODEL',
    embeddings: 'HERMES_EMBEDDINGS_MODEL',
    apiKey: 'HERMES_OPENAI_API_KEY',
    numCtx: 'HERMES_NUM_CTX',
  },
  openclaw: {
    baseUrl: 'OPENAI_API_BASE',
    model: 'DEFAULT_MODEL',
    embeddings: 'EMBEDDINGS_MODEL',
    apiKey: 'OPENAI_API_KEY',
    numCtx: 'CI_LLM_NUM_CTX',
  },
  // CI-Mentra smart-glasses bridge: reads the LLM_* names from its bootstrap.env.
  'ci-mentra': {
    baseUrl: 'LLM_API_BASE',
    model: 'LLM_DEFAULT_CHAT_MODEL',
    embeddings: 'LLM_DEFAULT_EMBEDDING_MODEL',
    apiKey: 'LLM_API_KEY',
    numCtx: 'LLM_NUM_CTX',
  },
};

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  config: AppCredentialsConfig;
  expiresAt: number;
}

export type { RecordedHandout } from './app-handout-record';

/**
 * Distributes inference connection info ("credentials") to sibling apps so they
 * can talk to inference *directly* — never through the Hub.
 *
 * By default an app is pointed at the local Ollama container's OpenAI-compatible
 * `/v1` endpoint with the recommended model's native backend id. If the operator
 * has enabled a cloud provider, the connection is overridden with that provider's
 * base URL / API key / default model instead. Either way the Hub only hands out
 * the endpoint + key; it does not proxy requests.
 */
/**
 * Backends whose models are served by a process the operator runs, not pulled into a Hub-managed
 * registry: vLLM and oMLX. For these, "is this model installed?" can only be answered from what
 * the server reports it is serving, so catalog matching goes through `isServedModelForCatalog`
 * rather than the Ollama-style pulled-tag comparison.
 */
function isHostServedBackend(backendType: InferenceBackendType): boolean {
  return backendType === 'vllm' || backendType === 'omlx';
}

interface LocalChatSelection {
  model: CuratedModel | null;
  /** Installed models the app's requirements excluded. */
  rejected: Array<{ engineId: string; unmet: string[] }>;
}

@Injectable()
export class AppCredentialsService implements OnApplicationShutdown {
  /** In-memory credentials cache keyed by `${slug}:${apiVersion}`. */
  private cache = new Map<string, CacheEntry>();
  /** What each app was last actually served, mirrored to disk; see {@link RecordedHandout}. */
  private handouts = new Map<AppSlug, RecordedHandout>();
  private handoutsLoaded: Promise<void> | null = null;
  private handoutWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly configurationService: ConfigurationService,
    private readonly endpoints: InferenceEndpointService,
    // Optional and last, as in InferenceEnvResolver: it only contributes what a model was measured
    // occupying here (see `probeLocalSizing`), and a service built without it sizes from the catalog.
    @Optional() private readonly memoryManager?: MemoryManagerService,
  ) {}

  isSupported(slug: string): slug is AppSlug {
    return (SUPPORTED_APP_SLUGS as readonly string[]).includes(slug);
  }

  /**
   * Parse and validate the ?v= query param.
   * Throws BadRequestException for unknown versions so clients fail fast
   * when an older Hub is paired with a newer sibling app or vice-versa.
   */
  parseApiVersion(raw: string | string[] | undefined): ApiVersion {
    if (raw === undefined || raw === '') {
      return DEFAULT_API_VERSION;
    }
    const candidate = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    if (candidate === '') {
      return DEFAULT_API_VERSION;
    }
    const parsed = Number.parseInt(candidate, 10);
    if (!Number.isInteger(parsed) || !(SUPPORTED_API_VERSIONS as readonly number[]).includes(parsed)) {
      throw new BadRequestException(`Unsupported credentials API version: ${candidate}. Supported: ${SUPPORTED_API_VERSIONS.join(', ')}`);
    }
    return parsed as ApiVersion;
  }

  /** Serve an app its credentials: cached for 30 s, recorded as that app's current handout, and the only path that may start a pre-pull. */
  async getCredentials(slug: string, apiVersion: ApiVersion = DEFAULT_API_VERSION): Promise<AppCredentialsConfig> {
    if (!this.isSupported(slug)) {
      throw new NotFoundException(`Unknown app slug: ${slug}. Supported: ${SUPPORTED_APP_SLUGS.join(', ')}`);
    }

    const cacheKey = `${slug}:${apiVersion}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.logger.info(`[AppCredentials] cache hit slug=${slug} v=${apiVersion} ttl=${Math.round((cached.expiresAt - now) / 1000)}s`);
      this.recordHandout(slug, cached.config, now);
      return cached.config;
    }

    const config = await this.resolveCredentials(slug, apiVersion);
    for (const decision of config.prePull) {
      this.logger.info(
        `[AppCredentials] pre-pull decision slug=${slug} ${decision.kind}=${decision.catalogId} pull=${decision.pull}: ${decision.reason}`,
      );
      if (decision.pull) {
        void this.maybeFirePrePull(decision.catalogId);
      }
    }

    this.cache.set(cacheKey, { config, expiresAt: now + CACHE_TTL_MS });
    this.recordHandout(slug, config, now);
    return config;
  }

  /**
   * What {@link getCredentials} would hand `slug` right now, with none of its side effects: no
   * cache read or write, no pre-pull, and no handout record. The staleness check compares this
   * against {@link lastHandout}, and a check must never be the thing that starts a download.
   */
  async previewCredentials(slug: string, apiVersion: ApiVersion = DEFAULT_API_VERSION): Promise<AppCredentialsConfig> {
    if (!this.isSupported(slug)) {
      throw new NotFoundException(`Unknown app slug: ${slug}. Supported: ${SUPPORTED_APP_SLUGS.join(', ')}`);
    }
    return this.resolveCredentials(slug, apiVersion);
  }

  /** The handout `slug` last received from this Hub, including before its last restart, or null when there is no record. */
  async lastHandout(slug: string): Promise<RecordedHandout | null> {
    if (!this.isSupported(slug)) {
      return null;
    }
    await this.loadPersistedHandouts();
    return this.handouts.get(slug) ?? null;
  }

  /** Let a pending record reach the disk, so an app that fetched just before shutdown is not read as stale after it. */
  async onApplicationShutdown(): Promise<void> {
    await this.handoutWrites;
  }

  private recordHandout(slug: AppSlug, config: AppCredentialsConfig, now: number): void {
    this.handouts.set(slug, handoutRecord(config, new Date(now).toISOString()));
    // Chained so writes land in order, and loaded first so the first fetch after a restart does not
    // overwrite the other app's persisted record with a file holding only its own.
    this.handoutWrites = this.handoutWrites
      .then(async () => {
        await this.loadPersistedHandouts();
        await writeHandoutRecords(Object.fromEntries(this.handouts));
      })
      .catch((err) => {
        this.logger.warn(`[AppCredentials] could not persist the ${slug} handout record: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private loadPersistedHandouts(): Promise<void> {
    this.handoutsLoaded ??= readHandoutRecords().then((records) => {
      for (const slug of SUPPORTED_APP_SLUGS) {
        const record = records[slug];
        // A record this process already made is newer than anything on disk.
        if (record && !this.handouts.has(slug)) {
          this.handouts.set(slug, record);
        }
      }
    });
    return this.handoutsLoaded;
  }

  private async resolveCredentials(slug: AppSlug, apiVersion: ApiVersion): Promise<AppCredentialsConfig> {
    const profile = await this.hardwareInspector.getProfile();
    const preferences = this.configurationService.getInferencePreferences();
    const requirements = appInferenceRequirements(slug);
    // Shared with the app.env path (InferenceEnvResolver): resolves an unknown *or* an unavailable
    // `inferenceBackend` preference down to a healthy local Ollama before anyone considers cloud.
    const {
      backendType,
      backend,
      health: endpointHealth,
      ready: endpointReady,
    } = await this.endpoints.resolveActiveBackend(preferences.preferredBackend, 'AppCredentials');

    // Apps talk to the active backend via its own OpenAI-compatible surface — unless this Hub is
    // pooling, in which case the override below points them at the pool proxy instead.
    const backendBaseUrl = backend.getBaseUrl();
    const backendOpenAiUrl = `${backendBaseUrl}/v1`;

    // Embeddings stay on Ollama even when chat is vLLM/Lemonade. Probe Ollama
    // separately so a vLLM-only health check cannot look like "embeddings ready"
    // and so we do not fire an Ollama pull against a vLLM served-id list.
    const ollamaHealth =
      backendType === 'ollama'
        ? endpointHealth
        : await this.ollamaBackend.healthCheck().catch((err) => {
            this.logger.error(`[AppCredentials] ollama health check threw: ${err instanceof Error ? err.message : String(err)}`);
            return { running: false, healthy: false, modelsLoaded: [] as string[] };
          });
    const ollamaEndpointReady = !!(ollamaHealth.running && ollamaHealth.healthy);

    const candidates = this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile).filter((m) => m.backend === backendType);
    const preferredModelId = preferences.preferredModel;
    const recommendedLlm = this.resolveRecommendedLlm(candidates, preferredModelId, profile.tier, profile, slug, requirements);
    // The same engine the app.env resolver picks (`embeddingBackendFor`), so an app is never handed one
    // embedder here and another there: this path used to hand Ollama's `nomic-embed-text` to a
    // Lemonade-only node, where nothing serves it. Where no local engine has a catalog embedder (vLLM
    // with no Ollama, or oMLX) it keeps Ollama's id, as before — a pool node may serve it. The resolver
    // hands out none there; see `embeddingBackendFor` for why the two differ.
    const embeddingsBackend: InferenceBackendType = embeddingBackendFor(backendType, ollamaEndpointReady) === 'lemonade' ? 'lemonade' : 'ollama';
    const embeddingsServed = (embeddingsBackend === 'lemonade' ? endpointHealth.modelsLoaded : ollamaHealth.modelsLoaded) ?? [];
    const embeddings = pickEmbeddingModel(this.modelRegistry, {
      backend: embeddingsBackend,
      preferredId: preferences.preferredEmbeddingModel,
      profile,
      served: embeddingsServed,
    });

    // ─── Multi-Hub pooling: decided before the model and before cloud ────
    // Once a peer is connected the app's requests go to this Hub's pool proxy, which serves whatever
    // model ANY usable node lists. Choosing from this node's inventory alone is what handed core-4's
    // apps its local gemma3:1b while core-6 served qwen3-coder:30b to them over the pool. Gated on
    // the local path, like the resolver: a cloud-primary answer already has a working endpoint.
    const poolRouting = await this.endpoints.resolvePoolRouting('AppCredentials');
    const poolChoice = poolRouting?.spansPeers
      ? selectPoolChatModel({
          appSlug: slug,
          inventory: poolRouting.inventory,
          catalog: this.modelRegistry.getCatalog() ?? [],
          preferredId: preferredModelId,
          requirements,
        })
      : null;
    const poolServesChat = Boolean(poolChoice?.engineId);

    // A pool that serves the app is local inference too — peers this operator paired, over the
    // tailnet — so cloud only becomes primary when neither this node nor the pool can serve chat.
    const cloudProviders = this.cloudFallback.getEnabledProviders();
    const cloudProvider = endpointReady || poolServesChat ? undefined : cloudProviders[0];

    const keys = APP_ENV_KEYS[slug];

    // ─── Local (default) connection: app → active backend /v1 directly ───
    let provider: InferenceBackendType | 'cloud' = backendType;
    let endpointUrl = backendOpenAiUrl;
    // The engine's own credential. It is handed out only if the app ends up talking to the engine
    // directly, which is decided after the cloud and pool overrides below.
    const engineKey = (backendType === 'vllm' && preferences.preferredVllmApiKey?.trim()) || backend.getApiKey?.()?.trim();
    let cloudKey: string | undefined;

    let chatModel: CuratedModel | null;
    let chatModelId: string | null;
    let chatServedLocally = true;
    let chatModelError: string | null = null;
    let chatModelReady: boolean;
    if (poolChoice) {
      chatModel = poolChoice.model;
      chatModelId = poolChoice.engineId;
      chatServedLocally = poolChoice.servedLocally;
      chatModelError = poolChoice.error;
      chatModelReady = poolServesChat;
      this.logger.info(
        `[AppCredentials] ${slug}: pool handout chat=${chatModelId ?? 'none'} source=${poolChoice.source} ` +
          `servedBy=${poolChoice.servedBy.join(',') || 'none'}` +
          (poolChoice.preferredNote ? ` (${poolChoice.preferredNote})` : '') +
          (poolChoice.rejected.length ? ` rejected=${poolChoice.rejected.map((r) => `${r.engineId}[${r.unmet.join('; ')}]`).join(',')}` : ''),
      );
    } else {
      const localChat = this.resolveAvailableLlm(
        candidates,
        preferredModelId,
        profile.tier,
        profile,
        endpointHealth.modelsLoaded,
        backendType,
        slug,
        requirements,
      );
      chatModel = localChat.model;
      chatModelId = localChat.model?.backendModelId ?? null;
      // vLLM and oMLX are both host-managed servers with no Hub pull registry — an
      // operator can serve a model outside the catalog, so fall back to whatever it reports rather
      // than leaving chatModelId empty. A served model the catalog knows fails the app is skipped.
      if (!chatModelId && isHostServedBackend(backendType)) {
        chatModelId = endpointHealth.modelsLoaded.find((id) => this.servedModelVerdict(id, backendType, requirements) !== 'fails') ?? null;
      }
      // Host-managed servers can expose an operator-chosen model that is not in the Hub catalog.
      // A healthy endpoint with at least one served model is therefore ready even when there is no
      // curated `recommendedLlm` to match (the speculative inference model alias is configured at server startup).
      chatModelReady =
        (recommendedLlm ? this.isModelPulled(recommendedLlm.id, endpointHealth.modelsLoaded, backendType) : false) ||
        (isHostServedBackend(backendType) && endpointReady && endpointHealth.modelsLoaded.length > 0);
      if (!chatModelId && localChat.rejected.length > 0) {
        chatModelError = describeNoSuitableChatModel({ appSlug: slug, requirements, rejected: localChat.rejected, scope: 'local' });
      }
    }
    const embeddingsModelId = embeddings
      ? embedderEngineId(embeddings, embeddingsServed, embeddingsBackend === 'lemonade' ? backend : this.ollamaBackend)
      : null;

    // ─── Cloud override: app → cloud provider API directly ───────────────
    if (cloudProvider) {
      provider = 'cloud';
      endpointUrl = cloudProvider.baseUrl || endpointUrl;
      cloudKey = cloudProvider.apiKey;
      if (cloudProvider.defaultModel) {
        chatModelId = cloudProvider.defaultModel;
        chatModelError = null;
      }
    }

    // Always expose a native (non-OpenAI) Ollama URL, regardless of which backend is primary or
    // whether a cloud provider is overriding it, so the app can still speak Ollama's own protocol
    // if Ollama happens to also be installed alongside the active backend. The pool override below
    // may re-point it at the proxy, which serves the same native routes (`api/generate`,
    // `api/embeddings`, `api/tags`) under its own prefix.
    let ollamaHost = this.ollamaBackend.getBaseUrl();

    const routedThroughPool = provider !== 'cloud' && poolRouting !== null;
    if (routedThroughPool) {
      const routed = this.endpoints.applyPoolRouting({ openAiBaseUrl: endpointUrl, ollamaHost }, poolRouting, 'AppCredentials');
      endpointUrl = routed.openAiBaseUrl;
      ollamaHost = routed.ollamaHost;
    }

    // Against the URL the app is actually handed. Through the pool proxy the engine key would sit in
    // every app's container and data dir for nothing: the proxy admits apps by origin and never reads
    // the bearer. And a cloud provider without a key of its own must not be sent the engine's.
    const apiKey = cloudKey || appBearerFor({ endpointUrl, backendType, engineUrl: backendBaseUrl, engineKey });

    const env: Record<string, string> = {
      [keys.baseUrl]: endpointUrl,
      [keys.apiKey]: apiKey,
      CI_INFERENCE_BACKEND: provider,
      ...this.cloudFallback.toAppEnv(),
    };
    if (chatModelId) {
      env[keys.model] = chatModelId;
    } else if (chatModelError) {
      env[INFERENCE_ERROR_ENV_KEY] = chatModelError;
      this.logger.warn(`[AppCredentials] ${slug}: handing out no chat model: ${chatModelError}`);
    }
    if (embeddingsModelId) {
      env[keys.embeddings] = embeddingsModelId;
    }
    env.OLLAMA_HOST = ollamaHost;

    // Context window for the model the app will actually run. Cloud providers manage their own
    // context, so this is only emitted on the local and pooled paths. Apps cap their token budget /
    // pass it as the backend's native `num_ctx` so they don't inherit an oversized memory-based
    // default (e.g. 262144 on unified-memory APUs). The model already meets the app's minimum, so
    // the floor below is always reachable.
    if (provider !== 'cloud' && chatModel && chatModelId === chatModel.backendModelId) {
      // Same measured-first sizing as InferenceEnvResolver; see `probeLocalSizing`. Only a
      // model this node serves can be measured, so a pool-served one keeps the heuristic.
      const askOllama = chatServedLocally && backendType === 'ollama';
      const [sizing, residentContextLength, servedContextLength] = await Promise.all([
        chatServedLocally
          ? probeLocalSizing({
              backendType,
              backend,
              model: chatModel,
              profile,
              statedOllamaSlots: preferences.ollamaSlots,
              sightings: this.memoryManager,
            })
          : null,
        askOllama ? this.ollamaBackend.residentContextLength(chatModel.backendModelId) : null,
        chatServedLocally ? Promise.resolve(backend.servedContextLength?.(chatModel.backendModelId) ?? null).catch(() => null) : null,
      ]);
      // Same cap as the resolver: through the pool, the largest cap among the nodes serving the
      // model (placement keeps the request off the smaller ones — see `poolContextCap`); this
      // node's own cap on the direct path. See `inference-context-cap.ts`.
      const localContextCap = this.endpoints.localContextCap();
      const maxContextLength = poolChoice ? poolChoice.contextCap : localContextCap;
      const sized = handoutContextLength({
        model: chatModel,
        servedLocally: chatServedLocally,
        effectiveInferenceMemoryMb: modelMemoryCeilingMb(profile),
        minContextLength: requirements.minContextLength,
        kvMbPerToken: sizing?.kvMbPerToken ?? null,
        weightMb: sizing?.weightMb ?? null,
        kvSlots: sizing?.kvSlots ?? null,
        sighting: sizing?.sighting ?? null,
        maxContextLength,
      });
      // Never above the one window Lemonade serves this model at to every caller.
      const served = capHandoutAtServedWindow({
        appSlug: slug,
        engineId: chatModelId,
        backendType,
        numCtx: sized,
        servedContextLength: servedContextLength ?? null,
        minContextLength: requirements.minContextLength,
      });
      const numCtx = served.numCtx;
      env[keys.numCtx] = String(numCtx);
      for (const note of served.notes) {
        this.logger.warn(`[AppCredentials] ${note}`);
      }
      for (const note of describeContextHandout({
        appSlug: slug,
        engineId: chatModelId,
        numCtx,
        maxContextLength,
        minContextLength: requirements.minContextLength,
        residentContextLength: residentContextLength ?? null,
        ...(poolChoice && chatServedLocally ? { localContextCap } : {}),
      })) {
        this.logger.warn(`[AppCredentials] ${note}`);
      }
    }

    // Declare num_ctx and the error key as Hub-managed even when no value is emitted, so the
    // X-Hub-Managed-Keys header tells the bootstrap scripts to strip a stale one.
    //
    // The model key is declared only when this answer is authoritative: a model was chosen, or an
    // unsuitable one was refused while this node's own backend was up to be judged. Withholding
    // gemma3:1b must strip the previous run's DEFAULT_MODEL=gemma3:1b, which is the value this
    // handout exists to replace. But a container that starts while Ollama is still coming up gets
    // an empty inventory, and declaring the key then would erase a model that works a minute later
    // and leave the app with none until its next restart.
    const modelAnswerIsAuthoritative = chatModelId !== null || (chatModelError !== null && endpointReady);
    const managedKeys = [
      ...new Set([
        ...Object.keys(env),
        ...cloudProviderManagedKeys(),
        ...(modelAnswerIsAuthoritative ? [keys.model] : []),
        keys.numCtx,
        INFERENCE_ERROR_ENV_KEY,
      ]),
    ];

    const embeddingsReady = embeddings ? this.isModelPulled(embeddings.id, embeddingsServed, embeddingsBackend) : false;
    const prePull = [
      decideModelPrePull({
        kind: 'chat',
        model: recommendedLlm,
        backendType,
        endpointReady,
        cloudPrimary: provider === 'cloud',
        installedLocally: recommendedLlm ? this.isModelPulled(recommendedLlm.id, endpointHealth.modelsLoaded, backendType) : false,
        poolServedBy: poolRouting && recommendedLlm ? nodesServing(poolRouting.inventory, recommendedLlm.backendModelId, recommendedLlm.backend) : [],
        poolHandout: routedThroughPool ? (poolChoice?.engineId ?? null) : null,
        operatorPreferred: Boolean(recommendedLlm && preferredModelId && recommendedLlm.id === preferredModelId),
        requirements,
        engineOffers: recommendedLlm?.backend === backendType ? (backend.offersModel?.(recommendedLlm.backendModelId) ?? null) : null,
      }),
      decideModelPrePull({
        kind: 'embeddings',
        model: embeddings ?? null,
        backendType: embeddingsBackend,
        endpointReady: embeddingsBackend === 'lemonade' ? endpointReady : ollamaEndpointReady,
        cloudPrimary: false,
        installedLocally: embeddingsReady,
        poolServedBy:
          poolRouting && embeddings && embeddingsModelId ? nodesServing(poolRouting.inventory, embeddingsModelId, embeddings.backend) : [],
        engineOffers: embeddings && embeddingsBackend === 'lemonade' ? (backend.offersModel?.(embeddings.backendModelId) ?? null) : null,
      }),
    ].filter((decision): decision is PrePullDecision => decision !== null);

    const reportedReady = endpointReady || (routedThroughPool && poolServesChat);
    this.logger.info(
      `[AppCredentials] resolve slug=${slug} v=${apiVersion} provider=${provider} endpoint=${endpointUrl} endpointReady=${reportedReady} ` +
        `pool=${routedThroughPool} chat=${chatModelId ?? 'none'} chatReady=${chatModelReady} embeddings=${embeddingsModelId ?? 'none'}`,
    );

    return {
      app: slug,
      apiVersion,
      endpointUrl,
      endpointReady: reportedReady,
      chatModelId,
      embeddingsModelId,
      chatModelReady,
      provider,
      routedThroughPool,
      chatModelServedBy: routedThroughPool && poolChoice ? poolChoice.servedBy : [],
      chatModelError: chatModelId ? null : chatModelError,
      prePull,
      env,
      managedKeys,
    };
  }

  serializeAsDotenv(config: AppCredentialsConfig): string {
    return `${Object.entries(config.env)
      .map(([k, v]) => `${k}=${this.escapeDotenvValue(v)}`)
      .join('\n')}\n`;
  }

  /** Clear the per-slug cache. Tests + admin endpoints can use this. */
  invalidateCache(): void {
    this.cache.clear();
  }

  /**
   * The model this node would pull for a sibling app. Honors the user's preferred model (set during
   * AI setup) when it is an LLM that is runnable on the current hardware and meets the app's
   * requirements — otherwise falls back to the top hardware-recommended model that meets them.
   * Pulling a model the app would refuse spends the disk for nothing.
   */
  private resolveRecommendedLlm(
    candidates: CuratedModel[],
    preferredId: string | null,
    tier: HardwareTier,
    profile: HardwareProfile,
    slug: AppSlug,
    requirements: AppInferenceRequirements,
  ): CuratedModel | null {
    const suitable = (model: CuratedModel) => checkModelRequirements(model, requirements).verdict !== 'fails';
    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      const curated = this.modelRegistry.getCuratedModel(preferredId);
      const hardwareModels =
        this.modelRegistry.getModelsForHardware(tier, profile, { includeRemoteHostBackends: true }) ?? this.modelRegistry.getModelsForTier(tier);
      const preferred =
        fromCandidates ?? (curated && curated.modality === 'llm' && hardwareModels.some((m) => m.id === preferredId) ? curated : undefined);
      if (preferred && suitable(preferred)) return preferred;
      if (preferred) {
        this.logger.warn(`[AppBootstrap] preferred model ${preferredId} does not meet ${slug}'s requirements; recommending one that does.`);
      } else {
        this.logger.warn(
          `[AppBootstrap] preferred model ${preferredId} is not runnable on tier=${tier}/platform=${profile.os?.platform ?? 'unknown'}; falling back to recommended.`,
        );
      }
    }
    return candidates.find((m) => m.modality === 'llm' && suitable(m)) ?? null;
  }

  private resolveAvailableLlm(
    candidates: CuratedModel[],
    preferredId: string | null,
    tier: HardwareTier,
    profile: HardwareProfile,
    modelsLoaded: string[],
    backendType: InferenceBackendType,
    slug: AppSlug,
    requirements: AppInferenceRequirements,
  ): LocalChatSelection {
    const rejected: LocalChatSelection['rejected'] = [];
    const pickIfAvailable = (model: CuratedModel | null | undefined): CuratedModel | null => {
      if (!model || model.modality !== 'llm') return null;
      if (!this.isCuratedModelAvailable(model, modelsLoaded, backendType)) return null;
      const check = checkModelRequirements(model, requirements);
      if (check.verdict === 'fails') {
        if (!rejected.some((r) => r.engineId === model.backendModelId)) {
          rejected.push({ engineId: model.backendModelId, unmet: check.unmet });
        }
        return null;
      }
      return model;
    };

    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      const preferred = pickIfAvailable(fromCandidates);
      if (preferred) return { model: preferred, rejected };

      const curated = this.modelRegistry.getCuratedModel(preferredId);
      const hardwareModels =
        this.modelRegistry.getModelsForHardware(tier, profile, { includeRemoteHostBackends: true }) ?? this.modelRegistry.getModelsForTier(tier);
      if (curated && curated.modality === 'llm' && hardwareModels.some((m) => m.id === preferredId)) {
        const preferredCurated = pickIfAvailable(curated);
        if (preferredCurated) return { model: preferredCurated, rejected };
      }

      this.logger.warn(
        `[AppBootstrap] preferred model ${preferredId} is not available to ${slug} on ${backendType}; falling back to a served model.`,
      );
    }

    for (const candidate of candidates) {
      const available = pickIfAvailable(candidate);
      if (available) return { model: available, rejected };
    }

    return { model: null, rejected };
  }

  /** The catalog's verdict on a host-served engine id, or `unverified` when no catalog row matches it. */
  private servedModelVerdict(engineId: string, backendType: InferenceBackendType, requirements: AppInferenceRequirements) {
    const row = (this.modelRegistry.getCatalog() ?? []).find(
      (m) => m.backend === backendType && m.modality === 'llm' && isServedModelForCatalog(m, [engineId]),
    );
    return checkModelRequirements(row ?? null, requirements).verdict;
  }

  private isCuratedModelAvailable(model: CuratedModel, modelsLoaded: string[], backendType: InferenceBackendType): boolean {
    if (this.isModelPulled(model.id, modelsLoaded, backendType)) return true;
    // vLLM and oMLX have no Hub pull registry — "available" means the operator's
    // server is actually reporting this exact id, not that the Hub tracked a pull for it.
    if (isHostServedBackend(backendType)) {
      return isServedModelForCatalog(model, modelsLoaded);
    }
    return isCatalogModelInstalled(model, modelsLoaded, false, this.modelRegistry.getCatalogBackendModelIds());
  }

  private isModelPulled(catalogId: string, modelsLoaded: string[], backendType: InferenceBackendType): boolean {
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (isHostServedBackend(backendType)) {
      return curated ? isServedModelForCatalog(curated, modelsLoaded) : modelsLoaded.includes(catalogId);
    }

    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    if (tracked && (tracked.state === 'pulled' || tracked.state === 'loaded' || tracked.state === 'pinned')) {
      return true;
    }
    return isCatalogModelInstalled(curated, modelsLoaded, false, this.modelRegistry.getCatalogBackendModelIds());
  }

  private maybeFirePrePull(catalogId: string): void {
    void this.modelPuller
      .startPull(catalogId, { bestEffort: true })
      .then((result) => {
        if (result.status === 'queued') {
          this.logger.info(`[AppCredentials] pre-pull queued ${catalogId}`);
        } else if (result.status === 'in_progress') {
          this.logger.info(`[AppCredentials] pre-pull already in progress ${catalogId}`);
        } else if (result.status === 'already_installed') {
          this.logger.info(`[AppCredentials] pre-pull skipped ${catalogId}: already installed`);
          this.invalidateCache();
          return;
        } else if (result.status === 'skipped') {
          this.logger.warn(`[AppCredentials] pre-pull skipped ${catalogId}: ${result.reason ?? 'blocked'}`);
          return;
        } else {
          return;
        }

        this.waitForPrePullAndRefreshCache(catalogId);
      })
      .catch((err) => {
        this.logger.warn(`[AppCredentials] pre-pull start failed ${catalogId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private waitForPrePullAndRefreshCache(catalogId: string): void {
    void this.modelPuller
      .waitForPullCompletion(catalogId)
      .then(() => {
        this.logger.info(`[AppCredentials] pre-pull complete ${catalogId}`);
        this.invalidateCache();
      })
      .catch((err) => {
        this.logger.warn(`[AppCredentials] pre-pull failed ${catalogId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private escapeDotenvValue(value: string): string {
    if (/[\s"'#=]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
}
