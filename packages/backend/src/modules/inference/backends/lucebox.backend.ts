import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer } from './vllm.backend';
import { OpenAiCompatibleClient } from './openai-compatible.client';

/** Accept `http://host:8000`, `http://host:8000/` or `http://host:8000/v1`. */
export function normalizeLuceboxBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * The speculative inference server is normally started on the host. When an
 * operator enters localhost in a desktop/Hub container, resolve it to the
 * Docker host instead of probing the Hub container itself.
 */
export function resolveLuceboxProbeUrl(url: string, inContainer: boolean = detectHubContainer()): string {
  const normalized = normalizeLuceboxBaseUrl(url);
  if (!inContainer) return normalized;

  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
      parsed.hostname = 'host.docker.internal';
      return normalizeLuceboxBaseUrl(parsed.toString());
    }
  } catch {
    // Keep the normalized input; healthCheck will return the useful request error.
  }
  return normalized;
}

/**
 * This backend exposes a model-independent OpenAI-compatible API. Models are
 * loaded when the server starts, so the Hub discovers them but never pulls or
 * unloads them through a provider-specific lifecycle endpoint.
 */
@Injectable()
export class LuceboxBackend implements InferenceBackend {
  readonly type = 'lucebox' as const;
  private readonly api = new OpenAiCompatibleClient();

  constructor(private readonly logger: LoggerService) {}

  getBaseUrl(): string {
    const configured = process.env.SPECULATIVE_INFERENCE_URL?.trim() || process.env.LUCEBOX_URL?.trim();
    // The default deployment publishes host port 8000. Native launches and
    // remote servers can override this with SPECULATIVE_INFERENCE_URL.
    const defaultUrl = detectHubContainer() ? 'http://host.docker.internal:8000' : 'http://localhost:8000';
    return resolveLuceboxProbeUrl(configured || defaultUrl);
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    return this.api.healthCheck(this.getBaseUrl(), { healthPath: '/health', timeout: 5000 });
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      return await this.api.listModels(this.getBaseUrl());
    } catch {
      return [];
    }
  }

  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'Speculative inference models are configured when the server starts', percent: 100 });
    this.logger.info('[Speculative inference] Models are loaded from the server startup configuration; no pull was requested');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[Speculative inference] Load model request for ${modelId} — restart the server with the target model`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Speculative inference] Unload model request for ${modelId} — restart the server to change the target model`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return 'ghcr.io/luce-org/lucebox-hub:cuda12';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    const image = gpuVendor === 'amd' ? 'ghcr.io/luce-org/lucebox-hub:rocm' : this.getDockerImage();
    const base: Record<string, unknown> = {
      image,
      container_name: 'ci-hub-lucebox',
      restart: 'unless-stopped',
      // The image listens on 8080; 8000 is the host-facing API port.
      ports: ['8000:8080'],
      volumes: ['lucebox-models:/opt/lucebox-hub/server/models'],
    };

    if (gpuVendor === 'nvidia') {
      base.deploy = {
        resources: {
          reservations: { devices: [{ capabilities: ['gpu'], count: 'all' }] },
        },
      };
      base.runtime = 'nvidia';
    } else if (gpuVendor === 'amd') {
      base.devices = ['/dev/kfd', '/dev/dri'];
      base.group_add = ['video', 'render'];
      base.security_opt = ['seccomp=unconfined'];
    }

    return base;
  }
}
