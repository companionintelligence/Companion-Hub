import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { MtplxBackend } from './backends/mtplx.backend';
import { DsparkBackend } from './backends/dspark.backend';
import { LuceboxBackend } from './backends/lucebox.backend';
import type { InferenceBackend } from './backends/backend.interface';
import type { CuratedModel, HardwareProfile, HardwareTier, InferenceBackendType } from '@ci-hub/common/types';
import { isCatalogModelInstalled, isServedModelForCatalog } from './model-availability.util';
import { appMinContextLength, recommendContextLength } from './context-length.util';
import { BACKEND_API_KEY } from './inference-env-resolver';
import { cloudProviderManagedKeys } from './cloud-provider-env';

// Only Hub-managed sibling apps use the bootstrap credentials endpoints.
// Standalone services (for example companion-memory / CI-Server) receive
// inference config through their own app env wiring instead.
export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw'] as const;
export type AppSlug = (typeof SUPPORTED_APP_SLUGS)[number];

export const SUPPORTED_API_VERSIONS = [1] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];
export const DEFAULT_API_VERSION: ApiVersion = 1;

export interface AppCredentialsConfig {
  app: AppSlug;
  apiVersion: ApiVersion;
  /** Where the app should send inference requests directly (Ollama /v1 or a cloud provider). */
  endpointUrl: string;
  endpointReady: boolean;
  /** Chat model id the app should request. Native backend id for Ollama, provider model for cloud. */
  chatModelId: string | null;
  /** Embeddings model id (native backend id for Ollama). */
  embeddingsModelId: string | null;
  /** True once the recommended local chat model is pulled into Ollama. */
  chatModelReady: boolean;
  /** Which connection the app was handed: the active local backend, or a cloud provider. */
  provider: InferenceBackendType | 'cloud';
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
};

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  config: AppCredentialsConfig;
  expiresAt: number;
}

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
 * registry: vLLM (including vLLM-Metal), mlx-dspark, MTPLX, and Lucebox. For these, "is this model
 * installed?" can only be answered from what the server reports it is serving, so catalog matching
 * goes through `isServedModelForCatalog` rather than the Ollama-style pulled-tag comparison.
 */
function isHostServedBackend(backendType: InferenceBackendType): boolean {
  return backendType === 'vllm' || backendType === 'dspark' || backendType === 'mtplx' || backendType === 'lucebox';
}

@Injectable()
export class AppCredentialsService {
  /** In-memory credentials cache keyed by `${slug}:${apiVersion}`. */
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
    private readonly mtplxBackend: MtplxBackend,
    private readonly dsparkBackend: DsparkBackend,
    private readonly luceboxBackend: LuceboxBackend,
    private readonly configurationService: ConfigurationService,
  ) {}

  private getBackend(type: InferenceBackendType): InferenceBackend {
    switch (type) {
      case 'ollama':
        return this.ollamaBackend;
      case 'vllm':
        return this.vllmBackend;
      case 'lemonade':
        return this.lemonadeBackend;
      case 'mtplx':
        return this.mtplxBackend;
      case 'dspark':
        return this.dsparkBackend;
      case 'lucebox':
        return this.luceboxBackend;
    }
  }

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

  async getCredentials(slug: string, apiVersion: ApiVersion = DEFAULT_API_VERSION): Promise<AppCredentialsConfig> {
    if (!this.isSupported(slug)) {
      throw new NotFoundException(`Unknown app slug: ${slug}. Supported: ${SUPPORTED_APP_SLUGS.join(', ')}`);
    }

    const cacheKey = `${slug}:${apiVersion}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.logger.info(`[AppCredentials] cache hit slug=${slug} v=${apiVersion} ttl=${Math.round((cached.expiresAt - now) / 1000)}s`);
      return cached.config;
    }

    const profile = await this.hardwareInspector.getProfile();
    const preferences = this.configurationService.getInferencePreferences();
    const backendType = preferences.preferredBackend ?? 'ollama';
    const backend = this.getBackend(backendType);

    // Apps talk to the active backend directly via its own OpenAI-compatible surface, not the Hub.
    const backendBaseUrl = backend.getBaseUrl();
    const backendOpenAiUrl = `${backendBaseUrl}/v1`;

    const endpointHealth = await backend.healthCheck().catch((err) => {
      this.logger.error(`[AppCredentials] ${backendType} health check threw: ${err instanceof Error ? err.message : String(err)}`);
      return { running: false, healthy: false, modelsLoaded: [] as string[] };
    });
    const endpointReady = !!(endpointHealth.running && endpointHealth.healthy);

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
    const recommendedLlm = this.resolveRecommendedLlm(candidates, preferredModelId, profile.tier, profile);
    const availableLlm = this.resolveAvailableLlm(candidates, preferredModelId, profile.tier, profile, endpointHealth.modelsLoaded, backendType);
    const embeddings =
      (preferences.preferredEmbeddingModel ? this.modelRegistry.getCuratedModel(preferences.preferredEmbeddingModel) : null) ??
      this.modelRegistry.getRecommendedEmbeddingModel(profile.tier, 'ollama', profile);

    const cloudProviders = this.cloudFallback.getEnabledProviders();
    const cloudProvider = endpointReady ? undefined : cloudProviders[0];

    // Host-managed servers can expose an operator-chosen model that is not in the Hub catalog.
    // A healthy endpoint with at least one served model is therefore ready even when there is no
    // curated `recommendedLlm` to match (the speculative inference model alias is configured at server startup).
    const chatModelReady =
      (recommendedLlm ? this.isModelPulled(recommendedLlm.id, endpointHealth.modelsLoaded, backendType) : false) ||
      (isHostServedBackend(backendType) && endpointReady && endpointHealth.modelsLoaded.length > 0);
    if (!cloudProvider && recommendedLlm && !chatModelReady && endpointReady && backendType === 'ollama') {
      void this.maybeFirePrePull(recommendedLlm.id);
    }
    const embeddingsReady = embeddings ? this.isModelPulled(embeddings.id, ollamaHealth.modelsLoaded, 'ollama') : false;
    if (embeddings && !embeddingsReady && ollamaEndpointReady) {
      void this.maybeFirePrePull(embeddings.id);
    }

    const keys = APP_ENV_KEYS[slug];

    // ─── Local (default) connection: app → active backend /v1 directly ───
    let provider: InferenceBackendType | 'cloud' = backendType;
    let endpointUrl = backendOpenAiUrl;
    let apiKey = backend.getApiKey?.()?.trim() || BACKEND_API_KEY[backendType];
    if (backendType === 'vllm') {
      const customKey = preferences.preferredVllmApiKey?.trim();
      if (customKey) {
        apiKey = customKey;
      }
    }
    let chatModelId = availableLlm?.backendModelId ?? null;
    // vLLM, MTPLX, and mlx-dspark are all host-managed servers with no Hub pull registry — an
    // operator can serve a model outside the catalog, so fall back to whatever it reports rather
    // than leaving chatModelId empty.
    if (!chatModelId && isHostServedBackend(backendType) && endpointHealth.modelsLoaded.length > 0) {
      chatModelId = endpointHealth.modelsLoaded[0] ?? null;
    }
    const embeddingsModelId = embeddings?.backendModelId ?? null;

    // ─── Cloud override: app → cloud provider API directly ───────────────
    if (cloudProvider) {
      provider = 'cloud';
      endpointUrl = cloudProvider.baseUrl || endpointUrl;
      apiKey = cloudProvider.apiKey || apiKey;
      chatModelId = cloudProvider.defaultModel || chatModelId;
    }

    const env: Record<string, string> = {
      [keys.baseUrl]: endpointUrl,
      [keys.apiKey]: apiKey,
      CI_INFERENCE_BACKEND: provider,
      ...this.cloudFallback.toAppEnv(),
    };
    if (chatModelId) {
      env[keys.model] = chatModelId;
    }
    if (embeddingsModelId) {
      env[keys.embeddings] = embeddingsModelId;
    }
    // Always expose the direct native Ollama URL, regardless of which backend is primary or
    // whether a cloud provider is overriding it, so the app can still reach Ollama's native
    // protocol if Ollama happens to also be installed alongside the active backend.
    env.OLLAMA_HOST = this.ollamaBackend.getBaseUrl();

    // Hardware-aware default context window for the model the app will actually
    // run locally. Cloud providers manage their own context, so this is only
    // emitted on the direct-local-backend path. Apps cap their token budget / pass
    // it as the backend's native `num_ctx` so they don't inherit an oversized
    // memory-based default (e.g. 262144 on unified-memory APUs).
    if (provider !== 'cloud' && availableLlm) {
      const minContextLength = appMinContextLength(slug);
      const numCtx = recommendContextLength({
        effectiveInferenceMemoryMb: profile.effectiveInferenceMemoryMb,
        modelFootprintMb: availableLlm.runtime.memoryFootprintMb,
        modelContextWindow: availableLlm.runtime.contextWindow,
        minContextLength,
      });
      env[keys.numCtx] = String(numCtx);
      // When an app declares a minimum the model cannot satisfy, the floor is
      // capped to the model window and the app will refuse to start — surface it.
      if (minContextLength && numCtx < minContextLength) {
        this.logger.warn(
          `[AppCredentials] ${slug}: resolved context window ${numCtx} is below the app's ` +
            `${minContextLength}-token minimum (model ${availableLlm.runtime.contextWindow}-token window ` +
            `caps the floor); ${slug} may refuse to start. Choose a larger-context model.`,
        );
      }
    }

    // Always declare the per-app num_ctx key as Hub-managed — even when we don't
    // emit a value (cloud provider selected, or no runnable local model) — so the
    // X-Hub-Managed-Keys header tells consumers to strip any stale *_NUM_CTX left
    // in the app's .env rather than honoring an outdated context cap.
    const managedKeys = [...new Set([...Object.keys(env), ...cloudProviderManagedKeys()])];
    if (!managedKeys.includes(keys.numCtx)) {
      managedKeys.push(keys.numCtx);
    }

    this.logger.info(
      `[AppCredentials] resolve slug=${slug} v=${apiVersion} provider=${provider} endpoint=${endpointUrl} endpointReady=${endpointReady} ` +
        `chat=${chatModelId ?? 'none'} chatReady=${chatModelReady} embeddings=${embeddingsModelId ?? 'none'}`,
    );

    const config: AppCredentialsConfig = {
      app: slug,
      apiVersion,
      endpointUrl,
      endpointReady,
      chatModelId,
      embeddingsModelId,
      chatModelReady,
      provider,
      env,
      managedKeys,
    };

    this.cache.set(cacheKey, { config, expiresAt: now + CACHE_TTL_MS });
    return config;
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
   * Resolve the default LLM for a sibling app. Honors the user's preferred model (set during AI
   * setup) when it is an LLM that is runnable on the current hardware — otherwise falls back to the
   * top hardware-recommended model (candidates[0], biggest that fits at q4+). This is what makes the
   * onboarding "preferred model" selection actually drive what Hermes/OpenClaw default to.
   */
  private resolveRecommendedLlm(
    candidates: CuratedModel[],
    preferredId: string | null,
    tier: HardwareTier,
    profile: HardwareProfile,
  ): CuratedModel | null {
    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      if (fromCandidates) return fromCandidates;
      const curated = this.modelRegistry.getCuratedModel(preferredId);
      const hardwareModels =
        this.modelRegistry.getModelsForHardware(tier, profile, { includeRemoteHostBackends: true }) ?? this.modelRegistry.getModelsForTier(tier);
      if (curated && curated.modality === 'llm' && hardwareModels.some((m) => m.id === preferredId)) {
        return curated;
      }
      this.logger.warn(
        `[AppBootstrap] preferred model ${preferredId} is not runnable on tier=${tier}/platform=${profile.os?.platform ?? 'unknown'}; falling back to recommended.`,
      );
    }
    return candidates[0] ?? null;
  }

  private resolveAvailableLlm(
    candidates: CuratedModel[],
    preferredId: string | null,
    tier: HardwareTier,
    profile: HardwareProfile,
    modelsLoaded: string[],
    backendType: InferenceBackendType,
  ): CuratedModel | null {
    const pickIfAvailable = (model: CuratedModel | null | undefined): CuratedModel | null => {
      if (!model || model.modality !== 'llm') return null;
      return this.isCuratedModelAvailable(model, modelsLoaded, backendType) ? model : null;
    };

    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      const preferred = pickIfAvailable(fromCandidates);
      if (preferred) return preferred;

      const curated = this.modelRegistry.getCuratedModel(preferredId);
      const hardwareModels =
        this.modelRegistry.getModelsForHardware(tier, profile, { includeRemoteHostBackends: true }) ?? this.modelRegistry.getModelsForTier(tier);
      if (curated && curated.modality === 'llm' && hardwareModels.some((m) => m.id === preferredId)) {
        const preferredCurated = pickIfAvailable(curated);
        if (preferredCurated) return preferredCurated;
      }

      this.logger.warn(`[AppBootstrap] preferred model ${preferredId} is not available on ${backendType}; falling back to a served model.`);
    }

    for (const candidate of candidates) {
      const available = pickIfAvailable(candidate);
      if (available) return available;
    }

    return null;
  }

  private isCuratedModelAvailable(model: CuratedModel, modelsLoaded: string[], backendType: InferenceBackendType): boolean {
    if (this.isModelPulled(model.id, modelsLoaded, backendType)) return true;
    // vLLM, MTPLX, and mlx-dspark have no Hub pull registry — "available" means the operator's
    // server is actually reporting this exact id, not that the Hub tracked a pull for it.
    if (isHostServedBackend(backendType)) {
      return isServedModelForCatalog(model, modelsLoaded);
    }
    return isCatalogModelInstalled(model, modelsLoaded);
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
    return isCatalogModelInstalled(curated, modelsLoaded);
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
