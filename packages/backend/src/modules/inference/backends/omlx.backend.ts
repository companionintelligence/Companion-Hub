import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, normalizeHostBackendUrl, resolveHostBackendProbeUrl } from './host-url.util';
import { foreignEngineHealth, openAiModelIds } from './engine-identity';
import { OpenAiCompatibleClient } from './openai-compatible.client';

/**
 * oMLX (github.com/jundot/omlx) is the Apple Silicon MLX server.
 *
 * Install, copied from that repo's README: `brew tap jundot/omlx https://github.com/jundot/omlx`
 * then `brew install jundot/omlx/omlx`, then `omlx start`. The server speaks OpenAI at
 * `http://localhost:8000/v1`, including `/v1/embeddings`. There is no Docker image.
 */
export const OMLX_DEFAULT_PORT = 8000;

export const OMLX_INSTALL_COMMAND = 'brew tap jundot/omlx https://github.com/jundot/omlx && brew install jundot/omlx/omlx && omlx start';

export function buildOmlxRemediation(): { command: string; hint: string } {
  return {
    command: OMLX_INSTALL_COMMAND,
    hint:
      'oMLX runs on Apple Silicon (macOS 15+) and serves MLX weights from Hugging Face through an OpenAI-compatible API, including embeddings. ' +
      'Install from https://github.com/jundot/omlx with the command above. `omlx serve --model-dir ~/models` runs it in the foreground instead.',
  };
}

export const resolveOmlxProbeUrl = resolveHostBackendProbeUrl;

@Injectable()
export class OmlxBackend implements InferenceBackend {
  readonly type = 'omlx' as const;
  private readonly api = new OpenAiCompatibleClient();

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  getBaseUrl(): string {
    const configured = this.configuration.getInferencePreferences().preferredOmlxUrl?.trim();
    const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
    return resolveOmlxProbeUrl(configured || process.env.OMLX_URL || `http://${host}:${OMLX_DEFAULT_PORT}`);
  }

  getApiKey(): string | undefined {
    return process.env.OMLX_API_KEY?.trim() || undefined;
  }

  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveOmlxProbeUrl(normalizeHostBackendUrl(baseUrlOverride)) : this.getBaseUrl();
    try {
      const body = await this.api.fetchModels(baseUrl, { timeout: 5000, apiKey: this.getApiKey() });
      const foreign = foreignEngineHealth('omlx', body, baseUrl);
      if (foreign) return foreign;
      return { running: true, healthy: true, modelsLoaded: openAiModelIds(body) };
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
      return await this.api.listModels(this.getBaseUrl(), { timeout: 10000, apiKey: this.getApiKey(), claimedBy: 'omlx' });
    } catch {
      return [];
    }
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'Download MLX weights in oMLX (admin) or with a Hugging Face login on this machine', percent: 100 });
    this.logger.info(`[oMLX] Model ${modelId} is downloaded by oMLX from Hugging Face, not by the Hub`);
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Load ${modelId} from the oMLX admin UI or by placing the MLX checkpoint in the model directory`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Unload ${modelId} from the oMLX admin UI`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    throw new Error('oMLX has no Docker image. Install it on the Apple Silicon host and point the Hub at http://host.docker.internal:8000.');
  }

  getComposeConfig(): Record<string, unknown> {
    throw new Error('oMLX has no Docker path. It runs on the Apple Silicon host (brew install jundot/omlx/omlx && omlx start).');
  }
}
