import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
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
      'Install from https://github.com/jundot/omlx with the command above. `omlx serve --model-dir ~/models` runs it in the foreground instead.',
  };
}

/** Candidate API key for a Re-check probe — header, not query, so it stays out of access logs. */
export const OMLX_PROBE_API_KEY_HEADER = 'x-ci-omlx-api-key';

export const resolveOmlxProbeUrl = resolveHostBackendProbeUrl;

/**
 * Reported without probing when the host is not Apple Silicon and no oMLX URL is set. oMLX's
 * default port is vLLM's, so on a Linux node the default URL can only reach vLLM or nothing.
 */
export const OMLX_NOT_APPLE_SILICON_ERROR =
  'oMLX runs only on Apple Silicon and this host is not, so the Hub does not probe for it. ' +
  'To use an oMLX server on another machine, set its URL in Settings → AI or OMLX_URL.';

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

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly hardwareInspector: HardwareInspectorService,
  ) {}

  getBaseUrl(): string {
    const host = detectHubContainer() ? 'host.docker.internal' : 'localhost';
    return resolveOmlxProbeUrl(this.configuredUrl() || `http://${host}:${OMLX_DEFAULT_PORT}`);
  }

  getApiKey(apiKeyOverride?: string): string | undefined {
    return apiKeyOverride?.trim() || process.env.OMLX_API_KEY?.trim() || undefined;
  }

  /**
   * The key a probe of `probeUrl` carries: one typed for this probe goes wherever the operator is
   * probing, and OMLX_API_KEY only to the oMLX server it is configured for (`getBaseUrl`, compared
   * by `isSameServer`). `omlx/status` and `onboarding-profile` hand their `?url=` straight to
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
            ? " oMLX asks for an API key on /v1/models once it listens beyond loopback. OMLX_API_KEY is sent only to the configured oMLX URL; enter this server's key to check it."
            : ' oMLX asks for an API key on /v1/models once it listens beyond loopback. Set OMLX_API_KEY to one of its keys.'
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
    return { running: true, healthy: true, modelsLoaded: openAiModelIds(body) };
  }

  /** From {@link healthCheck}, so the model list and the status agree on whose server this is. */
  async listModels(): Promise<BackendModelInfo[]> {
    const health = await this.healthCheck();
    return health.healthy ? health.modelsLoaded.map((id) => ({ id, name: id, size: 0, loaded: true })) : [];
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'Download MLX weights in oMLX (admin) or with a Hugging Face login on this machine', percent: 100 });
    this.logger.info(`[oMLX] Model ${modelId} is downloaded by oMLX from Hugging Face, not by the Hub`);
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Load ${modelId} from the oMLX admin UI or by placing the MLX checkpoint in the model directory`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[oMLX] Unload ${modelId} from the oMLX admin UI`);
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    throw new Error('oMLX has no Docker image. Install it on the Apple Silicon host and point the Hub at http://host.docker.internal:8000.');
  }

  getComposeConfig(): Record<string, unknown> {
    throw new Error('oMLX has no Docker path. It runs on the Apple Silicon host (brew install jundot/omlx/omlx && omlx start).');
  }
}
