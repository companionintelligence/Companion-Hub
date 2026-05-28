import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { InferenceRouterService } from './inference-router.service';
import { ModelRegistryService } from './model-registry.service';
import { ModelPullerService } from './model-puller.service';
import { OllamaBackend } from './backends/ollama.backend';
import type { CuratedModel } from '@ci-hub/common/types';

export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw'] as const;
export type AppSlug = (typeof SUPPORTED_APP_SLUGS)[number];

export const SUPPORTED_API_VERSIONS = [1] as const;
export type ApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];
export const DEFAULT_API_VERSION: ApiVersion = 1;

export interface AppBootstrapConfig {
  app: AppSlug;
  apiVersion: ApiVersion;
  endpointUrl: string;
  endpointReady: boolean;
  llmModelId: string | null;
  llmBackendModelId: string | null;
  llmReady: boolean;
  embeddingsModelId: string | null;
  embeddingsBackendModelId: string | null;
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
};

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  config: AppBootstrapConfig;
  expiresAt: number;
}

@Injectable()
export class AppBootstrapService {
  /** In-memory bootstrap cache keyed by `${slug}:${apiVersion}`. */
  private cache = new Map<string, CacheEntry>();
  /** Catalog IDs currently pulling so we don't fire duplicate background pulls. */
  private pullsInFlight = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly inferenceRouter: InferenceRouterService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly modelPuller: ModelPullerService,
    private readonly ollamaBackend: OllamaBackend,
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
      throw new BadRequestException(`Unsupported bootstrap API version: ${candidate}. Supported: ${SUPPORTED_API_VERSIONS.join(', ')}`);
    }
    return parsed as ApiVersion;
  }

  async getBootstrap(slug: string, apiVersion: ApiVersion = DEFAULT_API_VERSION): Promise<AppBootstrapConfig> {
    if (!this.isSupported(slug)) {
      throw new NotFoundException(`Unknown app slug: ${slug}. Supported: ${SUPPORTED_APP_SLUGS.join(', ')}`);
    }

    const cacheKey = `${slug}:${apiVersion}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.logger.info(`[AppBootstrap] cache hit slug=${slug} v=${apiVersion} ttl=${Math.round((cached.expiresAt - now) / 1000)}s`);
      return cached.config;
    }

    const profile = await this.hardwareInspector.getProfile();
    const endpointUrl = this.inferenceRouter.getInferenceEndpoint();

    const endpointHealth = await this.ollamaBackend.healthCheck().catch((err) => {
      this.logger.error(`[AppBootstrap] Ollama health check threw: ${err instanceof Error ? err.message : String(err)}`);
      return { running: false, healthy: false, modelsLoaded: [] as string[] };
    });
    const endpointReady = !!(endpointHealth.running && endpointHealth.healthy);

    const llm = this.pickTopRunnableModel(this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile));
    // Embeddings picking was disabled in review feedback (a170aa9b). The explicit
    // `as CuratedModel | null` prevents TS from narrowing the constant to `null`
    // and breaking the downstream `if (embeddings)` branches — the picker can be
    // re-enabled without touching consumer code.
    const embeddings = null as CuratedModel | null;

    const llmReady = llm ? this.isModelPulled(llm.id, endpointHealth.modelsLoaded) : false;
    if (llm && !llmReady && endpointReady) {
      this.firePrePull(llm.id);
    }

    const keys = APP_ENV_KEYS[slug];
    const env: Record<string, string> = {
      [keys.baseUrl]: endpointUrl,
      [keys.apiKey]: 'ollama',
    };
    if (llm) {
      env[keys.model] = llm.id;
      env[`${keys.model}_BACKEND_ID`] = llm.backendModelId;
    }
    if (embeddings) {
      env[keys.embeddings] = embeddings.id;
      env[`${keys.embeddings}_BACKEND_ID`] = embeddings.backendModelId;
    }

    const managedKeys = Object.keys(env);

    this.logger.info(
      `[AppBootstrap] resolve slug=${slug} v=${apiVersion} endpoint=${endpointUrl} endpointReady=${endpointReady} ` +
        `llm=${llm?.id ?? 'none'} llmReady=${llmReady} embeddings=${embeddings?.id ?? 'none'}`,
    );

    const config: AppBootstrapConfig = {
      app: slug,
      apiVersion,
      endpointUrl,
      endpointReady,
      llmModelId: llm?.id ?? null,
      llmBackendModelId: llm?.backendModelId ?? null,
      llmReady,
      embeddingsModelId: embeddings?.id ?? null,
      embeddingsBackendModelId: embeddings?.backendModelId ?? null,
      env,
      managedKeys,
    };

    this.cache.set(cacheKey, { config, expiresAt: now + CACHE_TTL_MS });
    return config;
  }

  serializeAsDotenv(config: AppBootstrapConfig): string {
    return (
      Object.entries(config.env)
        .map(([k, v]) => `${k}=${this.escapeDotenvValue(v)}`)
        .join('\n') + '\n'
    );
  }

  /** Clear the per-slug cache. Tests + admin endpoints can use this. */
  invalidateCache(): void {
    this.cache.clear();
  }

  private pickTopRunnableModel(candidates: CuratedModel[]): CuratedModel | null {
    return candidates[0] ?? null;
  }

  private isModelPulled(catalogId: string, modelsLoaded: string[]): boolean {
    const tracked = this.modelRegistry.getTrackedModel(catalogId);
    if (tracked && (tracked.state === 'pulled' || tracked.state === 'loaded' || tracked.state === 'pinned')) {
      return true;
    }
    const curated = this.modelRegistry.getCuratedModel(catalogId);
    if (!curated) return false;
    return modelsLoaded.some((name) => name === curated.backendModelId || name.startsWith(`${curated.backendModelId}:`));
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
    this.logger.info(`[AppBootstrap] pre-pull start ${catalogId}`);
    void this.modelPuller
      .pullModel(catalogId)
      .then(() => {
        this.logger.info(`[AppBootstrap] pre-pull complete ${catalogId}`);
      })
      .catch((err) => {
        this.logger.error(`[AppBootstrap] pre-pull failed ${catalogId}: ${err instanceof Error ? err.message : String(err)}`);
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
