import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ModelRegistryService } from './model-registry.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { OllamaBackend } from './backends/ollama.backend';
import { CloudFallbackService } from './cloud-fallback.service';
import { recommendContextLength } from './context-length.util';

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
   * Hardware-aware default context window (num_ctx) for the chat model, in
   * tokens, as a string. Scaled to the host's memory and capped by the model's
   * window so apps don't inherit Ollama's oversized memory-based default.
   */
  CI_LLM_NUM_CTX?: string;
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
  ) {}

  async resolve(): Promise<StandardizedAiEnv> {
    const cloudProvider = this.cloudFallback.getEnabledProviders()[0];
    if (cloudProvider) {
      const env: StandardizedAiEnv = {};
      if (cloudProvider.baseUrl) env.CI_LLM_BASE_URL = cloudProvider.baseUrl;
      if (cloudProvider.apiKey) env.CI_LLM_API_KEY = cloudProvider.apiKey;
      if (cloudProvider.defaultModel) env.CI_CHAT_MODEL = cloudProvider.defaultModel;

      this.logger.info(
        `[InferenceEnvResolver] chat=${cloudProvider.defaultModel ?? 'none'} embedding=none vision=none ` +
          `baseUrl=${cloudProvider.baseUrl ?? 'none'} ollamaReady=skipped`,
      );

      return env;
    }

    const ollamaHealth = await this.ollamaBackend.healthCheck().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[InferenceEnvResolver] Ollama health check failed: ${message}`);
      return { running: false, healthy: false, modelsLoaded: [] as string[] };
    });
    const ollamaReady = !!(ollamaHealth.running && ollamaHealth.healthy);

    if (!ollamaReady) {
      this.logger.warn('[InferenceEnvResolver] Ollama unavailable and no cloud provider configured; omitting AI env.');
      return {};
    }

    const ollamaBaseUrl = this.ollamaBackend.getBaseUrl();
    const preferences = this.config.getInferencePreferences();
    const profile = await this.hardwareInspector.getProfile();

    // ── Base URL + API key ────────────────────────────────────────────────
    const baseUrl = `${ollamaBaseUrl}/v1`;
    const apiKey = 'ollama';

    // ── Chat model ────────────────────────────────────────────────────────
    let chatModel: string | undefined;
    let chatCurated: ReturnType<ModelRegistryService['getCuratedModel']>;
    const preferredId = preferences.preferredModel;
    if (preferredId) {
      chatCurated = this.modelRegistry.getCuratedModel(preferredId);
      chatModel = chatCurated?.backendModelId;
    }
    if (!chatModel) {
      const recommended = this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile);
      chatCurated = recommended.find((m) => m.modality === 'llm');
      chatModel = chatCurated?.backendModelId;
    }

    // ── Embedding model ───────────────────────────────────────────────────
    let embeddingModel: string | undefined;
    if (preferences.preferredEmbeddingModel) {
      const curated = this.modelRegistry.getCuratedModel(preferences.preferredEmbeddingModel);
      embeddingModel = curated?.backendModelId;
    }
    if (!embeddingModel) {
      const recommended = this.modelRegistry.getRecommendedEmbeddingModel(profile.tier);
      embeddingModel = recommended?.backendModelId;
    }

    // ── Vision model ──────────────────────────────────────────────────────
    let visionModel: string | undefined;
    if (preferences.preferredVisionModel) {
      const curated = this.modelRegistry.getCuratedModel(preferences.preferredVisionModel);
      if (curated?.metadata?.capabilities?.vision) {
        visionModel = curated.backendModelId;
      }
    }
    if (!visionModel) {
      const recommended = this.modelRegistry.getRecommendedVisionModel(profile.tier);
      visionModel = recommended?.backendModelId;
    }

    const env: StandardizedAiEnv = {
      CI_LLM_BASE_URL: baseUrl,
      CI_LLM_API_KEY: apiKey,
      OLLAMA_HOST: ollamaBaseUrl,
    };
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
      });
      env.CI_LLM_NUM_CTX = String(numCtx);
    }

    this.logger.info(
      `[InferenceEnvResolver] chat=${chatModel ?? 'none'} embedding=${embeddingModel ?? 'none'} ` +
        `vision=${visionModel ?? 'none'} baseUrl=${baseUrl} ollamaReady=${ollamaReady}`,
    );

    return env;
  }
}
