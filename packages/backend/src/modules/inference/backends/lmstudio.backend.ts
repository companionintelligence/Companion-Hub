import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, BackendResidency, PullProgress, ResidentModel } from '@ci-hub/common/types';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, resolveHostBackendProbeUrl } from './host-url.util';
import { OpenAiCompatibleClient } from './openai-compatible.client';
import { QUARANTINE_STRIKES, ServingQuarantine } from './serving-quarantine';

/**
 * LM Studio's local server, run on the operator's own machine.
 *
 * The reason to support it is the same as for llama.cpp, only more so: LM Studio is how a large
 * number of people already run local models on a Mac or a Windows box, complete with a library of
 * GGUF and MLX weights they have already downloaded. Before this, a Hub could see none of it — the
 * operator's most capable machine was invisible to the pool unless they installed Ollama beside a
 * runtime they were happily using. One environment variable now makes it a pool member.
 *
 * Two APIs, and this backend reads both:
 * - the OpenAI-compatible surface at `/v1`, which is what actually serves requests, and
 * - LM Studio's own REST API at `/api/v0`, which is the only source that distinguishes a model
 *   that is DOWNLOADED from one that is LOADED. That distinction is exactly the one
 *   `BackendHealthStatus.modelsLoaded` (inventory) and {@link listResident} (residency) exist to
 *   keep apart, so where an engine will actually tell us, we ask.
 *
 * `/api/v0` is documented as in beta, so nothing depends on it: every read falls back to the
 * OpenAI surface, and residency degrades to `'unsupported'` rather than guessing.
 */

/** LM Studio's own default port for its local server. */
export const LMSTUDIO_DEFAULT_PORT = 1234;

/** LM Studio's native REST listing, which reports each model's `state`. Beta; every caller here tolerates its absence. */
const LMSTUDIO_NATIVE_MODELS_PATH = '/api/v0/models';

/** One row of {@link LMSTUDIO_NATIVE_MODELS_PATH}. Every field but `id` is optional: this is a beta API. */
interface LmStudioNativeModel {
  id?: unknown;
  state?: unknown;
  type?: unknown;
  quantization?: unknown;
  max_context_length?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Injectable()
export class LmStudioBackend implements InferenceBackend {
  readonly type = 'lmstudio' as const;
  private readonly api = new OpenAiCompatibleClient();
  private readonly quarantine = new ServingQuarantine();

  constructor(private readonly logger: LoggerService) {}

  /**
   * `LMSTUDIO_URL`, else LM Studio's default port on the host. Environment-only for the same reason
   * as {@link LlamacppBackend.getBaseUrl}.
   *
   * Note that LM Studio binds to localhost by default and has to be told to serve on the network
   * ("Serve on Local Network" in its developer settings) before a Hub in a container — or on
   * another machine — can reach it at all. {@link healthCheck}'s error is what says so.
   */
  getBaseUrl(): string {
    const configured = process.env.LMSTUDIO_URL?.trim();
    const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
    return resolveHostBackendProbeUrl(configured || `http://${host}:${LMSTUDIO_DEFAULT_PORT}`);
  }

  /** LM Studio ignores the bearer token, but an operator may have put a reverse proxy in front of it. */
  getApiKey(): string | undefined {
    return process.env.LMSTUDIO_API_KEY?.trim() || undefined;
  }

  /**
   * Reachability plus inventory, from `/v1/models` — which for LM Studio lists every DOWNLOADED
   * model, loaded or not. That is the right reading for this field: it is the inventory, and LM
   * Studio will load a downloaded model on demand when a request names it (JIT loading), so a model
   * listed here really is one the engine will accept a request for.
   *
   * No separate health path. LM Studio publishes none, and `/v1/models` answering is the same proof
   * of readiness a health path would give.
   */
  async healthCheck(baseUrlOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveHostBackendProbeUrl(baseUrlOverride) : this.getBaseUrl();
    const health = await this.api.healthCheck(baseUrl, { apiKey: this.getApiKey() });
    const withheld = this.quarantine.list();
    return withheld.length > 0 ? { ...health, unservableModels: withheld } : health;
  }

  async listModels(): Promise<BackendModelInfo[]> {
    const native = await this.readNativeModels();
    if (native !== null) {
      return native.map((model) => ({
        id: readString(model.id) ?? '',
        name: readString(model.id) ?? '',
        size: 0,
        // `loaded` here means "in memory now", which the native API is the only source for.
        loaded: readString(model.state) === 'loaded',
      }));
    }
    try {
      return await this.api.listModels(this.getBaseUrl(), { apiKey: this.getApiKey() });
    } catch {
      return [];
    }
  }

  /**
   * Real residency, when LM Studio's native API answers: it reports `state: "loaded"` per model,
   * which is a measurement, so this reports `'measured'` — including the empty list, which is then
   * the fact "nothing is loaded" rather than "this engine does not say".
   *
   * When the beta API is absent the answer is `'unsupported'`, not an inventory dressed up as
   * residency. The interface docblock is explicit that satisfying this from
   * `healthCheck().modelsLoaded` rebuilds the confusion the method exists to end, and for LM Studio
   * it would be a particularly bad lie: that list is everything the operator has ever downloaded.
   */
  async listResident(): Promise<BackendResidency> {
    const native = await this.readNativeModels();
    if (native === null) {
      const health = await this.healthCheck();
      if (!health.running || !health.healthy) {
        return { backend: this.type, source: 'unreachable', models: null, error: health.error };
      }
      return { backend: this.type, source: 'unsupported', models: null };
    }

    const models: ResidentModel[] = [];
    for (const model of native) {
      const id = readString(model.id);
      if (!id || readString(model.state) !== 'loaded') continue;
      models.push({
        id,
        // LM Studio reports neither an allocation figure nor an idle expiry, and a null that means
        // "the engine did not say" must never be rendered as a zero.
        engineGpuBytes: null,
        totalBytes: null,
        expiresAt: null,
        contextLength: readNumber(model.max_context_length),
        quantization: readString(model.quantization),
      });
    }
    return { backend: this.type, source: 'measured', models };
  }

  /**
   * No pull. LM Studio downloads through its own UI or the `lms` CLI, and publishes no HTTP
   * endpoint for it — the Hub would have to drive a GUI.
   */
  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'Download models in LM Studio, or with the lms CLI', percent: 100 });
    this.logger.info('[LM Studio] Model downloads happen in LM Studio itself; the Hub serves whatever is already there');
  }

  /**
   * LM Studio loads a downloaded model when a request names it (JIT), so there is nothing to ask
   * for here and nothing to fail. Saying so beats a no-op that reads as success.
   */
  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[LM Studio] ${modelId} loads on its first request (JIT); no explicit load is needed`);
  }

  /** Unloading is LM Studio's own idle-timeout or the `lms unload` CLI; no HTTP endpoint exposes it. */
  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[LM Studio] No HTTP unload endpoint; ${modelId} unloads on LM Studio's idle timeout or via \`lms unload\``);
  }

  /** True only when the model is IN MEMORY, which is what callers of this method mean. */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const resident = await this.listResident();
    if (resident.source === 'measured') {
      return (resident.models ?? []).some((model) => model.id === modelId);
    }
    // Without the native API there is no residency to read, and the inventory is every downloaded
    // model — answering from it would call a model on disk "loaded".
    return false;
  }

  noteServingFailure(modelId: string, reason: string): void {
    const decision = this.quarantine.recordFailure(modelId, reason);
    if (decision.withheld) {
      this.logger.warn(
        `[LM Studio] Model ${modelId} is listed but failed to serve (${reason}); withholding it from routing for ${Math.round(decision.forMs / 1000)}s`,
      );
      return;
    }
    this.logger.debug(`[LM Studio] Model ${modelId} failed to serve (${reason}); strike ${decision.strikes} of ${QUARANTINE_STRIKES}`);
  }

  noteServingSuccess(modelId: string): void {
    if (this.quarantine.recordSuccess(modelId)) {
      this.logger.info(`[LM Studio] Model ${modelId} served again — no longer withheld from routing`);
    }
  }

  /** LM Studio's native listing, or `null` when it is absent, refuses, or answers something unexpected. */
  private async readNativeModels(): Promise<LmStudioNativeModel[] | null> {
    try {
      const apiKey = this.getApiKey();
      const response = await axios.get(`${this.getBaseUrl()}${LMSTUDIO_NATIVE_MODELS_PATH}`, {
        timeout: 5000,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      const rows = response.data?.data;
      return Array.isArray(rows) ? (rows as LmStudioNativeModel[]) : null;
    } catch {
      // Beta API: an older LM Studio 404s here. Every caller has an OpenAI-surface fallback.
      return null;
    }
  }

  getDockerImage(): string {
    throw new Error('LM Studio has no Docker image — it is a desktop application. Run it yourself and set LMSTUDIO_URL.');
  }

  /**
   * Declines on every vendor. LM Studio is a GUI desktop application for macOS, Windows, and Linux
   * with no server-only distribution and no container image; there is no platform on which the Hub
   * could start one. The operator runs LM Studio, enables its local server, and points
   * `LMSTUDIO_URL` at it.
   */
  getComposeConfig(): Record<string, unknown> {
    throw new Error(
      'LM Studio is a desktop application with no container image, so the Hub cannot deploy it. Start its local server ' +
        '(Developer → Start Server, and "Serve on Local Network" if the Hub is not on the same machine) and set LMSTUDIO_URL.',
    );
  }
}
