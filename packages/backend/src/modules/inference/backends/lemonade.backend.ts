import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend, LoadModelOptions } from './backend.interface';
import type { BackendHealthStatus, BackendResidency, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
// Shared with the Ollama backend: both mount the same AMD device nodes and so
// need the same host GIDs. See that module for the full rationale.
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from './amd-device-groups.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { LEMONADE_USER_NAMESPACE } from '../model-availability.util';

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
 * not carry them, keyed by the catalog's `backendModelId`. `/v1/pull` with a `user.*` name, a recipe
 * and a checkpoint registers and downloads in one call (verified against lemonade-server 2026.39.1,
 * 2026-09-29, and in the 10.2.0 source).
 *
 * What the server then calls the model depends on its version: 2026.39.1 lists it under the bare
 * key, but 10.2.0 — the apt package on every fleet Lemonade node — lists and resolves it only as
 * `user.<key>`, and answers the bare key with "Model not found". So loads and handouts never assume
 * a spelling: they use the one the server lists ({@link LemonadeBackend.engineModelId}).
 */
export const LEMONADE_REGISTRATIONS: Readonly<Record<string, Record<string, unknown>>> = {
  // The embedder every install shares; see the 2026-09-29 note above EXTRAS_TOON in curated-models.ts.
  'nomic-embed-text-v1.5-GGUF': {
    model_name: `${LEMONADE_USER_NAMESPACE}nomic-embed-text-v1.5-GGUF`,
    recipe: 'llamacpp',
    checkpoint: 'nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.f16.gguf',
    embedding: true,
  },
};

/**
 * How long one `GET /v1/models?show_all=true` stands for the server's registry. The listing only
 * changes when Lemonade is upgraded or the Hub registers a model (which drops the cache itself), and
 * the pool's local-health loop probes every few seconds, so re-reading 70-odd entries on each probe
 * would buy nothing.
 */
const OFFER_TTL_MS = 60_000;

/** What the connected Lemonade can supply, read from `GET /v1/models?show_all=true`. */
interface LemonadeOffer {
  baseUrl: string;
  /** Every id the server lists, downloaded or not, in the server's own spelling. */
  ids: ReadonlySet<string>;
  /** `/v1/health`'s `version`, for messages. */
  version: string | null;
  fetchedAt: number;
}

/**
 * Lemonade's own reason from a failed call, not axios's "Request failed with status code 500".
 * Its handlers answer `{"error": "<text>"}`; the OpenAI-shaped routes `{"error": {"message": …}}`.
 */
export function lemonadeErrorDetail(err: unknown): string {
  const response = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = response?.data;
  let detail: string | undefined;
  if (typeof data === 'string' && data.trim()) {
    detail = data.trim();
  } else if (data && typeof data === 'object') {
    const body = data as { error?: unknown; message?: unknown; detail?: unknown };
    const error = body.error as { message?: unknown } | string | undefined;
    const candidate = typeof error === 'string' ? error : (error?.message ?? body.message ?? body.detail);
    if (typeof candidate === 'string' && candidate.trim()) detail = candidate.trim();
  }
  const fallback = err instanceof Error ? err.message : String(err);
  if (!detail) return fallback;
  return response?.status ? `${detail} (HTTP ${response.status})` : detail;
}

@Injectable()
export class LemonadeBackend implements InferenceBackend {
  readonly type = 'lemonade' as const;
  private baseUrl: string;
  /** The registry listing the last health probe read; see {@link offersModel}. */
  private offer: LemonadeOffer | null = null;
  /** What the last health probe found downloaded (`/v1/models`), for {@link engineModelId}. */
  private downloaded: { baseUrl: string; ids: ReadonlySet<string> } | null = null;

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
        const version = typeof response.data?.version === 'string' ? response.data.version : null;
        // In parallel, so the registry read (at most once a minute) never lengthens the probe.
        const [models] = await Promise.all([
          new OpenAiCompatibleClient().listModelIds(baseUrl, { timeout: 5000, apiKey }).catch(() => [] as string[]),
          this.refreshOffer(baseUrl, version),
        ]);
        this.downloaded = { baseUrl, ids: new Set(models) };
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

  /**
   * Re-read the server's whole registry when the cached listing is older than {@link OFFER_TTL_MS}
   * or belongs to another URL. A read that fails keeps the last good listing; a server that ignores
   * `show_all` (it answers the downloaded list, whose entries carry no `downloaded` flag) cannot say
   * what it offers, so the listing is dropped and nothing is filtered — the behaviour before this.
   */
  private async refreshOffer(baseUrl: string, version: string | null): Promise<void> {
    const cached = this.offer;
    if (cached && cached.baseUrl === baseUrl && Date.now() - cached.fetchedAt < OFFER_TTL_MS) return;
    const auth = this.authHeaders();
    try {
      const response = await axios.get(`${baseUrl}/v1/models?show_all=true`, { timeout: 5000, ...(auth ? { headers: auth } : {}) });
      const entries: unknown = response.data?.data;
      const listing = Array.isArray(entries) ? (entries as { id?: unknown; downloaded?: unknown }[]) : [];
      const isRegistryListing = listing.some((entry) => typeof entry?.downloaded === 'boolean');
      if (!isRegistryListing) {
        this.offer = null;
        return;
      }
      const ids = listing.map((entry) => entry?.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
      this.offer = { baseUrl, ids: new Set(ids), version, fetchedAt: Date.now() };
    } catch (err) {
      this.logger.debug(`[Lemonade] Could not read the model registry: ${lemonadeErrorDetail(err)}`);
    }
  }

  /** The cached listing, when it belongs to the server this backend talks to now. */
  private currentOffer(): LemonadeOffer | null {
    return this.offer && this.offer.baseUrl === this.getBaseUrl() ? this.offer : null;
  }

  /** Every id the server listed on its last probe, downloaded or offered, in its own spelling. */
  private listedIds(): Set<string> {
    const baseUrl = this.getBaseUrl();
    const ids = new Set<string>(this.currentOffer()?.ids ?? []);
    if (this.downloaded?.baseUrl === baseUrl) {
      for (const id of this.downloaded.ids) ids.add(id);
    }
    return ids;
  }

  /** `/v1/health`'s version string from the last registry read, or null. */
  serverVersion(): string | null {
    return this.currentOffer()?.version ?? null;
  }

  /**
   * Whether this Lemonade can supply `modelId`: its registry lists it (in either spelling, see
   * `LEMONADE_USER_NAMESPACE`), or the Hub registers it on pull. Null when no registry listing has
   * been read, so a caller keeps its old behaviour instead of hiding every row.
   *
   * The catalog's Lemonade rows were checked against lemonade-server 2026.39.1, but every fleet
   * node runs 10.2.0, whose registry lacks 13 of them — including every default the Hub would hand
   * a Lemonade node. A pull of such a name fails there with a misleading demand for the `user.`
   * namespace.
   */
  offersModel(modelId: string): boolean | null {
    const offer = this.currentOffer();
    if (!offer) return null;
    const listed = this.listedIds();
    if (listed.has(modelId) || listed.has(`${LEMONADE_USER_NAMESPACE}${modelId}`)) return true;
    return Object.hasOwn(LEMONADE_REGISTRATIONS, modelId);
  }

  /**
   * The name this server knows a catalog `backendModelId` by: the spelling it lists, else — for a
   * model the Hub registers that it has not listed yet — the registration name, `user.<id>`, which
   * resolves on every version (10.2.0 keys it that way; later versions still accept it beside the
   * bare alias they list). Everything else keeps its catalog name.
   */
  engineModelId(modelId: string): string {
    if (modelId.startsWith(LEMONADE_USER_NAMESPACE)) return modelId;
    const listed = this.listedIds();
    if (listed.has(modelId)) return modelId;
    const namespaced = `${LEMONADE_USER_NAMESPACE}${modelId}`;
    if (listed.has(namespaced) || Object.hasOwn(LEMONADE_REGISTRATIONS, modelId)) return namespaced;
    return modelId;
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
    if (this.offersModel(modelId) === false) {
      // Refused here rather than sent: 10.2.0 answers an unknown bare name by demanding the `user.`
      // namespace, which reads as a Hub bug instead of "this Lemonade does not have that model".
      const version = this.serverVersion();
      throw new Error(
        `Lemonade${version ? ` ${version}` : ''} does not offer ${modelId}: its registry (GET /v1/models?show_all=true) does not list it. ` +
          'Upgrade Lemonade, or choose a model it lists.',
      );
    }
    try {
      const auth = this.authHeaders();
      // A model the Hub installs from Hugging Face is registered by the same call that downloads it.
      const body = LEMONADE_REGISTRATIONS[modelId] ?? { model_name: modelId };
      await axios.post(`${this.getBaseUrl()}/v1/pull`, body, { timeout: 0, ...(auth ? { headers: auth } : {}) });
      onProgress?.({ status: 'complete', percent: 100 });
      this.logger.info(`[Lemonade] Model pulled: ${modelId}`);
    } catch (err) {
      const detail = lemonadeErrorDetail(err);
      this.logger.error(`[Lemonade] Pull failed for ${modelId}: ${detail}`);
      throw new Error(`Lemonade could not pull ${modelId}: ${detail}`);
    } finally {
      // A registration adds a name to the registry (and a failed pull may have registered it anyway),
      // so the next probe re-reads it. The old listing keeps answering until then.
      if (this.offer) this.offer = { ...this.offer, fetchedAt: 0 };
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
      const response = await axios.get(`${this.getBaseUrl()}/v1/models/${encodeURIComponent(this.engineModelId(modelId))}/files`, {
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
    return health.modelsLoaded.includes(this.engineModelId(modelId));
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
