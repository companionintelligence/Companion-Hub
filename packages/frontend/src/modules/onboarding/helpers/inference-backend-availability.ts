import type { InferenceBackendType } from '@ci-hub/common/types';

import type { HardwareProfileResponse } from './ai-setup-types';

/**
 * Backends grayed out in the backend picker. Only Lemonade is held back (dark-launched pending
 * NPU detection — see CI-Hub#1104).
 *
 * vLLM and mlx-dspark are always selectable: both are host-run (or remote) OpenAI-compatible
 * endpoints, so the real gate is the live endpoint probe in their setup cards — not the local GPU.
 * Hardware still drives which backend is *recommended* (server-side `getRecommendedBackend`), and
 * the catalog only recommends vLLM models that fit an NVIDIA VRAM budget, and mlx-dspark models on
 * Apple Silicon (their rows are `gpuVendors: ['apple']`).
 */
export function unavailableInferenceBackends(_profile: HardwareProfileResponse): InferenceBackendType[] {
  return ['lemonade'];
}

/**
 * Backends served by a process the operator runs, rather than pulled into a Hub-managed registry.
 * The Hub cannot download a model for these — the model has to be present on the serving host — so
 * the UI links out to Hugging Face instead of offering a pull, and "installed" means "the server
 * reports it is serving this".
 */
export function isHostServedBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'vllm' || backend === 'dspark';
}

/**
 * Backends the Hub can install a model into ITSELF, and therefore the ones a save should pull.
 *
 * Note this is not the complement of {@link isHostServedBackend} — mlx-dspark is both. It is
 * host-run (the Hub only holds a URL for it), yet it accepts `POST /admin/load` over HTTP, so the
 * Hub can put a model into it. vLLM cannot: there is no way to load a model into a running host
 * vLLM server, which is why its rows link out to Hugging Face instead of offering a pull.
 */
export function isHubLoadableBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'ollama' || backend === 'dspark';
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
 * vLLM and Lemonade rows are dropped: the Hub has no way to install into them.
 */
export function hubLoadableSelection(
  selectedIds: string[],
  backendOf: (modelId: string) => InferenceBackendType | undefined,
  preferredModelId?: string | null,
): string[] {
  const ollamaIds = selectedIds.filter((id) => backendOf(id) === 'ollama');
  const dsparkIds = selectedIds.filter((id) => backendOf(id) === 'dspark');
  if (dsparkIds.length === 0) {
    return ollamaIds;
  }
  const resident = preferredModelId && dsparkIds.includes(preferredModelId) ? preferredModelId : dsparkIds[0];
  return resident ? [...ollamaIds, resident] : ollamaIds;
}

/** Embeddings always resolve against Ollama, even when chat runs on vLLM or mlx-dspark. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
