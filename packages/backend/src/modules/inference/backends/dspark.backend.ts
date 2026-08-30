import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, normalizeHostBackendUrl, resolveHostBackendProbeUrl } from './host-url.util';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

/** Accept `http://host:8080`, `http://host:8080/` or `http://host:8080/v1` and store the bare origin. */
export const normalizeDsparkBaseUrl = normalizeHostBackendUrl;

/**
 * Operator `localhost` / `127.0.0.1` means the host where mlx-dspark runs. From inside the Hub
 * container that hostname is the container itself — rewrite only then.
 */
export const resolveDsparkProbeUrl = resolveHostBackendProbeUrl;

export { detectHubContainer };

/** `mlx-dspark serve`'s default listen port. */
export const DSPARK_DEFAULT_PORT = 8080;

/** How often `pullModel` samples `GET /health` for download progress while `/admin/load` blocks. */
export const DSPARK_PROGRESS_POLL_MS = 1000;

/**
 * `GET /health` is mlx-dspark's readiness surface and the **only route that is exempt from
 * `--api-key`**. It answers with no model loaded and mid-swap, which is exactly the managed-server
 * posture the Hub drives, so it — not `/v1/models` — is what `healthCheck` probes.
 *
 * `status` is a three-state: `ok` (a model is resident), `loading` (a swap is in flight), and
 * `no_model` (server up, nothing loaded — the state `serve --no-model` starts in).
 *
 * `target` is the **full Hugging Face repo id** of the loaded model and is what a catalog
 * `backendModelId` must be compared against. `model` is the short display id
 * (`target.split('/').pop()`), which does *not* round-trip to a repo id — never match on it.
 */
interface DsparkHealthBody {
  status?: 'ok' | 'loading' | 'no_model';
  /** Short display id — NOT the repo id. */
  model?: string | null;
  /** Full HF repo id of the loaded target. Only present on `status: 'ok'`. */
  target?: string | null;
  /** Resolved drafter repo id, or null in drafter-free `lookup` mode. */
  drafter?: string | null;
  /** Which stage of an in-flight load: `loading` (weights) or `warming_up`. */
  phase?: string | null;
  /** Non-null only while a first-time load is fetching weights. */
  download?: { repo?: string | null; bytes_done?: number | null; bytes_total?: number | null } | null;
  error?: string | null;
}

/** 200 body of `POST /admin/load` and `POST /admin/unload` (mlx-dspark's `EngineHolder.status()`). */
interface DsparkAdminStatusBody {
  ready?: boolean;
  loading?: boolean;
  model?: string | null;
  error?: string | null;
}

export interface DsparkRemediation {
  /** Copy-pasteable command to start mlx-dspark on the host. */
  command: string;
  /** Prose explaining the install path, without the trailing probe-URL sentence. */
  hint: string;
}

/**
 * Suggested install + start command for a host where mlx-dspark isn't reachable yet.
 *
 * `--no-model` is load-bearing, not cosmetic: it is mlx-dspark's documented managed-server pattern,
 * and it is what makes `POST /admin/load` the Hub's model switch. Starting with `--model X` still
 * permits hot-swap (the CLI wraps the engine in an `EngineHolder` either way — cli.py:489/495), but
 * it moves the first multi-GB download outside the Hub's progress reporting and blocks the port
 * until it finishes.
 *
 * Homebrew is deliberately **not** suggested: the `mlx-dspark` cask installs the Mac app, not the
 * engine the Hub talks to, and on Homebrew 6+ it additionally needs `brew trust` plus an
 * `xattr -dr com.apple.quarantine` because the app is ad-hoc signed rather than notarized.
 */
export function buildDsparkRemediation(isAppleSilicon: boolean): DsparkRemediation {
  const command = `mlx-dspark serve --no-model --host 0.0.0.0 --port ${DSPARK_DEFAULT_PORT}`;
  if (isAppleSilicon) {
    return {
      command,
      hint:
        'Run mlx-dspark on the host (it is a native Metal server — there is no Docker path): install it into a venv ' +
        'with `pip install mlx-dspark` (Python 3.10+; pulls mlx 0.32+), check the install with ' +
        '`mlx-dspark doctor --json` (exit 0 = ok), then run the command above. `--no-model` starts it empty so the ' +
        'Hub can load, swap and unload models over its admin API instead of you restarting the server.',
    };
  }
  return {
    // The published wheel is `py3-none-any` with no platform marker, so `pip install` *succeeds*
    // off Apple Silicon and only fails once it tries to import mlx. Say so plainly rather than
    // handing over an install line that appears to work.
    command,
    hint:
      'mlx-dspark runs only on Apple Silicon (it is MLX/Metal-native, with no CUDA or Linux build). Its wheel carries ' +
      'no platform marker, so `pip install mlx-dspark` will appear to succeed on this machine and then fail at ' +
      'runtime. Use Ollama or vLLM here, and point Settings → mlx-dspark URL at a Mac only if one is serving on your network.',
  };
}

/**
 * mlx-dspark (github.com/ARahim3/mlx-dspark) — EAGLE-family speculative decoding (DeepSeek's DSpark
 * and z-lab's DFlash) running natively on Apple Silicon via MLX, behind an OpenAI- and
 * Anthropic-compatible HTTP API.
 *
 * Unlike vLLM and Lemonade, this backend implements `pullModel` / `loadModel` / `unloadModel` for
 * real rather than logging a "restart required" line: mlx-dspark exposes `POST /admin/load` and
 * `POST /admin/unload` over HTTP, synchronously, with the listening port surviving loads, unloads
 * and failed loads. That is what lets the Hub's model registry and memory manager report true
 * state for this backend — see model-puller.service.ts, which derives registry state from these
 * calls simply not throwing.
 *
 * Like vLLM-Metal, the server itself is host-run and never Hub-managed: `getDockerImage` and
 * `getComposeConfig` both throw unconditionally.
 */
@Injectable()
export class DsparkBackend implements InferenceBackend {
  readonly type = 'dspark' as const;

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * mlx-dspark is host-run (or remote), never Hub-managed — same posture as vLLM-Metal. The
   * operator-configured URL from Settings wins over the compose-injected DSPARK_URL env; read
   * per-call rather than caching in the constructor so a Settings change takes effect without a
   * Hub restart.
   *
   * The fallback is `127.0.0.1:8080`, not a container name: there is no Hub-managed mlx-dspark
   * container to name, and `resolveDsparkProbeUrl` rewrites the loopback host to
   * `host.docker.internal` when the Hub itself is containerized.
   */
  getBaseUrl(): string {
    const configured = this.configuration.getInferencePreferences().preferredDsparkUrl?.trim();
    return resolveDsparkProbeUrl(configured || process.env.DSPARK_URL || `http://127.0.0.1:${DSPARK_DEFAULT_PORT}`);
  }

  private async fetchHealth(baseUrl: string, timeout = 5000): Promise<DsparkHealthBody> {
    const response = await axios.get<DsparkHealthBody>(`${baseUrl}/health`, { timeout });
    return response.data ?? {};
  }

  /**
   * Overrides let status + onboarding probe unsaved Settings input without persisting it.
   *
   * Deliberately probes `/health` rather than `/v1/models` the way VllmBackend does: on mlx-dspark
   * `/v1/models` is both API-key-gated and readiness-gated (503 with nothing loaded), so a
   * `--no-model` server — the posture the Hub asks operators for — would read as *down*.
   *
   * `loading` and `no_model` both report `running: true, healthy: true`: the server is up and
   * answering, it simply has no model resident, which for this backend is a normal steady state
   * rather than a fault. `modelsLoaded` carries the full repo id from `target` so it compares
   * directly against a catalog `backendModelId`.
   */
  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveDsparkProbeUrl(baseUrlOverride) : this.getBaseUrl();
    try {
      const body = await this.fetchHealth(baseUrl);
      const target = body.status === 'ok' ? body.target?.trim() : undefined;
      return {
        running: true,
        healthy: true,
        modelsLoaded: target ? [target] : [],
        ...(body.error ? { error: body.error } : {}),
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

  /**
   * Derived from `/health` rather than `GET /v1/models` for the same reason `healthCheck` is — that
   * route needs the API key and 503s with no model loaded. mlx-dspark serves exactly one model at a
   * time, so this is at most a single entry. `size` is 0 because the server reports no byte count;
   * the catalog's `diskMb` is the Hub's size of record.
   */
  async listModels(): Promise<BackendModelInfo[]> {
    try {
      const body = await this.fetchHealth(this.getBaseUrl(), 10000);
      const target = body.status === 'ok' ? body.target?.trim() : undefined;
      if (!target) {
        return [];
      }
      return [{ id: target, name: body.model?.trim() || target, size: 0, loaded: true }];
    } catch {
      return [];
    }
  }

  /**
   * The load payload. `confidence_threshold: 0` and `kv_bits: 0` are sent **explicitly on every
   * load** and are the losslessness guard: omitting either lets mlx-dspark re-resolve the pair's
   * measured defaults, and a non-zero acceptance threshold or a quantized KV cache would make
   * output diverge from plain decoding with nothing in the Hub UI to say so. Pinning both to 0
   * keeps the speculative path exactly lossless — the drafter's own quantization is unaffected by
   * this and does not change the output distribution, only the acceptance rate.
   */
  private loadPayload(modelId: string): Record<string, unknown> {
    return { model: modelId, confidence_threshold: 0, kv_bits: 0 };
  }

  private adminUrl(path: string): string {
    return `${this.getBaseUrl()}${path}`;
  }

  private describeAxiosError(err: unknown, modelId: string): string {
    const message = err instanceof Error ? err.message : String(err);
    if (!axios.isAxiosError(err)) {
      return message;
    }
    const status = err.response?.status;
    const detail = (err.response?.data as { error?: { message?: string } | string } | undefined)?.error;
    const serverMessage = typeof detail === 'string' ? detail : detail?.message;
    if (status === 501) {
      return `mlx-dspark was started without hot-swap support, so the Hub cannot load ${modelId}. Restart it with \`mlx-dspark serve --no-model\`.`;
    }
    return serverMessage ? `${serverMessage} (HTTP ${status})` : message;
  }

  /**
   * A first-time load downloads the target (and, in dspark/dflash mode, its drafter) from Hugging
   * Face. There is no separate pull endpoint: `POST /admin/load` *is* the download, and it blocks
   * until the model is resident. Because mlx-dspark serves on a `ThreadingHTTPServer`, `GET /health`
   * keeps answering on another thread while that call is in flight, reporting
   * `download: {repo, bytes_done, bytes_total}` — so progress is polled concurrently rather than
   * streamed from the load response.
   *
   * Two honest limits on that progress, both surfaced through `status` rather than a fake percent:
   * `bytes_total` comes from a best-effort background Hugging Face metadata call and can stay null
   * (then `percent` is 0 and the status says the size is unknown), and `download` is null entirely
   * for a local path or an already-cached repo (then the load is effectively instant and only the
   * terminal 100% is emitted).
   */
  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    const baseUrl = this.getBaseUrl();
    onProgress?.({ status: `Loading ${modelId} into mlx-dspark`, percent: 0 });

    let lastReportedDone = -1;
    // `clearInterval` stops future ticks but cannot cancel a probe already in flight, and that probe
    // can resolve after the terminal emit below — which would leave the UI showing e.g. 47% *after*
    // the download finished. Gate every emit on this instead.
    let settled = false;
    const poll = setInterval(() => {
      void this.fetchHealth(baseUrl, DSPARK_PROGRESS_POLL_MS)
        .then((body) => {
          const download = body.download;
          if (settled || !download) {
            return;
          }
          const completed = typeof download.bytes_done === 'number' ? download.bytes_done : undefined;
          const total = typeof download.bytes_total === 'number' && download.bytes_total > 0 ? download.bytes_total : undefined;
          if (completed === undefined || completed === lastReportedDone) {
            return;
          }
          lastReportedDone = completed;
          onProgress?.({
            status: total ? `Downloading ${download.repo ?? modelId}` : `Downloading ${download.repo ?? modelId} (size unknown)`,
            completed,
            ...(total ? { total } : {}),
            // `percent` is required and non-nullable on PullProgress, so an unknown total reports 0
            // rather than a number the UI would draw as real progress. Capped at 99 so only the
            // terminal emit below reaches 100.
            percent: total ? Math.min(99, Math.round((completed / total) * 100)) : 0,
          });
        })
        .catch(() => {
          // A probe that fails mid-load is not itself a load failure — the awaited /admin/load
          // below is the authority on that. Swallow and let the next tick try again.
        });
    }, DSPARK_PROGRESS_POLL_MS);

    try {
      // No request timeout: this call is the download, and a large target legitimately takes
      // many minutes.
      const response = await axios.post<DsparkAdminStatusBody>(this.adminUrl('/admin/load'), this.loadPayload(modelId), {
        timeout: 0,
      });
      if (!response.data?.ready) {
        throw new Error(response.data?.error || `mlx-dspark did not become ready after loading ${modelId}`);
      }
      onProgress?.({ status: 'success', percent: 100 });
      this.logger.info(`[mlx-dspark] Loaded ${modelId}`);
    } catch (err) {
      throw new Error(`[mlx-dspark] Failed to load ${modelId}: ${this.describeAxiosError(err, modelId)}`);
    } finally {
      settled = true;
      clearInterval(poll);
    }
    // NOTE: mlx-dspark also exposes `POST /admin/load/cancel { cleanup }` to abort an in-flight
    // download (cleanup:false keeps the partial blobs so a retry resumes). Deliberately not wired
    // up: ModelPullerService has no cancellation concept for any backend, so a method here would be
    // unreachable. If pull cancellation is ever added Hub-wide, that is the endpoint to call.
  }

  /**
   * Same `POST /admin/load` as `pullModel` — for mlx-dspark, loading a model and fetching it are
   * one operation, and a repo already in the Hugging Face cache simply loads without downloading.
   *
   * `options.embedding` is ignored: mlx-dspark serves no `/v1/embeddings` route, so no embedding
   * catalog row targets this backend and the branch is unreachable. Embeddings stay on Ollama —
   * see EMBEDDING_INFERENCE_BACKEND in inference-env-resolver.ts.
   */
  async loadModel(modelId: string, options?: { embedding?: boolean }): Promise<void> {
    if (options?.embedding) {
      this.logger.debug(`[mlx-dspark] Ignoring embedding load request for ${modelId} — mlx-dspark serves chat models only`);
      return;
    }
    try {
      const response = await axios.post<DsparkAdminStatusBody>(this.adminUrl('/admin/load'), this.loadPayload(modelId), {
        timeout: 0,
      });
      if (!response.data?.ready) {
        throw new Error(response.data?.error || `mlx-dspark did not become ready after loading ${modelId}`);
      }
      this.logger.info(`[mlx-dspark] Loaded ${modelId}`);
    } catch (err) {
      throw new Error(`[mlx-dspark] Failed to load ${modelId}: ${this.describeAxiosError(err, modelId)}`);
    }
  }

  /**
   * Frees the resident model while keeping the port. Idempotent — unloading twice is a no-op
   * upstream — and not readiness-gated, so it is safe to call against an already-empty server.
   * `modelId` is accepted for interface symmetry only: mlx-dspark holds exactly one model, so
   * there is nothing to select.
   */
  async unloadModel(modelId: string, options?: { embedding?: boolean }): Promise<void> {
    if (options?.embedding) {
      return;
    }
    try {
      await axios.post<DsparkAdminStatusBody>(this.adminUrl('/admin/unload'), {}, { timeout: 30000 });
      this.logger.info(`[mlx-dspark] Unloaded ${modelId}`);
    } catch (err) {
      throw new Error(`[mlx-dspark] Failed to unload ${modelId}: ${this.describeAxiosError(err, modelId)}`);
    }
  }

  /** Exact, not approximate: `modelsLoaded` is `[health.target]`, the full HF repo id. */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  /** mlx-dspark ships no Docker image at all — see getComposeConfig. */
  getDockerImage(): string {
    throw new Error('mlx-dspark has no Docker image — it is a host-run Python server on Apple Silicon (Metal). See getComposeConfig.');
  }

  /**
   * mlx-dspark is Apple-Silicon-native with no Docker path on any platform — unlike vLLM, which is
   * CUDA-Docker-viable on `nvidia` and only declines `apple`/`amd` (see VllmBackend.getComposeConfig).
   * Docker Desktop on macOS has no Metal passthrough, and there is no Linux or CUDA build to fall
   * back to. Every vendor declines outright rather than handing back a container that could never
   * run this backend; the operator installs mlx-dspark themselves and points Settings → mlx-dspark
   * URL at it instead (see buildDsparkRemediation, and the catalog's `-dspark` rows in
   * curated-models.ts for the models it can serve).
   */
  getComposeConfig(): Record<string, unknown> {
    throw new Error(
      'mlx-dspark has no Docker path on any platform (Apple Silicon/Metal only, no Metal passthrough in Docker Desktop, no Linux build). ' +
        'Install it on the host with `pip install mlx-dspark` and point Settings → mlx-dspark URL at it instead.',
    );
  }
}
