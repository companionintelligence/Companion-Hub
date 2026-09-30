import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { EngineCapabilities, InferenceBackend, LoadModelOptions } from './backend.interface';
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

/** One entry of `/v1/health` `all_models_loaded`; every field optional, since the two versions differ (see `listResident`). */
interface LemonadeLoadedRecord {
  model_name?: string;
  checkpoint?: string;
  type?: string;
  loaded?: boolean;
  status?: string;
  backend_alive?: boolean;
  recipe_options?: unknown;
}

/** A model's saved `recipe_options` object from `/v1/models/{id}` or a health record, `{}` when none are saved; null when the field is absent. */
function recipeOptionsOf(record: { recipe_options?: unknown }): Record<string, unknown> | null {
  const options = record.recipe_options;
  return options && typeof options === 'object' && !Array.isArray(options) ? (options as Record<string, unknown>) : null;
}

/** A `ctx_size` Lemonade will run: a positive integer. `-1` (and absent) is "size it yourself". */
function positiveWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

@Injectable()
export class LemonadeBackend implements InferenceBackend {
  readonly type = 'lemonade' as const;
  private baseUrl: string;
  /** Saved window of each LLM Lemonade held at the last residency read; null when that read failed. */
  private residentWindows: Map<string, number> | null = null;

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
   * Lemonade sizes an unspecified context itself — from the card's TOTAL memory on 2026.x (220509
   * tokens for a 27B on a 24 GiB 7900 XTX, whether or not Ollama already held 17 GiB of it, which is
   * how the two together froze that machine on 2026-09-29), from a fixed 4096 on the fleet's 10.2.0.
   * So the window is always sent, and also saved as the model's own option: Lemonade loads models by
   * itself too (an inference request for one that is not resident), and those loads read the saved
   * value, not this call.
   *
   * Saved with `save_options` on the load itself, the one way both versions have: 10.2.0 has no
   * `/v1/models/{id}/options` route, so posting there 404'd on every fleet node and the window was
   * never saved. 10.2.0's `save_options` also replaces the model's saved options with the request's
   * rather than merging them, so the options already saved are read first and sent back beside the
   * new `ctx_size` — an operator's `llamacpp_backend` choice survives the Hub's load. When they cannot
   * be read, the load still goes at the window but saves nothing, rather than wiping them.
   */
  async loadModel(modelId: string, options?: LoadModelOptions): Promise<void> {
    const window = options?.embedding || !options?.contextLength ? null : options.contextLength;
    this.logger.info(`[Lemonade] Loading model: ${modelId}${window ? ` at ctx_size ${window}` : ''}`);
    const auth = this.authHeaders();
    const config = { ...(auth ? { headers: auth } : {}) };
    let body: Record<string, unknown> = { model_name: modelId };
    if (window) {
      const saved = await this.readModelInfo(modelId);
      const savedOptions = saved ? recipeOptionsOf(saved) : null;
      if (savedOptions) {
        body = { ...savedOptions, model_name: modelId, ctx_size: window, save_options: true };
      } else {
        this.logger.warn(
          `[Lemonade] Could not read ${modelId}'s saved options, so ctx_size ${window} is used for this load but not saved; ` +
            "Lemonade's own loads of it keep whatever window it had.",
        );
        body = { model_name: modelId, ctx_size: window };
      }
    }
    await axios.post(`${this.getBaseUrl()}/v1/load`, body, { timeout: 120000, ...config });
  }

  /**
   * The window Lemonade serves `modelId` at whatever a request asks — its saved `ctx_size` — or null
   * when none is saved (Lemonade then sizes it itself) or Lemonade cannot be asked. A handout for a
   * Lemonade model must not promise more than this; see `capHandoutAtServedWindow`.
   */
  async servedContextLength(modelId: string): Promise<number | null> {
    const info = await this.readModelInfo(modelId);
    return info ? positiveWindow(recipeOptionsOf(info)?.ctx_size) : null;
  }

  /**
   * Lemonade states no slot count, and one `ctx_size` per model rather than per request: `contextLength`
   * is the saved window of the LLM it holds — the smallest, when it holds more than one — from the
   * last residency read, so pool placement can keep a request larger than that off this engine.
   * Null when that read did not reach Lemonade.
   */
  engineCapabilities(): EngineCapabilities | null {
    if (this.residentWindows === null) return null;
    const windows = [...this.residentWindows.values()];
    return { slots: null, contextLength: windows.length > 0 ? Math.min(...windows) : null };
  }

  /** `GET /v1/models/{id}`, or null when Lemonade cannot be asked or does not know the model. */
  private async readModelInfo(modelId: string): Promise<Record<string, unknown> | null> {
    const auth = this.authHeaders();
    try {
      const response = await axios.get(`${this.getBaseUrl()}/v1/models/${encodeURIComponent(modelId)}`, {
        timeout: 5000,
        ...(auth ? { headers: auth } : {}),
      });
      const data = response.data;
      return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    } catch {
      return null;
    }
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
   * `totalBytes` are therefore null, not zero. Its window is known: each record carries the
   * options the model was loaded with, and `contextLength` is their `ctx_size` when one was set.
   *
   * Two record shapes. 2026.x marks each record `loaded`, `status` and `backend_alive`, and all
   * three must hold: a record can be marked loaded while its backend process is gone, which is
   * precisely the false "resident" to avoid. 10.2.0 — every Lemonade on the fleet — lists only what
   * its router holds and carries none of the three, so a record there is resident unless it says
   * otherwise; requiring them read every 10.2.0 node as holding nothing at all.
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
        this.residentWindows = null;
        return { backend: this.type, source: 'unsupported', models: null };
      }

      const held = (records as LemonadeLoadedRecord[]).filter(
        (record) => record.loaded !== false && (record.status === undefined || record.status === 'ready') && record.backend_alive !== false,
      );
      const resident = held.map((record) => ({
        id: record.model_name ?? record.checkpoint ?? 'unknown',
        engineGpuBytes: null,
        totalBytes: null,
        expiresAt: null,
        contextLength: positiveWindow(recipeOptionsOf(record)?.ctx_size),
        quantization: null,
      }));
      // Only the LLMs' windows: an embedder's ctx_size says nothing about what a chat request gets.
      const windows = new Map<string, number>();
      for (const [index, record] of held.entries()) {
        const model = resident[index];
        if (model?.contextLength != null && (record.type ?? 'llm') === 'llm') windows.set(model.id, model.contextLength);
      }
      this.residentWindows = windows;

      return { backend: this.type, source: 'measured', models: resident };
    } catch (err) {
      this.residentWindows = null;
      return {
        backend: this.type,
        source: 'unreachable',
        models: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Whether Lemonade holds `modelId` in memory right now, from {@link listResident}. The inventory
   * `healthCheck` reports is every DOWNLOADED model, so asking it answered "loaded" for anything on
   * disk, and the Hub's load path — which asks this first — never loaded (or sent a window to) a
   * downloaded Lemonade model at all. The inventory is the answer only where Lemonade cannot say.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const residency = await this.listResident();
    if (residency.source === 'measured' && residency.models) {
      return residency.models.some((model) => model.id === modelId);
    }
    if (residency.source === 'unreachable') {
      return false;
    }
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
