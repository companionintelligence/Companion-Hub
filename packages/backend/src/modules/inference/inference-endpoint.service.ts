import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { hubContainerName } from '@/common/constants';
import { HubPoolPeerService } from '@/modules/hub-pool/hub-pool-peer.service';
import { InferenceBackendRegistry } from './backends/backend-registry';
import type { InferenceBackend } from './backends/backend.interface';
import { OllamaBackend } from './backends/ollama.backend';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import type { BackendHealthStatus, InferenceBackendType } from '@ci-hub/common/types';

/** The backend an app should actually be pointed at, plus the health probe that decided it. */
export interface ActiveInferenceBackend {
  backendType: InferenceBackendType;
  backend: InferenceBackend;
  /** The probe for `backend` — reuse it rather than probing again; `modelsLoaded` is its inventory. */
  health: BackendHealthStatus;
  ready: boolean;
}

/**
 * App-facing inference URLs that the pool proxy can stand in front of. Every field is optional
 * and a field left `undefined` stays `undefined` — callers pass only what they actually emit.
 */
export interface PoolRoutableEndpoints {
  /** OpenAI-compatible base URL, already ending in `/v1`. */
  openAiBaseUrl?: string;
  /** Ollama's native (non-OpenAI) protocol URL. */
  ollamaHost?: string;
  /** Native Ollama URL dedicated to embeddings, when the caller emits one separately. */
  ollamaEmbedHost?: string;
}

/**
 * The one place that answers "which backend serves this node's apps, and at what URL".
 *
 * Both app-config paths ask it:
 *   - {@link InferenceEnvResolver} — bakes `CI_*` vars into an app's generated `app.env` at
 *     install/start time.
 *   - {@link AppCredentialsService} — serves `/api/inference/apps/:slug/credentials(.env)`, which
 *     is how apps that bootstrap their inference config at runtime (CI-OpenClaw, CI-Hermes) get
 *     theirs.
 *
 * They existed with independent copies of both decisions below, and the copies had already
 * drifted: only the `app.env` path applied the pool override, so on a Hub with connected peers an
 * app that bootstrapped over HTTP was handed a direct backend URL and never used the pool at all.
 * Anything that must hold for "the endpoint an app is told to use" belongs here, not in either
 * caller, for the same reason {@link InferenceBackendRegistry} replaced five copies of a
 * type-to-backend switch.
 */
@Injectable()
export class InferenceEndpointService {
  constructor(
    private readonly logger: LoggerService,
    private readonly backends: InferenceBackendRegistry,
    private readonly ollamaBackend: OllamaBackend,
    // forwardRef: InferenceModule and HubPoolModule import each other.
    @Inject(forwardRef(() => HubPoolPeerService))
    private readonly hubPoolPeerService: HubPoolPeerService,
  ) {}

  /**
   * The backend that should actually serve apps, given the operator's stored preference.
   *
   * Two degradations, both of which used to be a caller's private business:
   *
   * 1. An *unknown* preference. `preferredBackend` comes from settings.json, which is read off
   *    disk and typed by assertion rather than validated, so `?? 'ollama'` catches an absent
   *    preference but not a retired or mistyped one. `registry.get()` throws on those; a throw
   *    here would stop every app on the node from getting any inference config over one bad
   *    character in a file the operator hand-edits. Degrade to Ollama and name the rejected value.
   *
   * 2. A *known but unavailable* preference. This is the one that was a real defect: with
   *    `inferenceBackend: "vllm"` and no vLLM process running, both callers treated "my preferred
   *    backend is down" as "this node has no local inference" — apps fell back to cloud, or (with
   *    no cloud provider configured) were handed no inference env at all — while a healthy Ollama
   *    with models pulled sat on the same host. A preference is a preference, not a veto: when it
   *    cannot be honored, a working local backend beats both cloud and nothing.
   *
   * Ollama is the only fallback target because it is the Hub-managed default — the backend the
   * appliance installs and supervises, and the one embeddings already fall back to. The other five
   * are host-managed servers an operator starts themselves; silently promoting one of those would
   * be inventing a choice the operator never made.
   *
   * `context` only tags the logs with the caller's name.
   */
  async resolveActiveBackend(preferred: InferenceBackendType | null, context: string): Promise<ActiveInferenceBackend> {
    const requested = this.resolveConfiguredBackend(preferred, context);
    const health = await this.probe(requested.backend, requested.backendType, context);
    const ready = !!(health.running && health.healthy);

    if (ready || requested.backendType === 'ollama') {
      // Nothing to degrade to when Ollama itself is the unavailable one: the caller's own
      // cloud/omit handling is the correct answer there, and probing it twice would only add a
      // second failing request to every app install on a node with no local inference at all.
      return { backendType: requested.backendType, backend: requested.backend, health, ready };
    }

    const ollamaHealth = await this.probe(this.ollamaBackend, 'ollama', context);
    if (!(ollamaHealth.running && ollamaHealth.healthy)) {
      return { backendType: requested.backendType, backend: requested.backend, health, ready: false };
    }

    this.logger.warn(
      `[${context}] preferred backend '${requested.backendType}' is not running; serving apps from the healthy local ` +
        `ollama instead (${ollamaHealth.modelsLoaded.length} model(s) available). Change the inference backend ` +
        `preference, or start ${requested.backendType}, to silence this.`,
    );
    return { backendType: 'ollama', backend: this.ollamaBackend, health: ollamaHealth, ready: true };
  }

  /** This Hub's own pool proxy prefix, reachable container-to-container from an installed app. */
  private poolBaseUrl(): string {
    return `http://${hubContainerName()}:${process.env.API_PORT || '3000'}/api/inference/pool`;
  }

  /**
   * Rewrite an app's inference URLs to this Hub's pool proxy once any peer is connected.
   *
   * A global override with no per-app opt-in: with zero connected peers it returns `endpoints`
   * untouched, so a single-node Hub behaves exactly as it did before pooling existed. Model and
   * context values are deliberately NOT touched — the proxy uses the model name the caller already
   * resolved to pick whichever pool node actually has it.
   *
   * Apps need no extra credential for this: the pool's app-facing routes are guarded by
   * `InternalNetworkGuard` + `PoolAppGuard`, which is an origin check (is this request from inside
   * the appliance?), not caller authentication.
   */
  async routeThroughPool<T extends PoolRoutableEndpoints>(endpoints: T, context: string): Promise<T> {
    if (!(await this.hasConnectedPeers(context))) {
      return endpoints;
    }

    const poolBaseUrl = this.poolBaseUrl();
    const routed: T = { ...endpoints };
    if (routed.openAiBaseUrl) routed.openAiBaseUrl = `${poolBaseUrl}/v1`;
    if (routed.ollamaHost) routed.ollamaHost = poolBaseUrl;
    if (routed.ollamaEmbedHost) routed.ollamaEmbedHost = poolBaseUrl;

    this.logger.info(`[${context}] connected pool peer(s) present; routing app inference through the pool proxy at ${poolBaseUrl}`);
    return routed;
  }

  /**
   * Peer lookup hits the database, and both callers run on the app install/start path. A pool
   * table that cannot be read is a reason to keep apps on their direct backend URL, not a reason
   * to fail the install — so a throw degrades to "no peers" rather than propagating.
   */
  private async hasConnectedPeers(context: string): Promise<boolean> {
    try {
      return await this.hubPoolPeerService.hasConnectedPeers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${context}] could not determine pool peer state (${message}); leaving app inference on the direct backend URL.`);
      return false;
    }
  }

  private resolveConfiguredBackend(
    preferred: InferenceBackendType | null,
    context: string,
  ): { backendType: InferenceBackendType; backend: InferenceBackend } {
    const requested = preferred ?? 'ollama';
    const backend = this.backends.tryGet(requested);
    if (backend) {
      return { backendType: requested, backend };
    }
    this.logger.error(
      `[${context}] stored inference backend '${requested}' is not a known backend; falling back to ollama. ` +
        `Valid backends: ${INFERENCE_BACKEND_TYPES.join(', ')}.`,
    );
    return { backendType: 'ollama', backend: this.ollamaBackend };
  }

  /** A health check that never throws — a dead backend must read as "not ready", not as an exception. */
  private async probe(backend: InferenceBackend, backendType: InferenceBackendType, context: string): Promise<BackendHealthStatus> {
    try {
      return await backend.healthCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${context}] ${backendType} health check failed: ${message}`);
      return { running: false, healthy: false, modelsLoaded: [] };
    }
  }
}
