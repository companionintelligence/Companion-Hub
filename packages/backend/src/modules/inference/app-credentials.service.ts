import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { CloudFallbackService } from './cloud-fallback.service';
import { OllamaBackend } from './backends/ollama.backend';
import type { CuratedModel, HardwareTier } from '@ci-hub/common/types';
import { isCatalogModelInstalled } from './model-availability.util';

export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw', 'companion-memory'] as const;
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
  /** Which connection the app was handed: direct Ollama or a cloud provider. */
  provider: 'ollama' | 'cloud';
  env: Record<string, string>;
  managedKeys: string[];
}

const APP_ENV_KEYS: Record<AppSlug, { baseUrl: string; model: string; embeddings: string; apiKey: string }> = {
  'hermes-agent': {
    baseUrl: 'HERMES_OPENAI_BASE_URL',
    model: 'HERMES_DEFAULT_MODEL',
    embeddings: 'HERMES_EMBEDDINGS_MODEL',
    apiKey: 'HERMES_OPENAI_API_KEY',
  },
  openclaw: {
    baseUrl: 'OPENAI_API_BASE',
    model: 'DEFAULT_MODEL',
    embeddings: 'EMBEDDINGS_MODEL',
    apiKey: 'OPENAI_API_KEY',
  },
  // CI-Server (the "Companion Memory" memory brain). Uses its own LLM_* convention,
  // which its summary-service already reads and its NestJS API is migrating onto.
  'companion-memory': {
    baseUrl: 'LLM_API_BASE',
    model: 'LLM_DEFAULT_CHAT_MODEL',
    embeddings: 'LLM_DEFAULT_EMBEDDING_MODEL',
    apiKey: 'LLM_API_KEY',
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
@Injectable()
export class AppCredentialsService {
  /** In-memory credentials cache keyed by `${slug}:${apiVersion}`. */
  private cache = new Map<string, CacheEntry>();
  /** Catalog IDs currently pulling so we don't fire duplicate background pulls. */
  private pullsInFlight = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly cloudFallback: CloudFallbackService,
    private readonly ollamaBackend: OllamaBackend,
    private readonly configurationService: ConfigurationService,
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
    // Apps talk to Ollama directly via its own OpenAI-compatible surface, not the Hub.
    const ollamaBaseUrl = this.ollamaBackend.getBaseUrl();
    const ollamaOpenAiUrl = `${ollamaBaseUrl}/v1`;

    const endpointHealth = await this.ollamaBackend.healthCheck().catch((err) => {
      this.logger.error(`[AppCredentials] Ollama health check threw: ${err instanceof Error ? err.message : String(err)}`);
      return { running: false, healthy: false, modelsLoaded: [] as string[] };
    });
    const endpointReady = !!(endpointHealth.running && endpointHealth.healthy);

    const candidates = this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile);
    const preferredModelId = this.configurationService.getInferencePreferences().preferredModel;
    const recommendedLlm = this.resolveRecommendedLlm(candidates, preferredModelId, profile.tier);
    const availableLlm = this.resolveAvailableLlm(candidates, preferredModelId, profile.tier, endpointHealth.modelsLoaded);
    const embeddings = this.modelRegistry.getRecommendedEmbeddingModel(profile.tier);

    const cloudProvider = this.cloudFallback.getEnabledProviders()[0];

    const chatModelReady = recommendedLlm ? this.isModelPulled(recommendedLlm.id, endpointHealth.modelsLoaded) : false;
    if (!cloudProvider && recommendedLlm && !chatModelReady && endpointReady) {
      void this.maybeFirePrePull(recommendedLlm.id);
    }
    const embeddingsReady = embeddings ? this.isModelPulled(embeddings.id, endpointHealth.modelsLoaded) : false;
    if (embeddings && !embeddingsReady && endpointReady) {
      void this.maybeFirePrePull(embeddings.id);
    }

    const keys = APP_ENV_KEYS[slug];

    // ─── Local (default) connection: app → Ollama /v1 directly ───────────
    let provider: 'ollama' | 'cloud' = 'ollama';
    let endpointUrl = ollamaOpenAiUrl;
    let apiKey = 'ollama';
    let chatModelId = availableLlm?.backendModelId ?? null;
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
    };
    if (chatModelId) {
      env[keys.model] = chatModelId;
    }
    if (embeddingsModelId) {
      env[keys.embeddings] = embeddingsModelId;
    }
    // Always expose the direct native Ollama URL so the app can reach Ollama's
    // native protocol regardless of the OpenAI-compatible / cloud connection above.
    env.OLLAMA_HOST = ollamaBaseUrl;

    const managedKeys = Object.keys(env);

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
  private resolveRecommendedLlm(candidates: CuratedModel[], preferredId: string | null, tier: HardwareTier): CuratedModel | null {
    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      if (fromCandidates) return fromCandidates;
      const curated = this.modelRegistry.getCuratedModel(preferredId);
      if (curated && curated.modality === 'llm' && this.modelRegistry.getModelsForTier(tier).some((m) => m.id === preferredId)) {
        return curated;
      }
      this.logger.warn(`[AppBootstrap] preferred model ${preferredId} is not runnable on tier=${tier}; falling back to recommended.`);
    }
    return candidates[0] ?? null;
  }

  private resolveAvailableLlm(
    candidates: CuratedModel[],
    preferredId: string | null,
    tier: HardwareTier,
    modelsLoaded: string[],
  ): CuratedModel | null {
    const pickIfAvailable = (model: CuratedModel | null | undefined): CuratedModel | null => {
      if (!model || model.modality !== 'llm') return null;
      return this.isCuratedModelAvailable(model, modelsLoaded) ? model : null;
    };

    if (preferredId) {
      const fromCandidates = candidates.find((m) => m.id === preferredId);
      const preferred = pickIfAvailable(fromCandidates);
      if (preferred) return preferred;

      const curated = this.modelRegistry.getCuratedModel(preferredId);
      if (curated && curated.modality === 'llm' && this.modelRegistry.getModelsForTier(tier).some((m) => m.id === preferredId)) {
        const preferredCurated = pickIfAvailable(curated);
        if (preferredCurated) return preferredCurated;
      }

      this.logger.warn(`[AppBootstrap] preferred model ${preferredId} is not available in Ollama; falling back to a pulled model.`);
    }

    for (const candidate of candidates) {
      const available = pickIfAvailable(candidate);
      if (available) return available;
    }

    return null;
  }

  private isCuratedModelAvailable(model: CuratedModel, modelsLoaded: string[]): boolean {
    if (this.isModelPulled(model.id, modelsLoaded)) return true;
    return isCatalogModelInstalled(model.id, model, modelsLoaded);
  }

  private isModelPulled(catalogId: string, modelsLoaded: string[]): boolean {
    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    if (tracked && (tracked.state === 'pulled' || tracked.state === 'loaded' || tracked.state === 'pinned')) {
      return true;
    }
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    return isCatalogModelInstalled(catalogId, curated, modelsLoaded);
  }

  private async maybeFirePrePull(catalogId: string): Promise<void> {
    if (this.pullsInFlight.has(catalogId)) {
      return;
    }
    try {
      const evaluation = await this.modelPuller.evaluatePull(catalogId);
      if (evaluation.alreadyInstalled) {
        return;
      }
      if (!evaluation.canPull) {
        this.logger.warn(`[AppCredentials] pre-pull skipped ${catalogId}: ${evaluation.reason ?? 'blocked'}`);
        return;
      }
      this.firePrePull(catalogId);
    } catch (err) {
      this.logger.warn(`[AppCredentials] pre-pull evaluation failed ${catalogId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Kick off an async model pull without awaiting. Subsequent calls for the same
   * model are ignored until the in-flight pull resolves (or errors).
   */
  private firePrePull(catalogId: string): void {
    if (this.pullsInFlight.has(catalogId)) {
      return;
    }
    this.pullsInFlight.add(catalogId);
    this.logger.info(`[AppCredentials] pre-pull start ${catalogId}`);
    void this.modelPuller
      .pullModel(catalogId)
      .then(() => {
        this.logger.info(`[AppCredentials] pre-pull complete ${catalogId}`);
      })
      .catch((err) => {
        this.logger.error(`[AppCredentials] pre-pull failed ${catalogId}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.pullsInFlight.delete(catalogId);
        this.invalidateCache();
      });
  }

  private escapeDotenvValue(value: string): string {
    if (/[\s"'#=]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
}
