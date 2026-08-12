import { describe, expect, it } from 'vitest';
import type { HardwareProfileResponse } from '@/modules/onboarding/helpers/ai-setup-types';
import { EMBEDDING_INFERENCE_BACKEND, unavailableInferenceBackends } from '@/modules/onboarding/helpers/inference-backend-availability';

const nvidiaProfile = {
  hardware: {
    gpu: { vendor: 'nvidia', runtimeAvailable: true, available: true },
    npu: { available: false },
  },
} as HardwareProfileResponse;

const amdProfile = {
  hardware: {
    gpu: { vendor: 'amd', runtimeAvailable: true, available: true },
    npu: { available: false },
  },
} as HardwareProfileResponse;

describe('inference-backend-availability', () => {
  // vLLM is a host-run/remote OpenAI-compatible endpoint; the endpoint probe is the gate,
  // not the local GPU vendor. Only dark-launched Lemonade stays unavailable.
  it('keeps vLLM selectable regardless of GPU vendor', () => {
    expect(unavailableInferenceBackends(nvidiaProfile)).toEqual(['lemonade']);
    expect(unavailableInferenceBackends(amdProfile)).toEqual(['lemonade']);
  });

  it('keeps embeddings on Ollama', () => {
    expect(EMBEDDING_INFERENCE_BACKEND).toBe('ollama');
  });
});
