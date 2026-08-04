import type { InferenceBackendType } from '@ci-hub/common/types';

import type { HardwareProfileResponse } from './ai-setup-types';

/** Host vLLM is supported on NVIDIA hardware with a working container GPU runtime probe. */
export function isVllmSelectable(profile: HardwareProfileResponse): boolean {
  const { gpu, npu } = profile.hardware;

  if (npu.available) {
    return false;
  }

  return gpu.vendor === 'nvidia' && gpu.runtimeAvailable;
}

/** Backends grayed out in the backend picker (Lemonade + vLLM when hardware cannot use it). */
export function unavailableInferenceBackends(profile: HardwareProfileResponse): InferenceBackendType[] {
  return ['lemonade', ...(isVllmSelectable(profile) ? [] : (['vllm'] as const))];
}

/** Embeddings always resolve against Ollama, even when chat runs on vLLM. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
