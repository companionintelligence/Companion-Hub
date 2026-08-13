import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

@Injectable()
export class LemonadeBackend implements InferenceBackend {
  readonly type = 'lemonade' as const;
  private baseUrl: string;

  constructor(private readonly logger: LoggerService) {
    this.baseUrl = process.env.LEMONADE_URL || 'http://ci-hub-lemonade:13305';
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async healthCheck(_baseUrlOverride?: string, _apiKeyOverride?: string): Promise<BackendHealthStatus> {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/health`, { timeout: 5000 });
      if (response.status === 200) {
        const modelsResp = await axios.get(`${this.baseUrl}/v1/models`, { timeout: 5000 }).catch(() => ({ data: { data: [] } }));
        const models = modelsResp.data?.data ?? [];
        return {
          running: true,
          healthy: true,
          modelsLoaded: models.map((m: { id: string }) => m.id),
        };
      }
      return { running: true, healthy: false, modelsLoaded: [] };
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

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    this.logger.info(`[Lemonade] Pulling model: ${modelId}`);
    try {
      await axios.post(`${this.baseUrl}/v1/pull`, { model_name: modelId }, { timeout: 0 });
      onProgress?.({ status: 'complete', percent: 100 });
      this.logger.info(`[Lemonade] Model pulled: ${modelId}`);
    } catch (err) {
      this.logger.error(`[Lemonade] Pull failed for ${modelId}: ${err}`);
      throw err;
    }
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[Lemonade] Loading model: ${modelId}`);
    await axios.post(`${this.baseUrl}/v1/models/load`, { model: modelId }, { timeout: 120000 });
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Lemonade] Unloading model: ${modelId}`);
    await axios.post(`${this.baseUrl}/v1/models/unload`, { model: modelId }, { timeout: 30000 });
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  /** Detect NPU via Lemonade's system-info endpoint */
  async detectNpu(): Promise<{ available: boolean; model: string }> {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/system-info`, { timeout: 5000 });
      const npu = response.data?.npu;
      if (npu?.available) {
        return { available: true, model: npu.model || 'XDNA2' };
      }
      return { available: false, model: '' };
    } catch {
      return { available: false, model: '' };
    }
  }

  getDockerImage(): string {
    return 'ghcr.io/lemonade-sdk/lemonade-server:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    const base: Record<string, unknown> = {
      image: this.getDockerImage(),
      container_name: 'ci-hub-lemonade',
      restart: 'unless-stopped',
      ports: ['13305:13305'],
      volumes: ['lemonade-data:/root/.lemonade'],
    };

    if (gpuVendor === 'nvidia') {
      base.deploy = {
        resources: {
          reservations: { devices: [{ capabilities: ['gpu'], count: 'all' }] },
        },
      };
    } else if (gpuVendor === 'amd') {
      base.devices = ['/dev/kfd', '/dev/dri'];
      base.group_add = ['video', 'render'];
    }

    return base;
  }
}
