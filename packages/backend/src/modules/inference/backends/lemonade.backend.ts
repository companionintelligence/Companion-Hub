import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { EngineCapabilities, InferenceBackend, LoadModelOptions } from './backend.interface';
import type { BackendHealthStatus, BackendResidency, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
// Shared with the Ollama backend: both mount the same AMD device nodes and so
// need the same host GIDs. See that module for the full rationale.
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from './amd-device-groups.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { LEMONADE_USER_NAMESPACE, withoutLemonadeUserNamespace } from '../model-availability.util';

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
  /** Saved window of each LLM Lemonade held at the last residency read; null when that read failed. */
  private residentWindows: Map<string, number> | null = null;
  /** The registry listing the last health probe read; see {@link offersModel}. */
  private offer: LemonadeOffer | null = null;
  /** The registry read in flight, if any; see {@link refreshOffer}. */
  private offerRead: { baseUrl: string; promise: Promise<void> } | null = null;
  /** Bumped by each pull, so a registry read that began before it does not store its older listing. */
  private offerGeneration = 0;
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
   *
   * Probes that arrive while a read is in flight share it. The pool's health loop, the status route
   * and a pull check can all probe at once when the TTL runs out, and each used to send its own
   * `show_all` request for the same 70-odd entries.
   */
  private refreshOffer(baseUrl: string, version: string | null): Promise<void> {
    const cached = this.offer;
    if (cached && cached.baseUrl === baseUrl && Date.now() - cached.fetchedAt < OFFER_TTL_MS) return Promise.resolve();
    if (this.offerRead?.baseUrl === baseUrl) return this.offerRead.promise;
    const promise = this.readOffer(baseUrl, version).finally(() => {
      if (this.offerRead?.promise === promise) this.offerRead = null;
    });
    this.offerRead = { baseUrl, promise };
    return promise;
  }

  private async readOffer(baseUrl: string, version: string | null): Promise<void> {
    const auth = this.authHeaders();
    const generation = this.offerGeneration;
    try {
      const response = await axios.get(`${baseUrl}/v1/models?show_all=true`, { timeout: 5000, ...(auth ? { headers: auth } : {}) });
      if (generation !== this.offerGeneration) return;
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
      // so the next probe re-reads it. The old listing keeps answering until then. A read already in
      // flight began before the registration, so the next probe does not join it.
      if (this.offer) this.offer = { ...this.offer, fetchedAt: 0 };
      this.offerGeneration += 1;
      this.offerRead = null;
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
   *
   * A `provisionalWindow` (the Hub went below an installed app's floor because the memory holding the
   * card could not be unloaded for this load) never lowers a larger saved window: the model is loaded at
   * it with the saved options, unsaved, so its next load — Lemonade's own, or the Hub's once the memory
   * is back — goes at the saved one. With nothing saved, or a smaller window saved, it is saved as usual:
   * Lemonade's own default is 4096 on 10.2.0 and the whole card's worth on 2026.x, both worse.
   */
  async loadModel(modelId: string, options?: LoadModelOptions): Promise<void> {
    // The puller already hands over the engine's spelling; resolving again is a no-op then, and keeps a
    // caller with the catalog id from loading (and saving options under) a name 10.2.0 does not know.
    const engineId = this.engineModelId(modelId);
    const window = options?.embedding || !options?.contextLength ? null : options.contextLength;
    this.logger.info(`[Lemonade] Loading model: ${engineId}${window ? ` at ctx_size ${window}` : ''}`);
    const auth = this.authHeaders();
    const config = { ...(auth ? { headers: auth } : {}) };
    let body: Record<string, unknown> = { model_name: engineId };
    if (window) {
      const saved = await this.readModelInfo(engineId);
      const savedOptions = saved ? recipeOptionsOf(saved) : null;
      const savedWindow = positiveWindow(savedOptions?.ctx_size);
      if (savedOptions && options?.provisionalWindow && savedWindow !== null && savedWindow > window) {
        this.logger.info(
          `[Lemonade] Loading ${engineId} at ctx_size ${window} for now, without saving it: its saved ctx_size ${savedWindow} is kept for its next load.`,
        );
        body = { ...savedOptions, model_name: engineId, ctx_size: window };
      } else if (savedOptions) {
        body = { ...savedOptions, model_name: engineId, ctx_size: window, save_options: true };
      } else {
        this.logger.warn(
          `[Lemonade] Could not read ${engineId}'s saved options, so ctx_size ${window} is used for this load but not saved; ` +
            "Lemonade's own loads of it keep whatever window it had.",
        );
        body = { model_name: engineId, ctx_size: window };
      }
    }
    await axios.post(`${this.getBaseUrl()}/v1/load`, body, { timeout: 120000, ...config });
  }

  /**
   * The window Lemonade serves `modelId` at whatever a request asks: the smaller of the window it is
   * running at, when it is resident, and its saved `ctx_size`, which its next load uses; either alone
   * when only one can be read, and null when neither can. A handout for a Lemonade model must not
   * promise more than this, now or after the next load; see `capHandoutAtServedWindow`.
   *
   * The resident window matters because it need not be the saved one. Lemonade loads models by itself,
   * on a request for one that is not resident or from its own UI, and with nothing saved such a load
   * runs at the configured default — 4096 on the fleet's 10.2.0 — which the health record reports
   * (10.2.0 gives each server's effective `recipe_options`), while a handout read from the saved options
   * alone still promised Hermes 64000. And the Hub loads below the saved window without saving
   * (`LoadModelOptions.provisionalWindow`) when memory it may not free holds the card.
   */
  async servedContextLength(modelId: string): Promise<number | null> {
    const [info, residency] = await Promise.all([this.readModelInfo(modelId), this.listResident()]);
    const saved = info ? positiveWindow(recipeOptionsOf(info)?.ctx_size) : null;
    const running = this.residentRecordOf(residency.models ?? [], modelId)?.contextLength ?? null;
    if (saved !== null && running !== null) return Math.min(saved, running);
    return saved ?? running;
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

  /**
   * `GET /v1/models/{id}` under the name the server knows the model by ({@link engineModelId}), or null
   * when Lemonade cannot be asked or does not know the model. 10.2.0 answers the bare id of a model the
   * Hub registered with "Model not found": it knows it only as `user.<id>`.
   */
  private async readModelInfo(modelId: string): Promise<Record<string, unknown> | null> {
    const auth = this.authHeaders();
    try {
      const response = await axios.get(`${this.getBaseUrl()}/v1/models/${encodeURIComponent(this.engineModelId(modelId))}`, {
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
   *
   * Matched under either of the model's names (see {@link residentRecordOf}): 10.2.0 lists the
   * embedder the Hub registers as `user.nomic-embed-text-v1.5-GGUF`, and an exact match on the catalog's
   * bare id read it as not resident, so every load of it reloaded (and re-registered) a model in memory.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const residency = await this.listResident();
    if (residency.source === 'measured' && residency.models) {
      return this.residentRecordOf(residency.models, modelId) !== undefined;
    }
    if (residency.source === 'unreachable') {
      return false;
    }
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(this.engineModelId(modelId));
  }

  /**
   * The residency record for `modelId`: the one listed under the name the server knows it by
   * ({@link engineModelId}), else one listed under its other spelling — with the `user.` namespace
   * added or dropped, the rule `servedIdForCatalogModel` applies to the inventory. The engine's own
   * spelling wins when both are resident.
   */
  private residentRecordOf<T extends { id: string }>(models: readonly T[], modelId: string): T | undefined {
    const engineId = this.engineModelId(modelId);
    const bare = withoutLemonadeUserNamespace(modelId);
    return models.find((model) => model.id === engineId) ?? models.find((model) => withoutLemonadeUserNamespace(model.id) === bare);
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
