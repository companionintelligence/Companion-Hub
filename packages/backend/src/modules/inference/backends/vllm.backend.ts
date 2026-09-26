import { Injectable } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer, normalizeHostBackendUrl, resolveHostBackendProbeUrl } from './host-url.util';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
import { foreignEngineHealth, openAiModelIds } from './engine-identity';
import { OpenAiCompatibleClient } from './openai-compatible.client';

/** Candidate API key for a Re-check probe — header, not query, so it stays out of access logs. */
export const VLLM_PROBE_API_KEY_HEADER = 'x-ci-vllm-api-key';

/** Accept `http://host:8000`, `http://host:8000/` or `http://host:8000/v1` and store the bare origin. */
export const normalizeVllmBaseUrl = normalizeHostBackendUrl;

export interface VllmRemediation {
  /** Copy-pasteable `vllm serve` command for the host's viable install path. */
  command: string;
  /** Prose explaining how to get vLLM running, without the trailing probe-URL sentence. */
  hint: string;
}

/**
 * Suggested `vllm serve` command + setup hint for a host where vLLM isn't reachable yet. Apple
 * Silicon has no Docker/CUDA path at all (see getComposeConfig's `apple` branch below) — vLLM-Metal
 * (github.com/vllm-project/vllm-metal) is a native venv install that uses MLX as its compute backend
 * instead, so the suggested model is one of the catalog's `-mlx` rows (see curated-models.ts) rather
 * than the CUDA-only bitsandbytes quantization suggested elsewhere.
 */
export function buildVllmRemediation(): VllmRemediation {
  return {
    // `vllm serve <model>` is the quickstart at
    // https://docs.vllm.ai/en/latest/getting_started/quickstart.html
    // `--host` and `--port` are that CLI's bind flags, so a Hub in Docker can probe the host.
    command: 'vllm serve Qwen/Qwen3-4B-Instruct-2507 --host 0.0.0.0 --port 8000',
    hint: 'Run vLLM on an NVIDIA host, not inside Docker. Apple Silicon uses oMLX.',
  };
}

export { detectHubContainer };

/**
 * Operator `localhost` / `127.0.0.1` means the host where vLLM runs. From inside
 * the Hub container that hostname is the container itself — rewrite only then.
 */
export const resolveVllmProbeUrl = resolveHostBackendProbeUrl;

@Injectable()
export class VllmBackend implements InferenceBackend {
  readonly type = 'vllm' as const;
  private readonly api = new OpenAiCompatibleClient();

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * The vLLM server is host-run (or remote), not Hub-managed. The operator-configured URL from
   * Settings wins over the compose-injected VLLM_URL env; read per-call rather than caching in the
   * constructor so a Settings change takes effect without a Hub restart.
   */
  getBaseUrl(): string {
    const configured = this.configuration.getInferencePreferences().preferredVllmUrl?.trim();
    return resolveVllmProbeUrl(configured || process.env.VLLM_URL || 'http://ci-hub-vllm:8000');
  }

  private vllmAuthKey(apiKeyOverride?: string): string | undefined {
    return apiKeyOverride?.trim() || this.configuration.getInferencePreferences().preferredVllmApiKey?.trim() || process.env.VLLM_API_KEY?.trim();
  }

  /** Overrides let status + onboarding probe unsaved Settings input without persisting it. */
  async healthCheck(baseUrlOverride?: string, apiKeyOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveVllmProbeUrl(baseUrlOverride) : this.getBaseUrl();
    try {
      const body = await this.api.fetchModels(baseUrl, {
        timeout: 5000,
        apiKey: this.vllmAuthKey(apiKeyOverride),
      });
      // mtplx and lucebox default to this same host port; whoever is actually listening there
      // says so in `owned_by`, and only that backend gets to offer its models.
      const foreign = foreignEngineHealth('vllm', body, baseUrl);
      if (foreign) return foreign;
      return {
        running: true,
        healthy: true,
        modelsLoaded: openAiModelIds(body),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const hint = status === 401 ? 'vLLM rejected the API key — it must match the --api-key you passed when starting vLLM.' : undefined;
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: hint ? `${message}. ${hint}` : message,
      };
    }
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      return await this.api.listModels(this.getBaseUrl(), {
        timeout: 10000,
        apiKey: this.vllmAuthKey(),
        claimedBy: 'vllm',
      });
    } catch {
      return [];
    }
  }

  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    // vLLM loads models at container startup via command-line args.
    // Pulling means downloading from HuggingFace to a shared volume.
    onProgress?.({ status: 'vLLM models are configured at container startup', percent: 100 });
    this.logger.info('[vLLM] Model configuration requires container restart with updated --model flag');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[vLLM] Load model request for ${modelId} — requires container restart with --model=${modelId}`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[vLLM] Unload model request for ${modelId} — requires container restart`);
  }

  /*
   * No `listResident()`, deliberately — this backend reports `source: 'unsupported'`.
   *
   * The obvious candidate is the Prometheus gauge `vllm:engine_sleep_state{sleep_state="awake"}`
   * on `/metrics`, and it looks like residency. It is not: it is a latch written once at logger
   * construction and mutated only by `AsyncLLM.sleep()` / `wake_up()`, whose sole entry points
   * are the dev-mode routes `/sleep` and `/wake_up` — both 404 on every node in this fleet. It
   * therefore reads "awake" whether the engine is serving, evicted, crashed or hung, and
   * distinguishes only "somebody called the sleep API" from "nobody did".
   *
   * It would be reportable on a server launched with BOTH `--enable-sleep-mode` and
   * `VLLM_SERVER_DEV_MODE=1`, which nothing here is. Until then a gauge that cannot go false
   * is worse than no gauge: it would render a crashed engine as resident.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return 'vllm/vllm-openai:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    if (gpuVendor === 'apple') {
      // Docker Desktop on macOS has no Metal passthrough, so the CUDA-only `vllm/vllm-openai` image
      // can only ever run this container CPU-bound — pointless for a backend chosen for GPU speed.
      // The real Apple Silicon path is vLLM-Metal (github.com/vllm-project/vllm-metal), a
      // community-maintained plugin that uses MLX as its compute backend: it installs into a native
      // venv on the host (no Docker) and is started with the ordinary `vllm serve` CLI once
      // activated. Decline the Docker deploy outright — same posture as the `amd` branch below —
      // rather than silently hand back a container that can't do what it was asked for; the operator
      // installs vLLM-Metal themselves and points Settings → vLLM URL at it (see buildVllmRemediation
      // and the catalog's `-mlx` rows in curated-models.ts for the models it can serve).
      throw new Error(
        'vLLM has no Docker path on Apple Silicon (Docker Desktop cannot reach Metal). Install vLLM-Metal natively ' +
          '(github.com/vllm-project/vllm-metal) and point Settings → vLLM URL at it instead.',
      );
    }
    if (gpuVendor === 'amd') {
      // vLLM has no reliably maintained ROCm image for the AMD hardware CI-Hub actually detects
      // (the Strix Halo APU, gfx1151, and consumer Radeon GPUs). The upstream `vllm/vllm-openai-rocm`
      // image (official as of the vLLM v0.14.0 release pipeline) is validated only for MI-series
      // data-center accelerators (gfx942/gfx950). The one image that does advertise gfx1151 support —
      // AMD's `rocm/vllm-dev` — is a CI/dev image rebuilt hourly under commit-hash tags, not a stable
      // release artifact, so pinning to it in production compose config would be fragile and likely to
      // break silently on rebuild. Decline AMD outright rather than mount /dev/kfd + /dev/dri into the
      // CUDA-only `vllm/vllm-openai` image, which can't use them. Ollama already covers AMD GPUs
      // correctly (ROCm when ready, Vulkan/RADV fallback otherwise) — see OllamaBackend.
      throw new Error(
        'vLLM has no reliably maintained ROCm image for AMD GPUs (upstream vllm/vllm-openai-rocm targets MI-series ' +
          'data-center accelerators only). Use the Ollama backend for AMD hardware instead.',
      );
    }

    const base: Record<string, unknown> = {
      image: this.getDockerImage(),
      container_name: 'ci-hub-vllm',
      restart: 'unless-stopped',
      ports: ['8000:8000'],
      volumes: ['vllm-data:/root/.cache/huggingface'],
    };

    if (gpuVendor === 'nvidia') {
      base.deploy = {
        resources: {
          reservations: { devices: [{ capabilities: ['gpu'], count: 'all' }] },
        },
      };
      base.runtime = 'nvidia';
    }

    return base;
  }
}
