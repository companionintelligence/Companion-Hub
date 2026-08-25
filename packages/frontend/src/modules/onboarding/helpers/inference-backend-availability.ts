import type { InferenceBackendType } from '@ci-hub/common/types';

import type { HardwareProfileResponse } from './ai-setup-types';

/**
 * Backends grayed out in the backend picker. Only Lemonade is held back (dark-launched pending
 * NPU detection — see CI-Hub#1104).
 *
 * vLLM and MTPLX are always selectable: both are host-run (or remote) OpenAI-compatible endpoints,
 * so the real gate is the live endpoint probe in their setup cards — not the local GPU or, for
 * MTPLX, whether the Mac is Apple Silicon. Hardware still drives which backend is *recommended*
 * (server-side `getRecommendedBackend`), and the catalog only recommends vLLM models that fit an
 * NVIDIA VRAM budget / MTPLX models that fit an Apple-Silicon unified-memory budget.
 */
export function unavailableInferenceBackends(_profile: HardwareProfileResponse): InferenceBackendType[] {
  return ['lemonade'];
}

/** Embeddings always resolve against Ollama, even when chat runs on vLLM. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
