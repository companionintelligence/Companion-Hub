import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { normalizeHostBackendUrl, resolveHostBackendProbeUrl } from './host-url.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import axios from 'axios';

export const MLX_DEFAULT_PORT = 8080;

/** Accept `http://host:8080`, `http://host:8080/` or `http://host:8080/v1`. */
export const normalizeMlxBaseUrl = normalizeHostBackendUrl;

/** Resolve a host-run MLX-LM URL from inside the Hub container. */
export const resolveMlxProbeUrl = resolveHostBackendProbeUrl;

export interface MlxRemediation {
  /** Copy-pasteable command to install and start mlx-lm on Apple Silicon. */
  command: string;
  /** Setup guidance without the trailing probe-URL sentence. */
  hint: string;
}

export function buildMlxRemediation(): MlxRemediation {
  return {
    command: 'python3 -m pip install -U mlx-lm && mlx_lm.server --model mlx-community/Qwen3-8B-4bit --host 0.0.0.0 --port 8080',
    hint:
      'Run mlx-lm natively on an Apple Silicon host (macOS 14+). The server downloads the selected model into the local Hugging Face cache; ' +
      'restart it with a different `--model` value to switch models.',
  };
}

@Injectable()
export class MlxBackend implements InferenceBackend {
  readonly type = 'mlx' as const;

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * MLX-LM is a native host process, not a Hub-managed container. Settings wins
   * over MLX_URL and is read per call so a saved URL takes effect immediately.
   */
  getBaseUrl(): string {
    const configured = this.configuration.getInferencePreferences().preferredMlxUrl?.trim();
    return resolveMlxProbeUrl(configured || process.env.MLX_URL || `http://127.0.0.1:${MLX_DEFAULT_PORT}`);
  }

  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveMlxProbeUrl(baseUrlOverride) : this.getBaseUrl();
    try {
      // `/health` is the lightweight readiness route exposed by mlx_lm.server.
      await axios.get(`${baseUrl}/health`, { timeout: 5000 });
      const models = await new OpenAiCompatibleClient(baseUrl).listModels(5000);
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((model) => model.id),
      };
    } catch (err) {
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      const models = await new OpenAiCompatibleClient(this.getBaseUrl()).listModels();
      return models.map((model) => ({
        id: model.id,
        name: model.id,
        size: 0,
        loaded: true,
      }));
    } catch {
      return [];
    }
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    // mlx_lm.server downloads the model named by --model during startup. It
    // has no pull endpoint, so the Hub must not pretend to own this lifecycle.
    onProgress?.({ status: 'MLX models are downloaded when mlx_lm.server starts', percent: 100 });
    this.logger.info(`[MLX] Model ${modelId} must be selected with mlx_lm.server --model and restarted`);
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[MLX] Load model request for ${modelId} — restart mlx_lm.server with --model=${modelId}`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[MLX] Unload model request for ${modelId} — stop or restart mlx_lm.server`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    throw new Error('MLX-LM has no Docker path — run mlx_lm.server natively on Apple Silicon and configure its URL instead.');
  }

  getComposeConfig(): Record<string, unknown> {
    throw new Error(
      'MLX-LM is an Apple-Silicon-native host process with no Docker/Metal passthrough path. ' +
        'Install mlx-lm natively and point Settings → MLX URL at its OpenAI-compatible server.',
    );
  }
}
