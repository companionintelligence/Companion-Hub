import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { OllamaBackend } from './backends/ollama.backend';
import { VllmBackend } from './backends/vllm.backend';
import { LemonadeBackend } from './backends/lemonade.backend';
import { MtplxBackend } from './backends/mtplx.backend';
import { DsparkBackend } from './backends/dspark.backend';
import type { InferenceBackend } from './backends/backend.interface';
import { CloudFallbackService } from './cloud-fallback.service';
import { recommendContextLength } from './context-length.util';
import { isCatalogModelInstalled } from './model-availability.util';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';

/** Non-secret placeholder API key each backend's OpenAI-compatible surface accepts (none validate it). */
export const BACKEND_API_KEY: Record<InferenceBackendType, string> = {
  ollama: 'ollama',
  vllm: 'vllm',
  lemonade: 'lemonade',
  mtplx: 'mtplx',
  dspark: 'dspark',
};

/**
 * Standardized AI environment variables injected into an app's `app.env` when
 * that app opts in via `hub_integration.inference`.
 *
 * These follow a `CI_` prefix convention so apps can discover inference
 * capabilities uniformly — regardless of whether the Hub is using a local
 * Ollama instance or a cloud provider.
 */
export interface StandardizedAiEnv {
  /** OpenAI-compatible base URL (Ollama `/v1` or cloud provider). */
  CI_LLM_BASE_URL?: string;
  /** API key for the base URL. `"ollama"` for local Ollama. */
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
   * tokens, as a string. Scaled to the host's memory and capped by the model's
   * window so apps don't inherit Ollama's oversized memory-based default.
   */
  CI_LLM_NUM_CTX?: string;
  /** Active inference backend (`ollama` | `vllm` | `lemonade` | `mtplx` | `dspark` | `cloud`). */
  CI_INFERENCE_BACKEND?: string;
  /** Every enabled cloud provider (CI_CLOUD_* + conventional aliases). Additive. */
  cloudProviderEnv?: Record<string, string>;
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
    private readonly vllmBackend: VllmBackend,
    private readonly lemonadeBackend: LemonadeBackend,
    private readonly mtplxBackend: MtplxBackend,
    private readonly dsparkBackend: DsparkBackend,
    private readonly cloudFallback: CloudFallbackService,
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
    }
  }

  /**
   * @param options.minContextLength App-specific floor for the recommended Ollama
   *   context window (tokens). Apps with a hard minimum (e.g. Hermes' 64K) pass it
   *   so this path applies the same floor as the credentials.env endpoint. Omit for
   *   apps with no minimum — the pure hardware ladder is used.
   */
  async resolve(options?: { minContextLength?: number }): Promise<StandardizedAiEnv> {
    const cloudProviderEnv = this.cloudFallback.toAppEnv();
    const cloudProviders = this.cloudFallback.getEnabledProviders();
    const fallbackCloud = cloudProviders[0];

    const preferences = this.config.getInferencePreferences();
    const backendType = preferences.preferredBackend ?? 'ollama';
    const backend = this.getBackend(backendType);

    const backendHealth = await backend.healthCheck().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[InferenceEnvResolver] ${backendType} health check failed: ${message}`);
      return { running: false, healthy: false, modelsLoaded: [] as string[] };
    });
    const backendReady = !!(backendHealth.running && backendHealth.healthy);

    if (!backendReady) {
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
    const baseUrl = `${backendBaseUrl}/v1`;
    const configuredVllmKey = preferences.preferredVllmApiKey?.trim();
    const apiKey = backendType === 'vllm' && configuredVllmKey ? configuredVllmKey : BACKEND_API_KEY[backendType];

    // ── Chat model ────────────────────────────────────────────────────────
    // Prefer a model that is actually present on the active backend: this env is
    // written into an app's app.env with no pre-pull on this path, so naming a
    // merely-recommended (but unpulled) model would 404 on the app's first
    // request. Resolution: preference-if-installed-on-this-backend → best
    // installed recommended model on this backend → previous behavior
    // (preference, then top recommendation) as a last resort when nothing on
    // this backend is pulled yet.
    const modelsLoaded = backendHealth.modelsLoaded ?? [];
    const preferredId = preferences.preferredModel;
    const preferredCurated = preferredId ? this.modelRegistry.getCuratedModel(preferredId) : undefined;
    const backendPreferredCurated = preferredCurated?.backend === backendType ? preferredCurated : undefined;
    const llmCandidates = this.modelRegistry
      .getRecommendedModelsForHardware(profile.tier, profile)
      .filter((m) => m.modality === 'llm' && m.backend === backendType);

    let chatCurated: CuratedModel | undefined;
    if (backendPreferredCurated && this.isInstalled(backendPreferredCurated, modelsLoaded)) {
      chatCurated = backendPreferredCurated;
    } else {
      chatCurated = llmCandidates.find((m) => this.isInstalled(m, modelsLoaded));
    }
    if (!chatCurated) {
      chatCurated = backendPreferredCurated ?? llmCandidates[0];
      if (chatCurated) {
        this.logger.warn(
          `[InferenceEnvResolver] no recommended ${backendType} chat model is pulled yet; ` +
            `emitting ${chatCurated.backendModelId} — apps will 404 until it is pulled.`,
        );
      }
    }
    let chatModel = chatCurated?.backendModelId;
    // Host-managed vLLM/Lemonade can serve models outside the Hub catalog (e.g. an
    // operator's existing `vllm serve` on :8000). When nothing catalog-shaped matches
    // but the backend reports loaded models, emit the first runtime id so apps get a
    // working default instead of omitting CI_CHAT_MODEL entirely.
    if (chatModel && modelsLoaded.length > 0 && backendType !== 'ollama' && !modelsLoaded.includes(chatModel)) {
      const runtimeModel = modelsLoaded[0];
      this.logger.info(`[InferenceEnvResolver] catalog chat model ${chatModel} is not loaded on ${backendType}; using runtime ${runtimeModel}`);
      chatModel = runtimeModel;
    } else if (!chatModel && modelsLoaded.length > 0 && backendType !== 'ollama') {
      chatModel = modelsLoaded[0];
      this.logger.info(`[InferenceEnvResolver] no catalog ${backendType} chat model matched runtime; using ${chatModel}`);
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

    let embeddingModel = resolveEmbedding(backendType);
    let embedHost = backendType === 'ollama' ? backendBaseUrl : undefined;
    if (backendType !== 'ollama') {
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
      CI_LLM_API_KEY: apiKey,
      CI_INFERENCE_BACKEND: backendType,
    };
    // OLLAMA_HOST is Ollama's native (non-OpenAI-compatible) protocol URL — only meaningful,
    // and only ever populated, when Ollama is the active backend.
    if (backendType === 'ollama') env.OLLAMA_HOST = backendBaseUrl;
    // The embeddings host, by contrast, points at Ollama whenever one is healthy —
    // even when chat runs on another backend (split-backend embeddings).
    if (embedHost) env.CI_OLLAMA_EMBED_HOST = embedHost;
    if (chatModel) env.CI_CHAT_MODEL = chatModel;
    if (embeddingModel) env.CI_EMBEDDING_MODEL = embeddingModel;
    if (visionModel) env.CI_VISION_MODEL = visionModel;

    // Hardware-aware context window for the chat model, so apps don't inherit
    // Ollama's oversized memory-based default (e.g. 262144 on unified-memory APUs).
    if (chatCurated) {
      const numCtx = recommendContextLength({
        effectiveInferenceMemoryMb: profile.effectiveInferenceMemoryMb,
        modelFootprintMb: chatCurated.runtime.memoryFootprintMb,
        modelContextWindow: chatCurated.runtime.contextWindow,
        minContextLength: options?.minContextLength,
      });
      env.CI_LLM_NUM_CTX = String(numCtx);
    }

    if (Object.keys(cloudProviderEnv).length > 0) {
      env.cloudProviderEnv = cloudProviderEnv;
    }

    this.logger.info(
      `[InferenceEnvResolver] backend=${backendType} chat=${chatModel ?? 'none'} embedding=${embeddingModel ?? 'none'} ` +
        `vision=${visionModel ?? 'none'} baseUrl=${baseUrl} backendReady=${backendReady} ` +
        `cloudProviders=${cloudProviders.length}`,
    );

    return env;
  }

  /** True when the model is on disk on the active backend or tracked as pulled/loaded/pinned in the registry. */
  private isInstalled(model: CuratedModel, modelsLoaded: string[]): boolean {
    const tracked = this.modelRegistry.getTrackedModel(model.id);
    const trackedPulled = tracked?.state === 'pulled' || tracked?.state === 'loaded' || tracked?.state === 'pinned';
    return isCatalogModelInstalled(model, modelsLoaded, trackedPulled);
  }
}
