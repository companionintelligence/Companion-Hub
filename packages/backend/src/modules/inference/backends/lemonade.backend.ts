import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
// Shared with the Lucebox and Ollama backends: all three mount the same AMD device nodes and so
// need the same host GIDs. See that module for the full rationale.
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from './amd-device-groups.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';

/** Extra deployment hints beyond the shared `{ rocmReady, unifiedMemory }` pair. */
export interface LemonadeComposeOptions {
  rocmReady?: boolean;
  unifiedMemory?: boolean;
  /**
   * Numeric host GIDs owning `/dev/kfd` and `/dev/dri/*`; derived from `/dev` when omitted.
   * Supply these when generating the config somewhere other than the GPU host, where the
   * device nodes cannot be statted.
   */
  groupIds?: number[];
  /** Test seam for {@link resolveAmdDeviceGroupIds}. */
  deviceProbe?: DeviceGroupProbe;
}

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

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/health`, { timeout: 5000 });
      if (response.status === 200) {
        const models = await new OpenAiCompatibleClient().listModelIds(this.baseUrl, { timeout: 5000 }).catch(() => []);
        return {
          running: true,
          healthy: true,
          modelsLoaded: models,
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
      return await new OpenAiCompatibleClient().listModels(this.baseUrl);
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
    await axios.post(`${this.baseUrl}/v1/load`, { model_name: modelId }, { timeout: 120000 });
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Lemonade] Unloading model: ${modelId}`);
    await axios.post(`${this.baseUrl}/v1/unload`, { model_name: modelId }, { timeout: 30000 });
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

  /**
   * `options.groupIds` / `options.deviceProbe` only affect the `amd` branch; see the comment
   * there for why group *names* cannot be used.
   */
  getComposeConfig(gpuVendor: string, options?: LemonadeComposeOptions): Record<string, unknown> {
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

      // `group_add: ['video', 'render']` is a silent failure: Docker resolves those *names*
      // against the **container's** /etc/group (render is typically GID 109), not the host's,
      // where the group owning /dev/kfd and /dev/dri/renderD128 is site-specific — 990 across
      // the Strix Halo fleet, with video at 44. The container joined a group granting nothing
      // and every GPU device open failed with EACCES. Stat the nodes the service actually
      // mounts instead; that is correct on any host.
      const groupIds = options?.groupIds ?? resolveAmdDeviceGroupIds(options?.deviceProbe);
      if (groupIds.length > 0) {
        base.group_add = groupIds.map(String);
      } else {
        // Unlike Lucebox — GPU-only, so a permission-less config is worthless and it throws —
        // Lemonade also serves on CPU and on the Ryzen AI NPU (see detectNpu), and its container
        // runs as root (note the /root/.lemonade data volume), where Docker's default
        // CAP_DAC_OVERRIDE makes group membership not the only path to the device nodes. Emitting
        // no `group_add` keeps the deployment viable and honest; emitting the names would not.
        this.logger.warn(
          '[Lemonade] Could not derive host GIDs for /dev/kfd and /dev/dri, so the AMD compose config omits group_add. ' +
            'If the container is run as a non-root user it will fail to open the GPU devices — generate this on the GPU ' +
            'host, or pass groupIds explicitly.',
        );
      }
    }

    return base;
  }
}
