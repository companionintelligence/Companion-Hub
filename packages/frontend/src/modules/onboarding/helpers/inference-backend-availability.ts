import type { InferenceBackendType } from '@ci-hub/common/types';

import type { HardwareProfileResponse } from './ai-setup-types';

/**
 * Backends grayed out in the backend picker. All registered local backends are selectable; their
 * setup cards are responsible for showing whether the operator's endpoint is reachable.
 *
 * vLLM, MTPLX, and mlx-dspark are always selectable: all are host-run (or remote)
 * OpenAI-compatible endpoints, so the real gate is the live endpoint probe in their setup cards —
 * not the local GPU or, for MTPLX/mlx-dspark, whether the Mac is Apple Silicon. Hardware still
 * drives which backend is *recommended* (server-side `getRecommendedBackend`), and the catalog only
 * recommends vLLM models that fit an NVIDIA VRAM budget, and MTPLX/mlx-dspark models that
 * fit an Apple-Silicon unified-memory budget (their rows are `gpuVendors: ['apple']`).
 */
export function unavailableInferenceBackends(_profile: HardwareProfileResponse): InferenceBackendType[] {
  return [];
}

/**
 * Backends that should be omitted from the picker for the detected host. The profile's OS is the
 * source of truth here — the browser may be connected from a different machine than the Hub.
 */
export function hiddenInferenceBackends(profile: HardwareProfileResponse): InferenceBackendType[] {
  return profile.hardware.os?.platform?.toLowerCase() === 'darwin' ? ['lemonade'] : [];
}

/**
 * Backends served by a process the operator runs, rather than pulled into a Hub-managed registry.
 * The Hub cannot download a model for these — the model has to be present on the serving host — so
 * the UI links out to Hugging Face instead of offering a pull, and "installed" means "the server
 * reports it is serving this".
 */
export function isHostServedBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'vllm' || backend === 'mtplx' || backend === 'dspark';
}

/**
 * Backends the Hub can install a model into ITSELF, and therefore the ones a save should pull.
 *
 * Note this is not the complement of {@link isHostServedBackend} — mlx-dspark is both. It is
 * host-run (the Hub only holds a URL for it), yet it accepts `POST /admin/load` over HTTP, so the
 * Hub can put a model into it. Lemonade accepts pull/load requests through its API even though the
 * server itself runs separately. vLLM cannot hot-swap a running server, which is why
 * their rows link out to Hugging Face instead of offering a pull.
 */
export function isHubLoadableBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'ollama' || backend === 'lemonade' || backend === 'dspark';
}

/**
 * Narrow a selection to the models a save should actually install, given what each backend holds.
 *
 * Ollama accumulates: every model it pulls stays available, so all its rows install. mlx-dspark
 * holds exactly ONE resident target+drafter pair — `/admin/load` swaps rather than adds — so
 * installing a whole ticked list would download tens of gigabytes and leave only whichever load
 * finished last actually served, while the registry recorded all of them as loaded. Install just
 * the one the operator picked as their default (falling back to the first ticked row).
 *
 * vLLM rows are dropped: that server must be restarted with a new model.
 */
export function hubLoadableSelection(
  selectedIds: string[],
  backendOf: (modelId: string) => InferenceBackendType | undefined,
  preferredModelId?: string | null,
): string[] {
  const ollamaIds = selectedIds.filter((id) => backendOf(id) === 'ollama');
  const lemonadeIds = selectedIds.filter((id) => backendOf(id) === 'lemonade');
  const dsparkIds = selectedIds.filter((id) => backendOf(id) === 'dspark');
  if (dsparkIds.length === 0) {
    return [...ollamaIds, ...lemonadeIds];
  }
  const resident = preferredModelId && dsparkIds.includes(preferredModelId) ? preferredModelId : dsparkIds[0];
  return resident ? [...ollamaIds, ...lemonadeIds, resident] : [...ollamaIds, ...lemonadeIds];
}

/** Embeddings always resolve against Ollama, even when chat runs on vLLM or mlx-dspark. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
