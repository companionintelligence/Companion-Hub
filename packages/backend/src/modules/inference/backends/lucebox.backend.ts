import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from './amd-device-groups.util';
import type { InferenceBackend } from './backend.interface';
import { detectHubContainer } from './vllm.backend';
import { OpenAiCompatibleClient } from './openai-compatible.client';

/** Accept `http://host:8000`, `http://host:8000/` or `http://host:8000/v1`. */
export function normalizeLuceboxBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * The speculative inference server is normally started on the host. When an
 * operator enters localhost in a desktop/Hub container, resolve it to the
 * Docker host instead of probing the Hub container itself.
 */
export function resolveLuceboxProbeUrl(url: string, inContainer: boolean = detectHubContainer()): string {
  const normalized = normalizeLuceboxBaseUrl(url);
  if (!inContainer) return normalized;

  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
      parsed.hostname = 'host.docker.internal';
      return normalizeLuceboxBaseUrl(parsed.toString());
    }
  } catch {
    // Keep the normalized input; healthCheck will return the useful request error.
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Deployment contract
//
// The constants and helpers below are the deployment contract for the Lucebox
// container. They mirror a rollout proven on the Strix Halo fleet; each value
// that looks arbitrary is load-bearing and is commented with the failure it
// prevents.
// ---------------------------------------------------------------------------

export const LUCEBOX_CUDA_IMAGE = 'ghcr.io/luce-org/lucebox-hub:cuda12';

/**
 * ROCm 6.4.1. Do **not** use this tag on RDNA 3.5 (`gfx115x`, the Ryzen AI Max+/Strix Halo
 * APUs and their Radeon 8060S iGPU): the runtime loads, enumerates the device and allocates
 * fine, then SIGSEGVs on the first host-to-device `hipMemcpy`. This was isolated with a
 * minimal in-container HIP program — `hipGetDeviceCount`, `hipGetDeviceProperties` and
 * `hipMalloc` all succeed and only the copy dies — and it is *not* a host-ROCm mismatch:
 * the affected nodes have no `/opt/rocm` installed at all. Kept exported so the guard below
 * can name it, not because anything should select it.
 */
export const LUCEBOX_ROCM_LEGACY_IMAGE = 'ghcr.io/luce-org/lucebox-hub:rocm';

/** ROCm 7.2.2 (`libamdhip64.so.7`) — the tag verified serving on gfx1151. */
export const LUCEBOX_ROCM_IMAGE = 'ghcr.io/luce-org/lucebox-hub:rocm-7.2';

/** Where the compose service expects its GGUF weights *inside* the container. */
export const LUCEBOX_MODELS_MOUNT = '/opt/lucebox-hub/server/models';

/** Host directory bind-mounted at {@link LUCEBOX_MODELS_MOUNT}. */
export const LUCEBOX_DEFAULT_MODELS_DIR = '/opt/lucebox-models';

/** Target model filename, relative to the models mount. */
export const LUCEBOX_DEFAULT_TARGET_MODEL = 'Qwen3.6-27B-Q4_K_M.gguf';

/**
 * Draft model, relative to the models mount. Only Lucebox's own converted drafters work:
 * z-lab DFlash2 checkpoints declare `general.architecture=dflash` and are rejected by the
 * server, which demands `qwen35-dflash-draft`.
 */
export const LUCEBOX_DEFAULT_DRAFT_MODEL = 'drafter/dflash-draft-3.6-q4_k_m.gguf';

/**
 * RDNA 3.5 parts, whose LLVM targets are `gfx1150`–`gfx1153`. These are the architectures
 * that segfault on {@link LUCEBOX_ROCM_LEGACY_IMAGE}; `gfx1151` is the one measured directly.
 */
export function isRocmLegacyBrokenArch(gpuArch: string): boolean {
  return /^gfx115\d$/i.test(gpuArch.trim());
}

/**
 * The one sentence that explains this failure, so the guard below and the supervision diagnosis in
 * `supervision/backend-failure-diagnosis.ts` say the same thing rather than two paraphrases that
 * drift apart. `arch` is whatever the caller can honestly name: an exact LLVM target when one was
 * detected, or the family (`gfx115x`) when the evidence is the segfault itself — nothing in this
 * repo produces a `gfx*` string at runtime, so a diagnosis reached from a crashing container has
 * only the family to offer.
 */
export function luceboxRocmLegacyImageMessage(arch: string): string {
  return (
    `Lucebox image ${LUCEBOX_ROCM_LEGACY_IMAGE} ships ROCm 6.4.1, which SIGSEGVs on the first hipMemcpy for ${arch} ` +
    `(RDNA 3.5 / Strix Halo). Use ${LUCEBOX_ROCM_IMAGE} (ROCm 7.2.2) for this GPU.`
  );
}

/**
 * Guard the image-tag/GPU-arch pairing. Pinning the ROCm 6.4.1 tag on an RDNA 3.5 part
 * produces a container that starts, passes `/health`, and then dies inside the first
 * generation — an expensive failure to diagnose from the outside, so refuse it up front.
 */
export function assertLuceboxImageSupportsArch(image: string, gpuArch?: string): void {
  const arch = gpuArch?.trim();
  if (!arch || !isRocmLegacyBrokenArch(arch)) return;
  if (image.trim() !== LUCEBOX_ROCM_LEGACY_IMAGE) return;

  throw new Error(luceboxRocmLegacyImageMessage(arch));
}

/**
 * AMD image selection. ROCm 7.2 supports a superset of the hardware ROCm 6.4.1 does, so it is
 * also the right default when the architecture is unknown — an undetected GPU must not silently
 * get the tag that segfaults.
 */
export function resolveLuceboxRocmImage(_gpuArch?: string): string {
  // Deliberately unconditional. Older parts (e.g. gfx1100) run on either tag, RDNA 3.5 runs
  // only on this one, and an undetected GPU must not fall back to the tag that segfaults —
  // so there is no architecture for which the ROCm 6.4.1 image is the better choice. The
  // parameter is kept so callers can pass what they detected and so
  // `assertLuceboxImageSupportsArch` can still reject an explicit bad pin.
  return LUCEBOX_ROCM_IMAGE;
}

/** Extra deployment hints beyond the shared `{ rocmReady, unifiedMemory }` pair. */
export interface LuceboxComposeOptions {
  rocmReady?: boolean;
  unifiedMemory?: boolean;
  /** AMD LLVM target of the detected GPU, e.g. `gfx1151` (Strix Halo) or `gfx1100`. */
  gpuArch?: string;
  /** Host directory holding the GGUF weights; bind-mounted read-only. */
  modelsDir?: string;
  /** Target/draft filenames relative to the models mount. */
  targetModel?: string;
  draftModel?: string;
  /** Host address the API is published on. Defaults to loopback, never 0.0.0.0. */
  bindAddress?: string;
  hostPort?: number;
  /** Numeric host GIDs for the GPU device nodes; derived from `/dev` when omitted. */
  groupIds?: number[];
  /** Explicit image override — still validated against `gpuArch`. */
  image?: string;
  /** Test seam for {@link resolveAmdDeviceGroupIds}. */
  deviceProbe?: DeviceGroupProbe;
}

/**
 * This backend exposes a model-independent OpenAI-compatible API. Models are
 * loaded when the server starts, so the Hub discovers them but never pulls or
 * unloads them through a provider-specific lifecycle endpoint.
 */
@Injectable()
export class LuceboxBackend implements InferenceBackend {
  readonly type = 'lucebox' as const;
  private readonly api = new OpenAiCompatibleClient();

  constructor(private readonly logger: LoggerService) {}

  getBaseUrl(): string {
    const configured = process.env.SPECULATIVE_INFERENCE_URL?.trim() || process.env.LUCEBOX_URL?.trim();
    // The default deployment publishes host port 8000. Native launches and
    // remote servers can override this with SPECULATIVE_INFERENCE_URL.
    const defaultUrl = detectHubContainer() ? 'http://host.docker.internal:8000' : 'http://localhost:8000';
    return resolveLuceboxProbeUrl(configured || defaultUrl);
  }

  /**
   * `/health` only proves the HTTP server is up: Lucebox answers it while the target GGUF is
   * missing or still loading, and such a server accepts a completion and then fails it. Treat
   * the backend as healthy only once it also reports a model on `/v1/models`, the same
   * "readiness, not reachability" posture the vLLM and mlx-dspark backends use.
   */
  async healthCheck(): Promise<BackendHealthStatus> {
    const status = await this.api.healthCheck(this.getBaseUrl(), { healthPath: '/health', timeout: 5000 });
    if (!status.healthy) return status;

    if (status.modelsLoaded.length === 0) {
      return {
        running: true,
        healthy: false,
        modelsLoaded: [],
        error:
          'Lucebox answered /health but reports no loaded model — the server is running without weights. ' +
          'Check DFLASH_TARGET/DFLASH_DRAFT and that the models directory is bind-mounted.',
      };
    }

    return status;
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      return await this.api.listModels(this.getBaseUrl());
    } catch {
      return [];
    }
  }

  async pullModel(_modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    onProgress?.({ status: 'Speculative inference models are configured when the server starts', percent: 100 });
    this.logger.info('[Speculative inference] Models are loaded from the server startup configuration; no pull was requested');
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[Speculative inference] Load model request for ${modelId} — restart the server with the target model`);
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Speculative inference] Unload model request for ${modelId} — restart the server to change the target model`);
  }

  /*
   * No `listResident()`, deliberately — this backend reports `source: 'unsupported'`.
   *
   * Every endpoint was checked and none measures residency: `/props`, `/status/json`,
   * `/health` and `/v1/models` answer IDENTICALLY whether weights are loaded or not, verified
   * live on core-7 against a container holding 860 MiB RSS for a 15.66 GiB GGUF — i.e. the
   * weights were plainly NOT loaded while every endpoint said the same thing it says when they
   * are.
   *
   * `daemon.alive` looks like the answer and is a trap: it is emitted by the same and only
   * process that serves `/props`, so it is `true` in every response that can be received. An
   * implementation reading it produced a live false "resident" during review. `model_path` and
   * `model.draft_path` are disk paths.
   */
  async isModelLoaded(modelId: string): Promise<boolean> {
    const health = await this.healthCheck();
    return health.modelsLoaded.includes(modelId);
  }

  getDockerImage(): string {
    return LUCEBOX_CUDA_IMAGE;
  }

  getComposeConfig(gpuVendor: string, options?: LuceboxComposeOptions): Record<string, unknown> {
    const modelsDir = options?.modelsDir?.trim() || LUCEBOX_DEFAULT_MODELS_DIR;
    const targetModel = options?.targetModel?.trim() || LUCEBOX_DEFAULT_TARGET_MODEL;
    const draftModel = options?.draftModel?.trim() || LUCEBOX_DEFAULT_DRAFT_MODEL;
    const bindAddress = options?.bindAddress?.trim() || '127.0.0.1';
    const hostPort = options?.hostPort ?? 8000;

    const image = options?.image?.trim() || (gpuVendor === 'amd' ? resolveLuceboxRocmImage(options?.gpuArch) : this.getDockerImage());
    assertLuceboxImageSupportsArch(image, options?.gpuArch);

    const base: Record<string, unknown> = {
      image,
      container_name: 'ci-hub-lucebox',
      restart: 'unless-stopped',
      // The image listens on 8080 inside the container. Publish it on an explicit host
      // address: a bare `8000:8080` binds 0.0.0.0, which exposes the server on every network
      // the appliance is attached to — these boxes are also on an operator's home LAN.
      ports: [`${bindAddress}:${hostPort}:8080`],
      // A *named* volume starts empty, so the entrypoint finds no target GGUF and exits. The
      // weights are host-managed and large (~17 GB), so bind-mount them read-only instead.
      volumes: [`${modelsDir}:${LUCEBOX_MODELS_MOUNT}:ro`],
      // Without these the entrypoint has no model paths and the container cannot start at all.
      environment: {
        DFLASH_TARGET: `${LUCEBOX_MODELS_MOUNT}/${targetModel}`,
        DFLASH_DRAFT: `${LUCEBOX_MODELS_MOUNT}/${draftModel}`,
        DFLASH27B_DRAFT_SWA: '2048',
        // Container-internal listen address. This must stay 0.0.0.0 or the published port
        // above cannot reach it; host exposure is limited by `ports`, not by this value.
        DFLASH_HOST: '0.0.0.0',
        DFLASH_PORT: '8080',
        DFLASH_MAX_CTX: '16384',
        DFLASH_CACHE_TYPE_K: 'q8_0',
        DFLASH_CACHE_TYPE_V: 'q8_0',
        DFLASH_MODEL_NAME: 'qwen36-27b',
      },
    };

    if (gpuVendor === 'nvidia') {
      base.deploy = {
        resources: {
          reservations: { devices: [{ capabilities: ['gpu'], count: 'all' }] },
        },
      };
      base.runtime = 'nvidia';
    } else if (gpuVendor === 'amd') {
      base.devices = ['/dev/kfd', '/dev/dri'];

      const groupIds = options?.groupIds ?? resolveAmdDeviceGroupIds(options?.deviceProbe);
      if (groupIds.length === 0) {
        throw new Error(
          'Cannot derive the host GIDs for /dev/kfd and /dev/dri, so an AMD Lucebox deployment would be generated ' +
            'without GPU device permissions. Run this on the GPU host, or pass groupIds explicitly.',
        );
      }
      // Numeric GIDs only — group *names* resolve against the container's /etc/group, not the host's.
      base.group_add = groupIds.map(String);
      base.security_opt = ['seccomp=unconfined'];
    }

    return base;
  }
}
