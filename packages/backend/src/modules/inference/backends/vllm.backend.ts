import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

/** Candidate API key for a Re-check probe — header, not query, so it stays out of access logs. */
export const VLLM_PROBE_API_KEY_HEADER = 'x-ci-vllm-api-key';

/** Accept `http://host:8000`, `http://host:8000/` or `http://host:8000/v1` and store the bare origin. */
export function normalizeVllmBaseUrl(url: string): string {
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
 * Operator `localhost` / `127.0.0.1` means the host where vLLM runs. From inside
 * the Hub container that hostname is the container itself — rewrite only then.
 */
export function resolveVllmProbeUrl(url: string, inContainer: boolean = detectHubContainer()): string {
  const normalized = normalizeVllmBaseUrl(url);
  if (!inContainer) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
      parsed.hostname = 'host.docker.internal';
      return normalizeVllmBaseUrl(parsed.toString());
    }
  } catch {
    // Keep normalized input; healthCheck will surface a bad URL.
  }
  return normalized;
}

@Injectable()
export class VllmBackend implements InferenceBackend {
  readonly type = 'vllm' as const;

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

  private vllmAuthHeaders(apiKeyOverride?: string): Record<string, string> | undefined {
    const apiKey =
      apiKeyOverride?.trim() || this.configuration.getInferencePreferences().preferredVllmApiKey?.trim() || process.env.VLLM_API_KEY?.trim();
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  }

  /** Overrides let status + onboarding probe unsaved Settings input without persisting it. */
  async healthCheck(baseUrlOverride?: string, apiKeyOverride?: string): Promise<BackendHealthStatus> {
    const baseUrl = baseUrlOverride ? resolveVllmProbeUrl(baseUrlOverride) : this.getBaseUrl();
    try {
      const response = await axios.get(`${baseUrl}/v1/models`, {
        timeout: 5000,
        headers: this.vllmAuthHeaders(apiKeyOverride),
      });
      const models = response.data?.data ?? [];
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m: { id: string }) => m.id),
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
      const response = await axios.get(`${this.getBaseUrl()}/v1/models`, {
        timeout: 10000,
        headers: this.vllmAuthHeaders(),
      });
      const models = response.data?.data ?? [];
      return models.map((m: { id: string; owned_by?: string }) => ({
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

  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return 'vllm/vllm-openai:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
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
