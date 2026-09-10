import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
import { bearerHeaders, readManagedRunnerApiKey } from '../managed-runner-auth';

/** Accept `http://host:8000`, `http://host:8000/` or `http://host:8000/v1` and store the bare origin. */
export function normalizeMtplxBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Hub container probe — `/.dockerenv` plus Podman's containerenv. Not the `/data` heuristic. */
export function detectHubContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch {
    return false;
  }
}

/**
 * Operator `localhost` / `127.0.0.1` means the host where MTPLX runs. From inside
 * the Hub container that hostname is the container itself — rewrite only then.
 */
export function resolveMtplxProbeUrl(url: string, inContainer: boolean = detectHubContainer()): string {
  const normalized = normalizeMtplxBaseUrl(url);
  if (!inContainer) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
      parsed.hostname = 'host.docker.internal';
      return normalizeMtplxBaseUrl(parsed.toString());
    }
  } catch {
    // Keep normalized input; healthCheck will surface a bad URL.
  }
  return normalized;
}

export interface MtplxRemediation {
  /** Copy-pasteable command to install and start MTPLX on the host. */
  command: string;
  /** Prose explaining the install path, without the trailing probe-URL sentence. */
  hint: string;
}

/**
 * Suggested install + start command for a host where MTPLX isn't reachable yet. MTPLX is a native
 * macOS app/CLI (Homebrew or pip) with no Docker or Linux path at all — see getComposeConfig below,
 * which always declines. The suggested model is the catalog's default recommendation (native MTP
 * head, no external drafter) so a fresh install lands on a model the catalog already knows about.
 */
export function buildMtplxRemediation(): MtplxRemediation {
  return {
    command: 'brew install youssofal/mtplx/mtplx && mtplx serve --model Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed',
    hint:
      'Run MTPLX on the host (Apple Silicon, macOS 14+ — there is no Docker or Linux path for it): install with ' +
      '`brew install youssofal/mtplx/mtplx` (or `pip install mtplx`), then run the command above. `mtplx start` also ' +
      'works and walks through model selection interactively.',
  };
}

@Injectable()
export class MtplxBackend implements InferenceBackend {
  readonly type = 'mtplx' as const;

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * MTPLX is host-run (or remote), with optional lifecycle management from desktop FTUE. The
   * operator-configured URL from Settings wins over the compose-injected MTPLX_URL env; read
   * per-call rather than caching in the constructor so a Settings change takes effect without a
   * Hub restart.
   */
  getBaseUrl(): string {
    const configured = this.configuration.getInferencePreferences().preferredMtplxUrl?.trim();
    return resolveMtplxProbeUrl(configured || process.env.MTPLX_URL || 'http://ci-hub-mtplx:8000');
  }

  getApiKey(): string | undefined {
    return readManagedRunnerApiKey('mtplx');
  }

  private requestConfig(timeout: number): { timeout: number; headers?: Record<string, string> } {
    const headers = bearerHeaders(this.getApiKey());
    return headers ? { timeout, headers } : { timeout };
  }

  /** Overrides let status + onboarding probe unsaved Settings input without persisting it. */
  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveMtplxProbeUrl(baseUrlOverride) : this.getBaseUrl();
    try {
      const response = await axios.get(`${baseUrl}/v1/models`, this.requestConfig(5000));
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
      const response = await axios.get(`${this.getBaseUrl()}/v1/models`, this.requestConfig(10000));
      const models = response.data?.data ?? [];
      return models.map((m: { id: string }) => ({
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
    // MTPLX loads its model at server startup via `mtplx serve --model <repo>` (or is picked
    // interactively by `mtplx start`) — there is no HTTP pull-with-progress endpoint, same as vLLM.
    onProgress?.({ status: 'MTPLX models are configured at server startup', percent: 100 });
    this.logger.info('[MTPLX] Model configuration requires a server restart with an updated --model flag');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[MTPLX] Load model request for ${modelId} — requires server restart with --model=${modelId}`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[MTPLX] Unload model request for ${modelId} — requires server restart`);
  }

  /*
   * No `listResident()`, deliberately — this backend reports `source: 'unsupported'`.
   *
   * There is no source to read. MTPLX is a native macOS app with no residency endpoint, and no
   * instance exists anywhere on this fleet to probe, so even a plausible-looking shape could not
   * be verified. Reporting `unsupported` states exactly that; anything else would be invention.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  /** MTPLX ships no Docker image at all — see getComposeConfig. */
  getDockerImage(): string {
    throw new Error('MTPLX has no Docker image — it is a native macOS app/CLI (Homebrew or pip). See getComposeConfig.');
  }

  /**
   * MTPLX is Apple-Silicon-native with no Docker path on any platform (unlike vLLM, which is
   * CUDA-Docker-viable on `nvidia` and only declines `apple`/`amd` — see VllmBackend.getComposeConfig).
   * There is no macOS Docker Desktop Metal passthrough and no Linux build at all ("Not a CUDA project.
   * MTPLX is MLX-native and Apple Silicon first. For Linux, use vLLM." — MTPLX's own README). Every
   * vendor declines outright rather than handing back a container that could never run this backend;
   * the operator installs MTPLX themselves and points Settings → MTPLX URL at it instead (see
   * buildMtplxRemediation and the catalog's `-mtplx` rows in curated-models.ts for the models it can
   * serve).
   */
  getComposeConfig(): Record<string, unknown> {
    throw new Error(
      'MTPLX has no Docker path on any platform (Apple Silicon only, no Docker/Metal passthrough, no Linux build). ' +
        'Install it natively (brew install youssofal/mtplx/mtplx or pip install mtplx) and point Settings → MTPLX URL at it instead.',
    );
  }
}
