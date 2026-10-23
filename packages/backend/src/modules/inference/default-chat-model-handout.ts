import { type CuratedModel, defaultChatModelId, type HardwareProfile, type HardwareTier, type InferenceBackendType } from '@ci-hub/common/types';

/** The engine the setup wizard starts on for this hardware (`GET /api/inference/onboarding-profile`). */
export function recommendedInferenceBackend(profile: HardwareProfile): InferenceBackendType {
  // NVIDIA with a usable runtime: vLLM. Apple Silicon: oMLX. An NPU: Lemonade.
  // Everything else, including AMD without a cited vLLM ROCm path: Ollama.
  return profile.npu.available
    ? 'lemonade'
    : profile.gpu.vendor === 'nvidia' && profile.gpu.runtimeAvailable
      ? 'vllm'
      : profile.gpu.vendor === 'apple'
        ? 'omlx'
        : 'ollama';
}

/**
 * The tier the setup wizard lists models for. A discrete card the container runtime cannot reach yet
 * is still the host Ollama's to use, so it counts as though the runtime were there.
 */
export function onboardingTier(
  profile: HardwareProfile,
  computeTier: (gpu: HardwareProfile['gpu'], ram: HardwareProfile['ram']) => HardwareTier,
): HardwareTier {
  if (
    recommendedInferenceBackend(profile) === 'ollama' &&
    profile.gpu.available &&
    !profile.gpu.unifiedMemory &&
    !profile.gpu.runtimeAvailable &&
    (profile.gpu.vendor === 'nvidia' || profile.gpu.vendor === 'amd') &&
    profile.gpu.vramMb > 0
  ) {
    return computeTier({ ...profile.gpu, runtimeAvailable: true }, profile.ram);
  }

  return profile.tier;
}

/**
 * The chat model an app is handed while nobody has chosen one: the setup wizard's Default among the
 * models the engine has (`defaultChatModelId`). `available` and `recommended` are the wizard's lists
 * for this Hub, read at {@link onboardingTier} as `GET /api/inference/onboarding-profile` reads them:
 * the catalog rows the hardware may run in catalog order, and the recommendations best first. The
 * installed model highest on `recommended` wins, else the first installed in catalog order. A model
 * `accept` rules out, one the app cannot use, is passed over for the next. Undefined when the engine
 * has none of them, which leaves the caller to its recommendation list.
 */
export function installedDefaultChatModel(options: {
  available: readonly CuratedModel[];
  recommended: readonly CuratedModel[];
  backend: InferenceBackendType;
  isInstalled: (model: CuratedModel) => boolean;
  accept: (model: CuratedModel) => boolean;
}): CuratedModel | undefined {
  const { available, backend } = options;
  const id = defaultChatModelId({
    backend,
    availableModels: available,
    recommendedModels: options.recommended,
    candidateIds: available.filter((model) => model.backend === backend && options.isInstalled(model)).map((model) => model.id),
    candidatesOnly: true,
    accept: options.accept,
  });
  return id ? available.find((model) => model.id === id) : undefined;
}
