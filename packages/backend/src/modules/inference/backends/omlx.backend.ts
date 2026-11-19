import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import { servedOmlxId } from '@/common/helpers/omlx-model-id';
import { HardwareInspectorService } from '../hardware-inspector.service';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, normalizeHostBackendUrl, resolveHostBackendProbeUrl } from './host-url.util';
import { foreignEngineHealth, openAiModelIds, openAiModelOwner } from './engine-identity';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { isSameServer } from '../engine-credential-scope';

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
      'To install it, run the Homebrew command from https://github.com/jundot/omlx in Terminal. `omlx serve --model-dir ~/models` runs it in the foreground instead.',
  };
}

/** Candidate API key for a Re-check probe — header, not query, so it stays out of access logs. */
export const OMLX_PROBE_API_KEY_HEADER = 'x-ci-omlx-api-key';

export const resolveOmlxProbeUrl = resolveHostBackendProbeUrl;

/** Where oMLX requests go with `savedUrl` as the URL saved in Settings: that, else OMLX_URL, else oMLX's default port on the host. */
export function omlxBaseUrl(savedUrl: string | null | undefined): string {
  const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
  return resolveOmlxProbeUrl(savedUrl?.trim() || process.env.OMLX_URL?.trim() || `http://${host}:${OMLX_DEFAULT_PORT}`);
}

/**
 * oMLX's own admin page for the server at `baseUrl`, as a browser on the Mac opens it: the Hub's
 * `host.docker.internal` is the Mac's `localhost`.
 */
function omlxAdminPageUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'host.docker.internal') url.hostname = 'localhost';
    return `${normalizeHostBackendUrl(url.toString())}/admin`;
  } catch {
    return `${baseUrl}/admin`;
  }
}

/**
 * The oMLX key an app that talks to oMLX directly is handed: OMLX_API_KEY, never the key saved in
 * Settings. That one is oMLX's main key, and it would let any app change oMLX's settings or delete
 * its models. An oMLX the desktop app installed keeps `/v1` open without a key, as it was before.
 */
export function omlxAppApiKey(): string | undefined {
  return process.env.OMLX_API_KEY?.trim() || undefined;
}

/** How often a download's progress is read. oMLX's own page reads it every 500 ms. */
const OMLX_DOWNLOAD_POLL_MS = 1000;

/** Reads of a download in a row that may fail (oMLX restarting, say) before the pull gives up. */
const OMLX_DOWNLOAD_POLL_FAILURES = 30;

/** Seconds a finished download has to show up in `/v1/models`, read once a second. */
const OMLX_LISTING_WAIT_POLLS = 60;

/** Reads of `/v1/models` before the Hub asks oMLX to rescan its model directories, once. */
const OMLX_RELOAD_AFTER_POLLS = 5;

/** A row of `GET /admin/api/hf/tasks`: `DownloadTask.to_dict()` in jundot/omlx omlx/admin/hf_downloader.py. */
interface OmlxDownloadTask {
  task_id: string;
  repo_id: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  total_size?: number;
  downloaded_size?: number;
  error?: string;
}

function isOmlxDownloadTask(value: unknown): value is OmlxDownloadTask {
  if (!value || typeof value !== 'object') return false;
  const { task_id: taskId, repo_id: repoId, status } = value as Record<string, unknown>;
  return typeof taskId === 'string' && typeof repoId === 'string' && typeof status === 'string';
}

/** The download oMLX runs for `repoId`. oMLX matches repos without regard to case, as Hugging Face does. */
function activeDownloadFor(tasks: OmlxDownloadTask[], repoId: string): OmlxDownloadTask | undefined {
  const wanted = repoId.toLowerCase();
  return tasks.find((task) => task.repo_id.toLowerCase() === wanted && (task.status === 'pending' || task.status === 'downloading'));
}

/** oMLX's `detail` for a refused admin call, else the request's own message. */
function omlxErrorDetail(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function isUnauthorized(err: unknown): boolean {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  return status === 401 || status === 403;
}

/**
 * Reported without probing when the host is not Apple Silicon and no oMLX URL is set. oMLX's
 * default port is vLLM's, so on a Linux node the default URL can only reach vLLM or nothing.
 */
export const OMLX_NOT_APPLE_SILICON_ERROR =
  'oMLX runs only on Apple Silicon and this host is not, so the Hub does not probe for it. ' +
  'To use an oMLX server on another machine, set its URL in Settings → AI or OMLX_URL.';

/**
 * oMLX's Prefill Accelerator helper for NVIDIA GPUs (oMLX 0.8.0 and later). A Linux machine with
 * NVIDIA GPUs runs the first layers of each long prompt for a Mac that serves the model; the Mac runs
 * the rest, decodes, and keeps the KV cache. The NVIDIA half is the `jundot/omlx-cuda-helper` image,
 * started with this command from jundot/omlx's 0.8.0rc1 release notes. It serves no OpenAI API, so
 * the Hub never routes to it: on an NVIDIA host, the oMLX status only says whether it runs and how
 * to start or pair it. `cihub fleet backends --backends omlx-helper` installs it on fleet nodes.
 */
export const OMLX_CUDA_HELPER_RUN_COMMAND =
  'docker run -d --name omlx-helper --restart unless-stopped --gpus all --network host -v omlx-helper:/data jundot/omlx-cuda-helper';

/** The helper prints `PAIRING CODE 123456` in its log once a Mac presses Pair; the code expires in ten minutes. */
export const OMLX_CUDA_HELPER_PAIRING_COMMAND = "docker logs omlx-helper 2>&1 | grep 'PAIRING CODE'";

/** Discovery and pairing. `GET /api/cluster/node_id` there is what the Mac's Cluster tab reads. */
export const OMLX_CUDA_HELPER_HTTP_PORT = 8850;

export interface OmlxCudaHelperStatus {
  running: boolean;
  /** The name the Mac's Cluster tab shows for this host. */
  name?: string;
  version?: string;
  /** The cards, as the helper names them: `2x NVIDIA RTX A6000`. */
  chip?: string;
  /** GPU memory across those cards, in whole GiB. */
  gpuMemoryGb?: number;
}

/**
 * The helper's identity, from `GET /api/cluster/node_id` (`identity()` in jundot/omlx
 * apps/omlx-cuda-helper/omlx_cuda_helper/discovery.py). `caps.backends` of `["cuda"]` is what sets it
 * apart from a Mac's oMLX on the same route. Null for any other body.
 */
export function readOmlxCudaHelperIdentity(body: unknown): Omit<OmlxCudaHelperStatus, 'running'> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { node_id: nodeId, version, friendly_name: name, caps } = body as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !caps || typeof caps !== 'object' || Array.isArray(caps)) return null;
  const { backends, chip, ram_gb: gpuMemoryGb } = caps as Record<string, unknown>;
  if (!Array.isArray(backends) || !backends.includes('cuda')) return null;
  return {
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(typeof version === 'string' && version ? { version } : {}),
    ...(typeof chip === 'string' && chip ? { chip } : {}),
    ...(typeof gpuMemoryGb === 'number' && Number.isFinite(gpuMemoryGb) ? { gpuMemoryGb } : {}),
  };
}

/**
 * What the oMLX status says on an NVIDIA host, where oMLX itself cannot run. The probe error already
 * says that oMLX needs Apple Silicon, so this starts at what the host can do instead.
 */
export function buildOmlxCudaHelperRemediation(helper: OmlxCudaHelperStatus): { command: string; hint: string } {
  if (helper.running) {
    const about = [helper.version && `helper ${helper.version}`, helper.chip].filter(Boolean).join(', ');
    return {
      command: OMLX_CUDA_HELPER_PAIRING_COMMAND,
      hint:
        `oMLX's Prefill Accelerator helper is running on this host${about ? ` (${about})` : ''}. ` +
        `On a Mac running oMLX 0.8.0 or later with Distributed Inference on, press Pair on ${helper.name ? `"${helper.name}"` : 'this host'} in the Cluster tab, ` +
        'then type the code that the command below prints.',
    };
  }
  return {
    command: OMLX_CUDA_HELPER_RUN_COMMAND,
    hint:
      "This host's NVIDIA GPU can run oMLX's Prefill Accelerator helper instead, which speeds up long prompts for a Mac running oMLX 0.8.0 or later. " +
      'It needs NVIDIA driver 580 or newer, an Ampere or newer GPU or a DGX Spark, and the NVIDIA Container Toolkit. ' +
      "Start it with the command below, then press Pair on this host in the Mac's oMLX Cluster tab and type the code that `docker logs omlx-helper` prints. " +
      'Its pairing runs over plain HTTP, so run it only on a network you trust.',
  };
}

/**
 * oMLX's own `GET /health` body: `status` "healthy" (or "loading", with a 503, while pinned models
 * preload) beside an `engine_pool` key, per `health()` in jundot/omlx server.py from v0.2.10 on.
 * It identifies oMLX where `/v1/models` cannot: that list has no `owned_by` to read until a model
 * is installed, and it wants an API key once oMLX listens beyond loopback. vLLM's `/health` is an
 * empty 200 and llama-server's is `{"status":"ok"}`.
 */
export function isOmlxHealthBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { status } = body as { status?: unknown };
  return (status === 'healthy' || status === 'loading') && 'engine_pool' in body;
}

@Injectable()
export class OmlxBackend implements InferenceBackend {
  readonly type = 'omlx' as const;
  private readonly api = new OpenAiCompatibleClient();
  /** What the last health probe found oMLX listing (`/v1/models`), for {@link engineModelId}. */
  private listed: { baseUrl: string; ids: readonly string[] } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly hardwareInspector: HardwareInspectorService,
  ) {}

  getBaseUrl(): string {
    return omlxBaseUrl(this.configuredUrl());
  }

  /**
   * The key the Hub sends oMLX: one typed for a probe, else the key saved in Settings (the one the
   * desktop app set when it installed oMLX, or one the operator entered), else OMLX_API_KEY. oMLX's
   * admin API, which downloads models, takes only its main key.
   */
  getApiKey(apiKeyOverride?: string): string | undefined {
    return (
      apiKeyOverride?.trim() ||
      this.configuration.getInferencePreferences().preferredOmlxApiKey?.trim() ||
      process.env.OMLX_API_KEY?.trim() ||
      undefined
    );
  }

  /**
   * The key a probe of `probeUrl` carries: one typed for this probe goes wherever the operator is
   * probing, and the saved key or OMLX_API_KEY only to the oMLX server it is configured for
   * (`getBaseUrl`, compared by `isSameServer`). `omlx/status` and `onboarding-profile` hand their `?url=` straight to
   * {@link healthCheck}, so attaching the saved key to any URL let any caller of those routes
   * collect it by naming a listener.
   */
  private probeApiKey(probeUrl: string, apiKeyOverride?: string): { apiKey: string | undefined; savedKeyWithheld: boolean } {
    const typed = apiKeyOverride?.trim();
    if (typed) return { apiKey: typed, savedKeyWithheld: false };
    const saved = this.getApiKey();
    if (isSameServer(probeUrl, this.getBaseUrl())) return { apiKey: saved, savedKeyWithheld: false };
    return { apiKey: undefined, savedKeyWithheld: Boolean(saved) };
  }

  /** The operator's own oMLX address: Settings first, then OMLX_URL. Undefined means the default. */
  private configuredUrl(): string | undefined {
    return this.configuration.getInferencePreferences().preferredOmlxUrl?.trim() || process.env.OMLX_URL?.trim() || undefined;
  }

  /** An unreadable profile is not evidence against Apple Silicon, and the identity check still applies. */
  private async mayHostOmlx(): Promise<boolean> {
    const profile = await this.hardwareInspector.getProfile().catch(() => null);
    return !profile || profile.gpu.vendor === 'apple';
  }

  /**
   * `running` means oMLX answered, not that something did: taking any `/v1/models` answer as oMLX
   * reported it running on every fleet node where vLLM held port 8000. The default URL is probed
   * only on Apple Silicon; a URL the operator gave is always probed, since a Linux Hub may use a
   * Mac's oMLX. Either way the server must name itself `omlx` or answer `/health` as oMLX does.
   */
  async healthCheck(baseUrlOverride?: string, apiKeyOverride?: string): Promise<BackendHealthStatus> {
    const explicitUrl = baseUrlOverride?.trim() || this.configuredUrl();
    if (!explicitUrl && !(await this.mayHostOmlx())) {
      return { running: false, healthy: false, modelsLoaded: [], error: OMLX_NOT_APPLE_SILICON_ERROR };
    }
    const baseUrl = baseUrlOverride?.trim() ? resolveOmlxProbeUrl(normalizeHostBackendUrl(baseUrlOverride)) : this.getBaseUrl();
    const { apiKey, savedKeyWithheld } = this.probeApiKey(baseUrl, apiKeyOverride);

    const [health, models] = await Promise.allSettled([
      // Any status: oMLX answers 503 while it preloads, and that body identifies it as well as a 200.
      axios.get(`${baseUrl}/health`, { timeout: 5000, validateStatus: () => true }),
      this.api.fetchModels(baseUrl, { timeout: 5000, apiKey }),
    ]);
    const healthSaysOmlx = health.status === 'fulfilled' && isOmlxHealthBody(health.value.data);

    if (models.status === 'rejected') {
      const message = models.reason instanceof Error ? models.reason.message : String(models.reason);
      if (!healthSaysOmlx) return { running: false, healthy: false, modelsLoaded: [], error: message };
      const status = axios.isAxiosError(models.reason) ? models.reason.response?.status : undefined;
      const hint =
        status === 401 || status === 403
          ? savedKeyWithheld
            ? " oMLX asks for an API key on /v1/models once it has one set or listens beyond loopback. The saved key (or OMLX_API_KEY) is sent only to the configured oMLX URL; enter this server's key to check it."
            : ' oMLX asks for an API key on /v1/models once it has one set or listens beyond loopback. Enter its API key in Settings > AI, or set OMLX_API_KEY.'
          : '';
      return { running: true, healthy: false, modelsLoaded: [], error: `${message}.${hint}` };
    }

    const body = models.value;
    const foreign = foreignEngineHealth('omlx', body, baseUrl);
    if (foreign) return { ...foreign, running: false };
    if (openAiModelOwner(body) !== 'omlx' && !healthSaysOmlx) {
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error:
          `The server at ${baseUrl} answers GET /v1/models but is not oMLX: no model is owned_by "omlx" and GET /health ` +
          `is not oMLX's. Point Settings → AI or OMLX_URL at the oMLX server, or add any other OpenAI-compatible server as a decode endpoint.`,
      };
    }
    const modelsLoaded = openAiModelIds(body);
    // Only the configured server's listing: a Re-check of another URL must not replace it.
    if (baseUrl === this.getBaseUrl()) this.listed = { baseUrl, ids: [...modelsLoaded] };
    return { running: true, healthy: true, modelsLoaded };
  }

  /**
   * oMLX's CUDA helper on this host, or null on a host whose GPU is not NVIDIA, which is never
   * probed. Asked only by the oMLX status route, never per request: the helper serves no model, and
   * a firewall that drops the probe would otherwise cost every pooled request this timeout.
   */
  async cudaHelperStatus(): Promise<OmlxCudaHelperStatus | null> {
    const profile = await this.hardwareInspector.getProfile().catch(() => null);
    if (profile?.gpu.vendor !== 'nvidia') return null;
    const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
    try {
      const res = await axios.get(`http://${host}:${OMLX_CUDA_HELPER_HTTP_PORT}/api/cluster/node_id`, { timeout: 3000 });
      const identity = readOmlxCudaHelperIdentity(res.data);
      return identity ? { running: true, ...identity } : { running: false };
    } catch {
      return { running: false };
    }
  }

  /** From {@link healthCheck}, so the model list and the status agree on whose server this is. */
  async listModels(): Promise<BackendModelInfo[]> {
    const health = await this.healthCheck();
    return health.healthy ? health.modelsLoaded.map((id) => ({ id, name: id, size: 0, loaded: true })) : [];
  }

  /**
   * Download `repoId` (the catalog's Hugging Face repo, `mlx-community/<name>`) through oMLX's admin
   * API: start it, follow oMLX's task for it, then wait until `/v1/models` lists the model, which is
   * what the Hub's installed check reads. oMLX rescans its model directories when a download
   * finishes; the Hub asks for one more rescan if the model is slow to appear.
   */
  async pullModel(repoId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const headers = this.adminHeaders();
    this.logger.info(`[oMLX] Downloading ${repoId} through oMLX at ${baseUrl}`);
    const taskId = await this.startDownload(baseUrl, repoId, headers);
    await this.followDownload(baseUrl, repoId, taskId, headers, onProgress);
    onProgress?.({ status: 'Waiting for oMLX to list the model', percent: 100 });
    await this.waitUntilListed(baseUrl, repoId, headers);
  }

  private adminHeaders(): Record<string, string> {
    const apiKey = this.getApiKey();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * Why oMLX refused a download, and what to do. A keyless oMLX takes a first key on its own page;
   * the desktop app can also set one from Settings > AI.
   */
  private adminKeyError(baseUrl: string, repoId: string): Error {
    const page = omlxAdminPageUrl(baseUrl);
    return new Error(
      this.getApiKey()
        ? `oMLX refused to download ${repoId}: its admin API needs oMLX's main API key, and the key the Hub has is not it. ` +
            `Enter the key oMLX uses (on its page at ${page}) in Settings > AI.`
        : `oMLX refused to download ${repoId}: its admin API needs oMLX's main API key, and the Hub has none. ` +
            `Set an API key on oMLX's page at ${page}, then enter it in Settings > AI.`,
    );
  }

  /** The task id of the download oMLX starts, or of the one it already runs for this repo. */
  private async startDownload(baseUrl: string, repoId: string, headers: Record<string, string>): Promise<string> {
    try {
      const res = await axios.post(`${baseUrl}/admin/api/hf/download`, { repo_id: repoId }, { headers, timeout: 15_000 });
      const task = (res.data as { task?: unknown } | undefined)?.task;
      if (isOmlxDownloadTask(task)) return task.task_id;
      throw new Error(`oMLX did not say which download it started for ${repoId}.`);
    } catch (err) {
      if (isUnauthorized(err)) throw this.adminKeyError(baseUrl, repoId);
      // oMLX runs one download per repo and refuses a second with a 400: follow the one it runs.
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const running = activeDownloadFor(await this.downloadTasks(baseUrl, headers).catch(() => []), repoId);
        if (running) return running.task_id;
      }
      throw new Error(`oMLX could not start downloading ${repoId}: ${omlxErrorDetail(err)}`);
    }
  }

  private async downloadTasks(baseUrl: string, headers: Record<string, string>): Promise<OmlxDownloadTask[]> {
    const res = await axios.get(`${baseUrl}/admin/api/hf/tasks`, { headers, timeout: 10_000 });
    const tasks = (res.data as { tasks?: unknown } | undefined)?.tasks;
    return Array.isArray(tasks) ? tasks.filter(isOmlxDownloadTask) : [];
  }

  private async followDownload(
    baseUrl: string,
    repoId: string,
    startedTaskId: string,
    headers: Record<string, string>,
    onProgress?: (progress: PullProgress) => void,
  ): Promise<void> {
    let taskId = startedTaskId;
    let failures = 0;
    for (;;) {
      let task: OmlxDownloadTask | undefined;
      try {
        const tasks = await this.downloadTasks(baseUrl, headers);
        // A restarted oMLX resumes an interrupted download under a new task id and drops finished
        // rows (`restore_tasks` in jundot/omlx omlx/admin/hf_downloader.py), so the download is then
        // the one oMLX runs for this repo.
        task = tasks.find((row) => row.task_id === taskId) ?? activeDownloadFor(tasks, repoId);
        if (task) taskId = task.task_id;
        failures = 0;
      } catch (err) {
        if (isUnauthorized(err)) throw this.adminKeyError(baseUrl, repoId);
        failures += 1;
        if (failures >= OMLX_DOWNLOAD_POLL_FAILURES) {
          throw new Error(`The Hub lost track of the download of ${repoId} in oMLX: ${omlxErrorDetail(err)}`);
        }
        await this.pause(OMLX_DOWNLOAD_POLL_MS);
        continue;
      }
      if (!task) {
        // A download that finished just before oMLX restarted has no row left, but its model is listed.
        if (await this.isModelLoaded(repoId)) return;
        throw new Error(`oMLX no longer lists the download of ${repoId}. It may have been removed in oMLX.`);
      }
      if (task.status === 'completed') return;
      if (task.status === 'failed') throw new Error(task.error?.trim() || `oMLX could not download ${repoId}.`);
      if (task.status === 'cancelled') throw new Error(`The download of ${repoId} was cancelled in oMLX.`);
      onProgress?.({
        status: task.status === 'pending' ? 'Waiting for oMLX to start the download' : 'Downloading in oMLX',
        percent: Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress as number)) : 0,
        ...(task.total_size ? { total: task.total_size } : {}),
        ...(task.downloaded_size === undefined ? {} : { completed: task.downloaded_size }),
      });
      await this.pause(OMLX_DOWNLOAD_POLL_MS);
    }
  }

  private async waitUntilListed(baseUrl: string, repoId: string, headers: Record<string, string>): Promise<void> {
    for (let poll = 1; poll <= OMLX_LISTING_WAIT_POLLS; poll++) {
      if (await this.isModelLoaded(repoId)) return;
      if (poll === OMLX_RELOAD_AFTER_POLLS) {
        await axios.post(`${baseUrl}/admin/api/reload`, {}, { headers, timeout: 30_000 }).catch((err: unknown) => {
          this.logger.warn(`[oMLX] Rescan after downloading ${repoId} failed: ${omlxErrorDetail(err)}`);
        });
      }
      await this.pause(OMLX_DOWNLOAD_POLL_MS);
    }
    throw new Error(
      `oMLX downloaded ${repoId} but does not list it. Reload the models on oMLX's page at ${omlxAdminPageUrl(baseUrl)}, then re-check.`,
    );
  }

  /** A seam for tests, which do not wait. */
  protected pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Load ${modelId} from the oMLX admin UI or by placing the MLX checkpoint in the model directory`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Unload ${modelId} from the oMLX admin UI`);
  }

  /**
   * Whether oMLX lists `modelId`: the catalog's `mlx-community/<name>`, or any spelling oMLX gives that
   * model (see {@link servedOmlxId}). oMLX lists the models it has discovered, loaded or not, and loads
   * one on its first request, so "listed" is the most a probe can say, as it is for vLLM. An exact match
   * found no catalog row, because oMLX does not list the catalog's spelling.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return servedOmlxId(modelId, health.modelsLoaded) !== null;
  }

  /**
   * The name oMLX lists `modelId` under, from the last health probe of the configured server, else
   * `modelId` itself (before the first probe, or for a model oMLX does not list). A request must use it
   * where oMLX serves the model from the Hugging Face cache (`mlx-community--<name>`):
   * `mlx-community/<name>` is a 404 there, although both model directory layouts accept it.
   */
  engineModelId(modelId: string): string {
    const ids = this.listed?.baseUrl === this.getBaseUrl() ? this.listed.ids : [];
    return servedOmlxId(modelId, ids) ?? modelId;
  }

  getDockerImage(): string {
    throw new Error('oMLX has no Docker image. Install it on the Apple Silicon host and point the Hub at http://host.docker.internal:8000.');
  }

  getComposeConfig(): Record<string, unknown> {
    throw new Error('oMLX has no Docker path. It runs on the Apple Silicon host (brew install jundot/omlx/omlx && omlx start).');
  }
}
