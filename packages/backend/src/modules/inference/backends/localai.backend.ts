import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, resolveHostBackendProbeUrl } from './host-url.util';
import { openAiModelIds } from './engine-identity';
import { OpenAiCompatibleClient } from './openai-compatible.client';

export const LOCALAI_DEFAULT_PORT = 8080;

export const resolveLocalAiProbeUrl = resolveHostBackendProbeUrl;

export function localAiBaseUrl(savedUrl?: string | null): string {
  if (savedUrl?.trim()) return resolveLocalAiProbeUrl(savedUrl.trim());
  if (process.env.LOCALAI_URL?.trim()) return resolveLocalAiProbeUrl(process.env.LOCALAI_URL.trim());
  const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
  return `http://${host}:${LOCALAI_DEFAULT_PORT}`;
}

@Injectable()
export class LocalAiBackend implements InferenceBackend {
  readonly type = 'localai' as const;
  private readonly api = new OpenAiCompatibleClient();

  constructor(private readonly logger: LoggerService) {}

  getBaseUrl(): string {
    return localAiBaseUrl();
  }

  getApiKey(apiKeyOverride?: string): string | undefined {
    return apiKeyOverride?.trim() || process.env.LOCALAI_API_KEY?.trim() || undefined;
  }

  async healthCheck(baseUrlOverride?: string, apiKeyOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveLocalAiProbeUrl(baseUrlOverride) : this.getBaseUrl();
    const apiKey = this.getApiKey(apiKeyOverride);

    try {
      const body = await this.api.fetchModels(baseUrl, { timeout: 5000, apiKey });
      return {
        running: true,
        healthy: true,
        modelsLoaded: openAiModelIds(body),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const hint = status === 401 ? 'LocalAI rejected or requires an API key — set LOCALAI_API_KEY.' : undefined;
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: hint ? `${message}. ${hint}` : message,
      };
    }
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      return await this.api.listModels(this.getBaseUrl(), {
        timeout: 10000,
        apiKey: this.getApiKey(),
      });
    } catch {
      return [];
    }
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: `LocalAI models are managed via model gallery or compose configuration: ${modelId}`, percent: 100 });
    this.logger.info(`[LocalAI] Model installation requested for ${modelId}`);
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[LocalAI] Load model requested for ${modelId}`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[LocalAI] Unload model requested for ${modelId}`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return 'localai/localai:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    const config: Record<string, unknown> = {
      image: this.getDockerImage(),
      restart: 'unless-stopped',
      ports: [`${LOCALAI_DEFAULT_PORT}:${LOCALAI_DEFAULT_PORT}`],
      environment: {
        DEBUG: 'true',
        MODELS_PATH: '/models',
      },
      volumes: ['localai-models:/models'],
    };

    if (gpuVendor === 'nvidia') {
      config.deploy = {
        resources: {
          reservations: {
            devices: [{ driver: 'nvidia', count: 'all', capabilities: ['gpu'] }],
          },
        },
      };
    }

    return config;
  }
}
