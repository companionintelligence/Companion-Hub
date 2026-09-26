import type { InferenceBackendType } from '@ci-hub/common/types';

import type { HardwareProfileResponse } from './ai-setup-types';

/**
 * The four engines the operator can pick. Hardware hides the ones that do not run here.
 * The other path is a decode endpoint and an encode endpoint, not another backend name.
 */
export function unavailableInferenceBackends(_profile: HardwareProfileResponse): InferenceBackendType[] {
  return [];
}

export function isAppleSiliconMacProfile(profile: HardwareProfileResponse): boolean {
  const platform = profile.hardware.os?.platform?.toLowerCase();
  return platform === 'darwin' && (profile.hardware.gpu.vendor === 'apple' || profile.hardware.cpu.arch === 'arm64');
}

function isNvidiaProfile(profile: HardwareProfileResponse): boolean {
  return profile.hardware.gpu.vendor === 'nvidia';
}

function isAmdOrNpuProfile(profile: HardwareProfileResponse): boolean {
  return profile.hardware.gpu.vendor === 'amd' || profile.hardware.npu?.available === true;
}

/**
 * Engines that do not run on this host. Unknown OS hides nothing, rather than guessing.
 * oMLX is Apple Silicon only. vLLM is NVIDIA only. Lemonade is AMD or NPU, and never macOS.
 */
export function hiddenInferenceBackends(profile: HardwareProfileResponse): InferenceBackendType[] {
  const platform = profile.hardware.os?.platform?.toLowerCase();
  if (!platform) return [];
  const hidden: InferenceBackendType[] = [];
  if (!isAppleSiliconMacProfile(profile)) hidden.push('omlx');
  if (!isNvidiaProfile(profile)) hidden.push('vllm');
  if (platform === 'darwin' || !isAmdOrNpuProfile(profile)) hidden.push('lemonade');
  return hidden;
}

export function recommendedInferenceBackend(profile: HardwareProfileResponse): InferenceBackendType {
  const hidden = new Set(hiddenInferenceBackends(profile));
  const recommended = profile.backends.recommended;
  if (recommended && !hidden.has(recommended)) return recommended;
  return 'ollama';
}

export function isHostServedBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'vllm' || backend === 'omlx';
}

export function isHubLoadableBackend(backend: InferenceBackendType | undefined): boolean {
  return backend === 'ollama' || backend === 'lemonade';
}

export function hubLoadableSelection(
  selectedIds: string[],
  backendOf: (modelId: string) => InferenceBackendType | undefined,
  _preferredModelId?: string | null,
): string[] {
  return selectedIds.filter((id) => isHubLoadableBackend(backendOf(id)));
}

/** Embeddings use Ollama when the chosen decoder cannot embed (vLLM, Lemonade). oMLX can embed itself. */
export const EMBEDDING_INFERENCE_BACKEND: InferenceBackendType = 'ollama';
