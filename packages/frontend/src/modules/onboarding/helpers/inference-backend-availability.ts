import type { InferenceBackendType } from '@ci-hub/common/types';
import { automaticRunnersForBackend } from '@/lib/inference/auto-inference-runners';

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

/**
 * Whether Install & Finish and the AI step's Continue must wait.
 *
 * A machine that cannot run a local model is allowed through: there is no engine to wait for.
 * The desktop app can install the runner itself, so it is allowed through too.
 * Every other machine waits until the engine the operator picked reports ready.
 */
export function localEngineBlocksFinish(input: {
  tier: string;
  backend: InferenceBackendType;
  canAutoInstall: boolean;
  /** `null` while the probe has not answered. `true` only when that engine is ready. */
  engineReady: boolean | null;
}): boolean {
  if (input.tier === 'insufficient' || input.canAutoInstall) return false;
  if (input.backend !== 'ollama' && input.backend !== 'vllm' && input.backend !== 'omlx' && input.backend !== 'lemonade') {
    return false;
  }
  return input.engineReady !== true;
}

/**
 * Whether the desktop app installs `engine` itself when setup finishes: it is on the runner path
 * `InstallStep` takes (`automaticRunnersForBackend`). The native installer skips vLLM on Windows
 * (`install_and_start_vllm`), so that pair does not count. The other hardware limits are already
 * in `hiddenInferenceBackends`.
 */
function desktopInstallsEngine(profile: HardwareProfileResponse, engine: InferenceBackendType, canAutoInstall: boolean): boolean {
  if (!canAutoInstall || !automaticRunnersForBackend(engine).some((runner) => runner === engine)) return false;
  return !(engine === 'vllm' && profile.hardware.os?.platform?.toLowerCase() === 'win32');
}

/**
 * The engine setup starts on. In the desktop window the hardware's pick stands when the app
 * installs that engine itself, as oMLX on an Apple Silicon Mac. Otherwise (a browser tab, or an
 * engine the app cannot install here) the pick wins while it answers, unless it has no models and
 * another engine that answers has some. When it does not answer, an engine that does is used, one
 * with models first. An NVIDIA PC running Ollama and no vLLM used to start on vLLM and then refuse
 * to finish (#1927). With nothing answering the pick stands, and the setup card says how to start it.
 */
export function recommendedInferenceBackend(profile: HardwareProfileResponse, canAutoInstall: boolean): InferenceBackendType {
  const hidden = new Set(hiddenInferenceBackends(profile));
  const recommended = profile.backends.recommended;
  const pick = recommended && !hidden.has(recommended) ? recommended : 'ollama';
  if (desktopInstallsEngine(profile, pick, canAutoInstall)) return pick;
  const answering = profile.backends.available
    .filter((engine) => engine.running && engine.healthy && !hidden.has(engine.type))
    .sort((a, b) => Number(b.type === pick) - Number(a.type === pick));
  const withModels = answering.find((engine) => (engine.modelsLoaded ?? 0) > 0);
  return (withModels ?? answering[0])?.type ?? pick;
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
