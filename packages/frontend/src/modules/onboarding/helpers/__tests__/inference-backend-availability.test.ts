import { describe, expect, it } from 'vitest';
import type { HardwareProfileResponse } from '@/modules/onboarding/helpers/ai-setup-types';
import {
  EMBEDDING_INFERENCE_BACKEND,
  isVllmSelectable,
  unavailableInferenceBackends,
} from '@/modules/onboarding/helpers/inference-backend-availability';

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
  it('enables vLLM on NVIDIA with container GPU runtime', () => {
    expect(isVllmSelectable(nvidiaProfile)).toBe(true);
    expect(unavailableInferenceBackends(nvidiaProfile)).toEqual(['lemonade']);
  });

  it('disables vLLM on AMD and NPU hardware', () => {
    expect(isVllmSelectable(amdProfile)).toBe(false);
    expect(unavailableInferenceBackends(amdProfile)).toEqual(['lemonade', 'vllm']);
  });

  it('keeps embeddings on Ollama', () => {
    expect(EMBEDDING_INFERENCE_BACKEND).toBe('ollama');
  });
});
