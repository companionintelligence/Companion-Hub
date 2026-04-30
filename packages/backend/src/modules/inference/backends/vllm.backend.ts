import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

@Injectable()
export class VllmBackend implements InferenceBackend {
  readonly type = 'vllm' as const;
  private baseUrl: string;

  constructor(private readonly logger: LoggerService) {
    this.baseUrl = process.env.VLLM_URL || 'http://ci-hub-vllm:8000';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/models`, { timeout: 5000 });
      const models = response.data?.data ?? [];
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m: { id: string }) => m.id),
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
      const response = await axios.get(`${this.baseUrl}/v1/models`, { timeout: 10000 });
      const models = response.data?.data ?? [];
      return models.map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id,
        size: 0,
        loaded: true,
      }));
    } catch {
      return [];
    }
  }

  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    // vLLM loads models at container startup via command-line args.
    // Pulling means downloading from HuggingFace to a shared volume.
    onProgress?.({ status: 'vLLM models are configured at container startup', percent: 100 });
    this.logger.info('[vLLM] Model configuration requires container restart with updated --model flag');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[vLLM] Load model request for ${modelId} — requires container restart with --model=${modelId}`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[vLLM] Unload model request for ${modelId} — requires container restart`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return 'vllm/vllm-openai:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    const base: Record<string, unknown> = {
      image: this.getDockerImage(),
      container_name: 'ci-hub-vllm',
      restart: 'unless-stopped',
      ports: ['8000:8000'],
      volumes: ['vllm-data:/root/.cache/huggingface'],
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
    }

    return base;
  }
}
