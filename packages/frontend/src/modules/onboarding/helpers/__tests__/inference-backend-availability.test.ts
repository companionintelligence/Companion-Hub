import { describe, expect, it } from 'vitest';
import type { HardwareProfileResponse } from '@/modules/onboarding/helpers/ai-setup-types';
import type { InferenceBackendType } from '@ci-hub/common/types';
import {
  EMBEDDING_INFERENCE_BACKEND,
  hubLoadableSelection,
  hiddenInferenceBackends,
  isAppleSiliconMacProfile,
  isHubLoadableBackend,
  recommendedInferenceBackend,
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

const macProfile = {
  ...amdProfile,
  hardware: {
    ...amdProfile.hardware,
    cpu: { arch: 'x86_64' },
    os: { platform: 'darwin', name: 'macOS', version: '15.6' },
  },
} as HardwareProfileResponse;

const appleMacProfile = {
  hardware: {
    gpu: { vendor: 'apple', runtimeAvailable: false, available: true, unifiedMemory: true },
    cpu: { arch: 'arm64' },
    os: { platform: 'darwin', name: 'macOS', version: '15.6' },
  },
  backends: {
    recommended: 'mtplx',
    available: [
      { type: 'dspark', running: false, healthy: false },
      { type: 'mtplx', running: false, healthy: false },
    ],
  },
} as HardwareProfileResponse;

describe('inference-backend-availability', () => {
  // vLLM, Lemonade, and mlx-dspark are selectable when their endpoint is reachable; the endpoint probe
  // is the gate, not the local GPU vendor.
  it('keeps vLLM selectable regardless of GPU vendor', () => {
    expect(unavailableInferenceBackends(nvidiaProfile)).toEqual([]);
    expect(unavailableInferenceBackends(amdProfile)).toEqual([]);
  });

  it('hides Lemonade on macOS and nothing when the host OS is unknown', () => {
    expect(hiddenInferenceBackends(appleMacProfile)).toEqual(['lemonade']);
    expect(hiddenInferenceBackends(nvidiaProfile)).toEqual([]);
  });

  // mlx-dspark and MTPLX have no Linux, Windows or Docker build, so only Apple Silicon Macs list them.
  it('hides the Apple-Silicon-only runners on Linux, Windows and Intel Macs', () => {
    const withOs = (platform: string) =>
      ({ ...amdProfile, hardware: { ...amdProfile.hardware, os: { platform, name: platform, version: '' } } }) as HardwareProfileResponse;
    expect(hiddenInferenceBackends(withOs('linux'))).toEqual(['dspark', 'mtplx']);
    expect(hiddenInferenceBackends(withOs('win32'))).toEqual(['dspark', 'mtplx']);
    expect(hiddenInferenceBackends(withOs('Windows'))).toEqual(['dspark', 'mtplx']);
    expect(hiddenInferenceBackends(macProfile)).toEqual(['lemonade', 'dspark', 'mtplx']);
  });

  it('defaults Apple Silicon Macs to mlx-dspark even when MTPLX is recommended', () => {
    expect(isAppleSiliconMacProfile(appleMacProfile)).toBe(true);
    expect(recommendedInferenceBackend(appleMacProfile)).toBe('dspark');
    expect(
      recommendedInferenceBackend({
        ...appleMacProfile,
        hardware: { ...appleMacProfile.hardware, os: { platform: 'linux', name: 'Linux', version: '6.0' } },
      } as HardwareProfileResponse),
    ).toBe('mtplx');
  });

  it('keeps embeddings on Ollama', () => {
    expect(EMBEDDING_INFERENCE_BACKEND).toBe('ollama');
  });

  describe('isHubLoadableBackend', () => {
    // Deliberately NOT the complement of isHostServedBackend: mlx-dspark and Lemonade are both
    // host-run (the Hub only holds a URL) and Hub-loadable (they accept model lifecycle calls).
    it('covers the backends the Hub can install into', () => {
      expect(isHubLoadableBackend('ollama')).toBe(true);
      expect(isHubLoadableBackend('dspark')).toBe(true);
      expect(isHubLoadableBackend('lemonade')).toBe(true);
      expect(isHubLoadableBackend('vllm')).toBe(false);
      expect(isHubLoadableBackend(undefined)).toBe(false);
    });
  });

  describe('hubLoadableSelection', () => {
    const backends: Record<string, InferenceBackendType> = {
      'nomic-embed': 'ollama',
      'llama3-2-3b': 'ollama',
      'qwen3-8b-dspark': 'dspark',
      'qwen3-4b-dspark': 'dspark',
      'qwen3-8b-vllm': 'vllm',
    };
    const backendOf = (id: string) => backends[id];

    it('drops vLLM rows — the Hub cannot install into a host vLLM server', () => {
      expect(hubLoadableSelection(['llama3-2-3b', 'qwen3-8b-vllm'], backendOf)).toEqual(['llama3-2-3b']);
    });

    it('keeps every Ollama row but only ONE mlx-dspark row', () => {
      // mlx-dspark holds a single resident target+drafter pair — /admin/load swaps rather than
      // adds — so installing a whole ticked list would download tens of GB and leave only the last
      // load actually served, with the registry recording all of them as loaded.
      const result = hubLoadableSelection(['nomic-embed', 'llama3-2-3b', 'qwen3-8b-dspark', 'qwen3-4b-dspark'], backendOf);
      expect(result.filter((id) => backendOf(id) === 'ollama')).toEqual(['nomic-embed', 'llama3-2-3b']);
      expect(result.filter((id) => backendOf(id) === 'dspark')).toHaveLength(1);
    });

    it('keeps the operator-chosen default when several mlx-dspark rows are ticked', () => {
      expect(hubLoadableSelection(['qwen3-8b-dspark', 'qwen3-4b-dspark'], backendOf, 'qwen3-4b-dspark')).toEqual(['qwen3-4b-dspark']);
    });

    it('falls back to the first ticked row when the preferred model is not an mlx-dspark row', () => {
      expect(hubLoadableSelection(['qwen3-8b-dspark', 'qwen3-4b-dspark'], backendOf, 'nomic-embed')).toEqual(['qwen3-8b-dspark']);
    });
  });
});
