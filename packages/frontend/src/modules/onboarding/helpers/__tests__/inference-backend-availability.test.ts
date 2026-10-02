import { describe, expect, it } from 'vitest';
import type { HardwareProfileResponse } from '@/modules/onboarding/helpers/ai-setup-types';
import type { InferenceBackendType } from '@ci-hub/common/types';
import {
  EMBEDDING_INFERENCE_BACKEND,
  hubLoadableSelection,
  hiddenInferenceBackends,
  isAppleSiliconMacProfile,
  localEngineBlocksFinish,
  isHubLoadableBackend,
  recommendedInferenceBackend,
  unavailableInferenceBackends,
} from '@/modules/onboarding/helpers/inference-backend-availability';

const nvidiaProfile = {
  hardware: {
    gpu: { vendor: 'nvidia', runtimeAvailable: true, available: true },
    npu: { available: false },
    os: { platform: 'linux', name: 'Linux', version: '6' },
  },
  backends: { recommended: 'vllm', available: [] },
} as unknown as HardwareProfileResponse;

const amdProfile = {
  hardware: {
    gpu: { vendor: 'amd', runtimeAvailable: true, available: true },
    npu: { available: false },
    os: { platform: 'linux', name: 'Linux', version: '6' },
  },
  backends: { recommended: 'ollama', available: [] },
} as unknown as HardwareProfileResponse;

const macProfile = {
  hardware: {
    gpu: { vendor: 'intel', runtimeAvailable: false, available: false },
    cpu: { arch: 'x86_64' },
    npu: { available: false },
    os: { platform: 'darwin', name: 'macOS', version: '15.6' },
  },
  backends: { recommended: 'ollama', available: [] },
} as unknown as HardwareProfileResponse;

const appleMacProfile = {
  hardware: {
    gpu: { vendor: 'apple', runtimeAvailable: false, available: true, unifiedMemory: true },
    cpu: { arch: 'arm64' },
    npu: { available: false },
    os: { platform: 'darwin', name: 'macOS', version: '15.6' },
  },
  backends: {
    recommended: 'omlx',
    available: [{ type: 'omlx', running: false, healthy: false }],
  },
} as unknown as HardwareProfileResponse;

describe('inference-backend-availability', () => {
  it('does not gray engines out; hardware hides them instead', () => {
    expect(unavailableInferenceBackends(nvidiaProfile)).toEqual([]);
    expect(unavailableInferenceBackends(amdProfile)).toEqual([]);
  });

  it('shows vLLM on NVIDIA, oMLX on Apple Silicon, and Lemonade on AMD', () => {
    expect(hiddenInferenceBackends(nvidiaProfile)).toEqual(['omlx', 'lemonade']);
    expect(hiddenInferenceBackends(amdProfile)).toEqual(['omlx', 'vllm']);
    expect(hiddenInferenceBackends(appleMacProfile)).toEqual(['vllm', 'lemonade']);
    expect(hiddenInferenceBackends(macProfile)).toEqual(['omlx', 'vllm', 'lemonade']);
  });

  it('hides nothing when the host OS is unknown', () => {
    expect(hiddenInferenceBackends({ hardware: { gpu: { vendor: 'nvidia' }, npu: { available: false } } } as HardwareProfileResponse)).toEqual([]);
  });

  it('keeps the server recommendation when that engine is visible', () => {
    expect(isAppleSiliconMacProfile(appleMacProfile)).toBe(true);
    expect(recommendedInferenceBackend(appleMacProfile)).toBe('omlx');
    expect(recommendedInferenceBackend(nvidiaProfile)).toBe('vllm');
  });

  it('keeps embeddings on Ollama when the decoder cannot embed', () => {
    expect(EMBEDDING_INFERENCE_BACKEND).toBe('ollama');
  });

  describe('isHubLoadableBackend', () => {
    it('covers the backends the Hub can install into', () => {
      expect(isHubLoadableBackend('ollama')).toBe(true);
      expect(isHubLoadableBackend('lemonade')).toBe(true);
      expect(isHubLoadableBackend('omlx')).toBe(false);
      expect(isHubLoadableBackend('vllm')).toBe(false);
      expect(isHubLoadableBackend(undefined)).toBe(false);
    });
  });

  describe('localEngineBlocksFinish', () => {
    it('waits when the chosen engine has not reported ready', () => {
      expect(localEngineBlocksFinish({ tier: 'high', backend: 'ollama', canAutoInstall: false, engineReady: false })).toBe(true);
      expect(localEngineBlocksFinish({ tier: 'high', backend: 'vllm', canAutoInstall: false, engineReady: null })).toBe(true);
    });

    it('lets a weak machine and a desktop auto-install through', () => {
      expect(localEngineBlocksFinish({ tier: 'insufficient', backend: 'ollama', canAutoInstall: false, engineReady: false })).toBe(false);
      expect(localEngineBlocksFinish({ tier: 'high', backend: 'ollama', canAutoInstall: true, engineReady: false })).toBe(false);
      expect(localEngineBlocksFinish({ tier: 'high', backend: 'omlx', canAutoInstall: false, engineReady: true })).toBe(false);
    });
  });

  describe('hubLoadableSelection', () => {
    const backends: Record<string, InferenceBackendType> = {
      'nomic-embed': 'ollama',
      'llama3-2-3b': 'ollama',
      'qwen3-8b-omlx': 'omlx',
      'qwen3-8b-vllm': 'vllm',
    };
    const backendOf = (id: string) => backends[id];

    it('keeps Ollama rows and drops engines the Hub cannot install into', () => {
      expect(hubLoadableSelection(['llama3-2-3b', 'qwen3-8b-vllm', 'qwen3-8b-omlx', 'nomic-embed'], backendOf)).toEqual([
        'llama3-2-3b',
        'nomic-embed',
      ]);
    });
  });
});
