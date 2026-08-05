import {
  getCloudProviders,
  getOnboardingProfile,
  getPreferences,
  getRocmStatus,
  getRuntimeModels,
  getTrackedModels,
  getOllamaStatus,
  getVllmStatus,
  pinModel,
  rescanHardware,
  setCloudProvider,
  startPullModel,
  unpinModel,
  updatePreferences,
  updateRocmInstallState,
} from '@/api-client/sdk.gen';
import type { CloudProviderType, InferenceBackendType, TrackedModel } from '@ci-hub/common/types';
import type {
  CloudProviderInput,
  HardwareProfileResponse,
  InferencePreferencesResponse,
  RuntimeModelsResponse,
} from '@/modules/onboarding/helpers/ai-setup-types';
import { unwrapSdk, unwrapSdkOrNull } from '@/lib/sdk-unwrap';

async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  return unwrapSdk(promise);
}

export async function fetchInferenceOnboardingProfile(backend?: InferenceBackendType): Promise<HardwareProfileResponse> {
  return unwrap(
    getOnboardingProfile({
      query: backend ? { backend } : undefined,
    } as Parameters<typeof getOnboardingProfile>[0]),
  ) as Promise<HardwareProfileResponse>;
}

export async function fetchInferencePreferences(): Promise<InferencePreferencesResponse | null> {
  try {
    return (await unwrap(getPreferences())) as InferencePreferencesResponse;
  } catch {
    return null;
  }
}

export async function fetchInferenceTrackedModels(): Promise<TrackedModel[]> {
  const tracked = await unwrapSdkOrNull(getTrackedModels());
  return (tracked ?? []) as TrackedModel[];
}

export async function startInferenceModelPull(modelId: string, bestEffort = true): Promise<void> {
  await startPullModel({ body: { modelId, bestEffort } } as Parameters<typeof startPullModel>[0]);
}

export async function fetchRocmInstallStatus<T = unknown>(): Promise<T | null> {
  return unwrapSdkOrNull(getRocmStatus()) as Promise<T | null>;
}

export async function saveRocmInstallState(body: Record<string, unknown>): Promise<void> {
  await unwrap(updateRocmInstallState({ body } as Parameters<typeof updateRocmInstallState>[0]));
}

export async function fetchInferenceRuntimeModels(backend: InferenceBackendType): Promise<RuntimeModelsResponse> {
  return unwrap(getRuntimeModels({ query: { backend } } as Parameters<typeof getRuntimeModels>[0])) as Promise<RuntimeModelsResponse>;
}

export async function fetchConfiguredCloudProviders(): Promise<CloudProviderInput[]> {
  try {
    const providers = (await unwrap(getCloudProviders())) as Array<{
      provider: CloudProviderType;
      configured: boolean;
      enabled: boolean;
    }>;
    return providers
      .filter((p) => p.configured)
      .map((p) => ({
        provider: p.provider,
        apiKey: '••••••••',
        enabled: p.enabled,
      }));
  } catch {
    return [];
  }
}

export async function rescanInferenceHardware(): Promise<void> {
  await unwrap(rescanHardware());
}

export async function saveInferencePreferences(body: {
  backend: InferenceBackendType;
  model: string | null;
  embeddingModel: string | null;
  visionModel: string | null;
  vllmApiKey?: string | null;
}): Promise<void> {
  await unwrap(
    updatePreferences({
      body: {
        backend: body.backend,
        model: body.model ?? undefined,
        embeddingModel: body.embeddingModel ?? undefined,
        visionModel: body.visionModel ?? undefined,
        vllmApiKey: body.vllmApiKey ?? undefined,
      },
    }),
  );
}

export async function fetchVllmInstallStatus() {
  return unwrap(getVllmStatus());
}

export async function saveCloudProviderConfig(body: { provider: CloudProviderType; apiKey?: string; enabled: boolean }): Promise<void> {
  await unwrap(setCloudProvider({ body } as Parameters<typeof setCloudProvider>[0]));
}

export async function pinInferenceModel(modelId: string): Promise<void> {
  await unwrap(pinModel({ body: { modelId } } as Parameters<typeof pinModel>[0]));
}

export async function unpinInferenceModel(modelId: string): Promise<void> {
  await unwrap(unpinModel({ body: { modelId } } as Parameters<typeof unpinModel>[0]));
}

export async function fetchOllamaInstallStatus() {
  return unwrap(getOllamaStatus());
}
