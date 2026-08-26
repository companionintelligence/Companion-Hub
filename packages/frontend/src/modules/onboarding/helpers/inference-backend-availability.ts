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

/** Embeddings always resolve against Ollama, even when chat runs on vLLM or mlx-dspark. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
