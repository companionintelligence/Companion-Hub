import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend, LoadModelOptions } from './backend.interface';
import type { BackendHealthStatus, BackendResidency, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
// Shared with the Ollama backend: both mount the same AMD device nodes and so
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

/**
 * Catalog models the Hub installs into Lemonade from Hugging Face because Lemonade's own registry does
 * not carry them, keyed by the public id Lemonade then lists them under (the `user.` namespace is
 * dropped from `/v1/models`). `/v1/pull` with a `user.*` name, a recipe and a checkpoint registers and
 * downloads in one call; loads and requests use the public id. Verified against lemonade-server
 * 2026.39.1, 2026-09-29.
 */
export const LEMONADE_REGISTRATIONS: Readonly<Record<string, Record<string, unknown>>> = {
  // The embedder every install shares; see the 2026-09-29 note above EXTRAS_TOON in curated-models.ts.
  'nomic-embed-text-v1.5-GGUF': {
    model_name: 'user.nomic-embed-text-v1.5-GGUF',
    recipe: 'llamacpp',
    checkpoint: 'nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.f16.gguf',
    embedding: true,
  },
};

@Injectable()
export class LemonadeBackend implements InferenceBackend {
  readonly type = 'lemonade' as const;
  private baseUrl: string;

  constructor(private readonly logger: LoggerService) {
    this.baseUrl = process.env.LEMONADE_URL || 'http://ci-hub-lemonade:13305';
  }

  getBaseUrl(): string {
    return process.env.LEMONADE_URL || this.baseUrl;
  }

  getApiKey(): string | undefined {
    return process.env.LEMONADE_API_KEY?.trim() || undefined;
  }

  private authHeaders(): Record<string, string> | undefined {
    const key = this.getApiKey();
    return key ? { Authorization: `Bearer ${key}` } : undefined;
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const baseUrl = this.getBaseUrl();
      const apiKey = this.getApiKey();
      const auth = this.authHeaders();
      const response = await axios.get(`${baseUrl}/v1/health`, {
        timeout: 5000,
        ...(auth ? { headers: auth } : {}),
      });
      if (response.status === 200) {
        const models = await new OpenAiCompatibleClient().listModelIds(baseUrl, { timeout: 5000, apiKey }).catch(() => []);
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
      return await new OpenAiCompatibleClient().listModels(this.getBaseUrl(), { apiKey: this.getApiKey() });
    } catch {
      return [];
    }
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    this.logger.info(`[Lemonade] Pulling model: ${modelId}`);
    try {
      const auth = this.authHeaders();
      // A model the Hub installs from Hugging Face is registered by the same call that downloads it.
      const body = LEMONADE_REGISTRATIONS[modelId] ?? { model_name: modelId };
      await axios.post(`${this.getBaseUrl()}/v1/pull`, body, { timeout: 0, ...(auth ? { headers: auth } : {}) });
      onProgress?.({ status: 'complete', percent: 100 });
      this.logger.info(`[Lemonade] Model pulled: ${modelId}`);
    } catch (err) {
      this.logger.error(`[Lemonade] Pull failed for ${modelId}: ${err}`);
      throw err;
    }
  }

  /**
   * Lemonade sizes an unspecified context itself, from the card's TOTAL memory: 220509 tokens for
   * a 27B on a 24 GiB 7900 XTX, whether or not Ollama already held 17 GiB of it — which is how
   * the two together froze that machine on 2026-09-29. So the window is always sent, and also
   * saved as the model's own option: Lemonade loads models by itself too (an inference request for
   * one that is not resident), and those loads read the saved value, not this call.
   */
  async loadModel(modelId: string, options?: LoadModelOptions): Promise<void> {
    const window = options?.embedding || !options?.contextLength ? null : options.contextLength;
    this.logger.info(`[Lemonade] Loading model: ${modelId}${window ? ` at ctx_size ${window}` : ''}`);
    const auth = this.authHeaders();
    const config = { ...(auth ? { headers: auth } : {}) };
    if (window) {
      // Merges into the saved entry, leaving every other option alone; never loads anything.
      await axios
        .post(`${this.getBaseUrl()}/v1/models/${encodeURIComponent(modelId)}/options`, { ctx_size: window }, { timeout: 10000, ...config })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[Lemonade] Could not save ctx_size ${window} for ${modelId}; Lemonade's own loads of it will size themselves: ${msg}`);
        });
    }
    await axios.post(
      `${this.getBaseUrl()}/v1/load`,
      { model_name: modelId, ...(window ? { ctx_size: window } : {}) },
      { timeout: 120000, ...config },
    );
  }

  /**
   * The model's files as Lemonade lists them (`GET /v1/models/{id}/files`): the weights and, for a
   * vision model, the mmproj it loads beside them — both occupy the card. Null when Lemonade cannot
   * say, or has not downloaded the model yet.
   */
  async weightsOnDiskMb(modelId: string): Promise<number | null> {
    const auth = this.authHeaders();
    try {
      const response = await axios.get(`${this.getBaseUrl()}/v1/models/${encodeURIComponent(modelId)}/files`, {
        timeout: 5000,
        ...(auth ? { headers: auth } : {}),
      });
      const files = response.data?.files;
      if (!Array.isArray(files)) return null;
      const bytes = (files as { exists?: boolean; size_bytes?: number }[])
        .filter((file) => file.exists !== false && typeof file.size_bytes === 'number' && file.size_bytes > 0)
        .reduce((sum, file) => sum + (file.size_bytes as number), 0);
      return bytes > 0 ? Math.round(bytes / (1024 * 1024)) : null;
    } catch {
      return null;
    }
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Lemonade] Unloading model: ${modelId}`);
    const auth = this.authHeaders();
    await axios.post(`${this.getBaseUrl()}/v1/unload`, { model_name: modelId }, { timeout: 30000, ...(auth ? { headers: auth } : {}) });
  }

  /**
   * What Lemonade currently holds loaded, from the body of `/v1/health`.
   *
   * `healthCheck()` above already calls this endpoint and throws the body away, taking its
   * `modelsLoaded` from `/v1/models` instead — which is the OpenAI-compatible INVENTORY, so
   * lemonade inherits the same "loaded means available" confusion as every other backend.
   * The health body carries the real thing: `all_models_loaded`, an array of per-model
   * records with `loaded`, `status`, `backend_alive` and `device`.
   *
   * Deliberately defensive. If `all_models_loaded` is absent — an older lemonade, or a shape
   * that differs from the one observed — this reports `unsupported` rather than falling back
   * to the inventory. On a route whose entire purpose is not overstating what was measured,
   * "this build cannot tell me" is a correct answer and a guess is not.
   *
   * Lemonade exposes NO per-model memory figure. Its only memory numbers are host-wide, and
   * on a unified-memory APU the host baseline drifts by gigabytes with no residency change at
   * all, so no delta can be attributed to a model even in principle. `engineGpuBytes` and
   * `totalBytes` are therefore null, not zero.
   */
  async listResident(): Promise<BackendResidency> {
    try {
      const auth = this.authHeaders();
      const response = await axios.get(`${this.getBaseUrl()}/v1/health`, {
        timeout: 5000,
        ...(auth ? { headers: auth } : {}),
      });
      const records = response.data?.all_models_loaded;

      if (!Array.isArray(records)) {
        return { backend: this.type, source: 'unsupported', models: null };
      }

      const resident = (records as { model_name?: string; checkpoint?: string; loaded?: boolean; status?: string; backend_alive?: boolean }[])
        // All three conditions, not just `loaded`: a record can be marked loaded while its
        // backend process is gone, which is precisely the false "resident" to avoid.
        .filter((record) => record.loaded === true && record.status === 'ready' && record.backend_alive !== false)
        .map((record) => ({
          id: record.model_name ?? record.checkpoint ?? 'unknown',
          engineGpuBytes: null,
          totalBytes: null,
          expiresAt: null,
          contextLength: null,
          quantization: null,
        }));

      return { backend: this.type, source: 'measured', models: resident };
    } catch (err) {
      return {
        backend: this.type,
        source: 'unreachable',
        models: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  /** Detect NPU via Lemonade's system-info endpoint */
  async detectNpu(): Promise<{ available: boolean; model: string }> {
    try {
      const auth = this.authHeaders();
      const response = await axios.get(`${this.getBaseUrl()}/v1/system-info`, {
        timeout: 5000,
        ...(auth ? { headers: auth } : {}),
      });
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
        // Unlike GPU-only backends where a permission-less config is worthless and throws —
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
