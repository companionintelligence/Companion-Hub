import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, BackendResidency, PullProgress } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, resolveHostBackendProbeUrl } from './host-url.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { QUARANTINE_STRIKES, ServingQuarantine } from './serving-quarantine';

/**
 * `llama-server`, the HTTP server that ships with llama.cpp, run on the host by the operator.
 *
 * Why the Hub supports it at all when Ollama already wraps llama.cpp: because the operator may
 * already be running one. A `llama-server` started by hand — for a GGUF that is not in Ollama's
 * library, with flags Ollama does not expose (`--n-gpu-layers`, a specific `--cache-type-k`, a
 * draft model for speculative decoding) — is a machine's worth of capacity the Hub could otherwise
 * only tell its operator to abandon. Pointing at it costs one environment variable, and the pool
 * then places work on it like any other backend.
 *
 * The Hub does not manage the process. llama.cpp publishes Docker images, but a Hub-managed
 * container would need a GGUF on disk, a `-m` path, and per-model flags — model management Ollama
 * already does better and which this backend has no way to do at all (see {@link pullModel}). So
 * this is a URL and a health check, like {@link MtplxBackend} and the host-run vLLM path.
 */

/** `llama-server`'s own default listen port. */
export const LLAMACPP_DEFAULT_PORT = 8080;

/**
 * Health path. `llama-server` answers `/health` 200 `{"status":"ok"}` once the model is loaded and
 * 503 while it is still loading, which is the distinction that matters: a server that is up but
 * still mapping a 27B GGUF will accept a connection and then make the request wait minutes.
 * Probing it means "loading" reads as unhealthy rather than as ready.
 */
const LLAMACPP_HEALTH_PATH = '/health';

@Injectable()
export class LlamacppBackend implements InferenceBackend {
  readonly type = 'llamacpp' as const;
  private readonly api = new OpenAiCompatibleClient();
  /** See {@link ServingQuarantine}: a listed model that fails every request must stop being routed to. */
  private readonly quarantine = new ServingQuarantine();

  constructor(private readonly logger: LoggerService) {}

  /**
   * `LLAMACPP_URL` in the Hub's environment, else `llama-server`'s own default port — but see
   * {@link isConfigured}: without the variable this backend does not probe at all.
   *
   * Environment-only, like {@link LuceboxBackend} and unlike vLLM/MTPLX/mlx-dspark, which have a
   * Settings field each. Adding one here would mean another positional parameter on
   * `setInferencePreferences`, which already takes eight; the URL of a server the operator started
   * themselves belongs in the same `.env` as the rest of that decision until that signature is
   * reworked.
   *
   * The URL is still returned when nothing is set, because callers (status routes, the pool proxy's
   * candidate list) expect an address to name in a message. Reachability is decided by the health
   * check, which is where the opt-in is enforced.
   */
  getBaseUrl(): string {
    const configured = process.env.LLAMACPP_URL?.trim();
    const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
    return resolveHostBackendProbeUrl(configured || `http://${host}:${LLAMACPP_DEFAULT_PORT}`);
  }

  /**
   * Whether the operator has pointed the Hub at a `llama-server` — and the reason this backend is
   * opt-in rather than discovered on its default port like LM Studio is.
   *
   * `llama-server` defaults to 8080, and so does mlx-dspark (`DSPARK_URL` in every compose file in
   * this repo). Probing 8080 unasked would find dspark's server on an Apple Silicon host, get a
   * perfectly good OpenAI-compatible answer from it, and report ONE engine as two healthy backends
   * — which double-counts that machine's capacity in pool ranking and shows an engine the operator
   * never started. `scripts/lib/fleet-backends.ts` documents the same class of mistake on the :8000
   * space, where vllm/mtplx/lucebox collide and a listener there is attributed to none of them.
   *
   * LM Studio's 1234 collides with nothing, which is why that backend keeps its zero-configuration
   * discovery and this one does not.
   */
  private isConfigured(): boolean {
    return (process.env.LLAMACPP_URL?.trim().length ?? 0) > 0;
  }

  /** `llama-server --api-key <key>`. Absent when the operator started it without one, which is the default. */
  getApiKey(): string | undefined {
    return process.env.LLAMACPP_API_KEY?.trim() || undefined;
  }

  /**
   * Healthy means `/health` says ok AND `/v1/models` names something — the same
   * "readiness, not reachability" posture the vLLM, mlx-dspark, and Lucebox backends take. A
   * server answering `/health` while its model is unloaded would otherwise be ranked as a
   * candidate and then fail the request it was given.
   *
   * `baseUrlOverride` lets Settings and onboarding probe an address the operator has typed but not
   * yet saved.
   */
  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    if (!baseUrlOverride && !this.isConfigured()) {
      // No request at all: see isConfigured() for why probing the default port unasked would report
      // another engine as this one. An override still probes, so Settings can test a typed address.
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: `LLAMACPP_URL is not set, so the Hub does not probe for llama-server. Set it to your server's address (default ${this.getBaseUrl()}).`,
      };
    }
    const baseUrl = baseUrlOverride ? resolveHostBackendProbeUrl(baseUrlOverride) : this.getBaseUrl();
    const health = await this.api.healthCheck(baseUrl, { apiKey: this.getApiKey(), healthPath: LLAMACPP_HEALTH_PATH });
    const withheld = this.quarantine.list();
    return withheld.length > 0 ? { ...health, unservableModels: withheld } : health;
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      return await this.api.listModels(this.getBaseUrl(), { apiKey: this.getApiKey() });
    } catch {
      return [];
    }
  }

  /**
   * `llama-server` serves exactly the GGUF it was started with, so its inventory IS its residency —
   * the `'implicit'` case the interface docblock names. Reporting `'measured'` would claim the
   * engine was asked, and there is nothing to ask: llama.cpp exposes no residency endpoint, and
   * every field of {@link ResidentModel} would be a null this backend invented.
   */
  async listResident(): Promise<BackendResidency> {
    const health = await this.healthCheck();
    if (!health.running || !health.healthy) {
      return { backend: this.type, source: 'unreachable', models: null, error: health.error };
    }
    return {
      backend: this.type,
      source: 'implicit',
      models: health.modelsLoaded.map((id) => ({
        id,
        engineGpuBytes: null,
        totalBytes: null,
        expiresAt: null,
        contextLength: null,
        quantization: null,
      })),
    };
  }

  /**
   * There is no pull. `llama-server` is started against a GGUF path (`-m`) or a Hugging Face repo
   * (`-hf`) and has no HTTP endpoint that fetches one — the same position as vLLM and MTPLX. The
   * operator chooses the model when they start the server.
   */
  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'llama.cpp models are chosen when llama-server starts', percent: 100 });
    this.logger.info('[llama.cpp] Changing the model requires restarting llama-server with a different -m/-hf argument');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[llama.cpp] Load request for ${modelId} — llama-server holds the model it was started with`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[llama.cpp] Unload request for ${modelId} — llama-server holds the model it was started with`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  /** True only on the observation that flipped the model to withheld — see the interface: a caller
   *  ranking from a cached health answer needs to know that answer has just gone stale. */
  noteServingFailure(modelId: string, reason: string): boolean {
    const decision = this.quarantine.recordFailure(modelId, reason);
    if (decision.withheld) {
      this.logger.warn(
        `[llama.cpp] Model ${modelId} is listed but failed to serve (${reason}); withholding it from routing for ${Math.round(decision.forMs / 1000)}s`,
      );
      return true;
    }
    this.logger.debug(`[llama.cpp] Model ${modelId} failed to serve (${reason}); strike ${decision.strikes} of ${QUARANTINE_STRIKES}`);
    return false;
  }

  /** True when the model WAS withheld until now — read before the clear, or it always answers false. */
  noteServingSuccess(modelId: string): boolean {
    const wasWithheld = this.quarantine.isWithheld(modelId);
    if (this.quarantine.recordSuccess(modelId)) {
      this.logger.info(`[llama.cpp] Model ${modelId} served again — no longer withheld from routing`);
    }
    return wasWithheld;
  }

  /** See {@link getComposeConfig} — the Hub does not deploy this backend. */
  getDockerImage(): string {
    throw new Error(
      'The Hub does not manage llama-server. llama.cpp publishes images, but a Hub-managed container would need a GGUF on ' +
        'disk and per-model flags the Hub has no way to choose. Run it yourself and set LLAMACPP_URL.',
    );
  }

  /**
   * Declines on every vendor, deliberately, and for a different reason than MTPLX declines (no
   * Linux build at all) or vLLM declines `amd`/`apple` (no viable image). llama.cpp has images for
   * everything. What the Hub lacks is the *model*: this backend cannot pull, so a container it
   * started would come up with no weights and no argument to point at any, and the operator would
   * have to bind-mount a GGUF and pass flags — at which point they have written the compose file
   * the Hub was supposed to write for them. Use Ollama for a Hub-managed engine; use this to reach
   * a `llama-server` that already exists.
   */
  getComposeConfig(): Record<string, unknown> {
    throw new Error(
      'The Hub does not deploy llama-server: it cannot pull a GGUF, so a container it started would have no weights. ' +
        'Start it yourself (llama-server -m <model.gguf> --port 8080) and point LLAMACPP_URL at it, or use Ollama for a Hub-managed engine.',
    );
  }
}
