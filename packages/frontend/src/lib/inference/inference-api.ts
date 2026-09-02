import {
  getCloudProviders,
  getOnboardingProfile,
  getPreferences,
  getRocmStatus,
  getRuntimeModels,
  getTrackedModels,
  getDsparkStatus,
  getLemonadeStatus,
  getMlxStatus,
  getOllamaStatus,
  getVllmStatus,
  getMtplxStatus,
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
  DsparkStatus,
  LemonadeStatus,
  MlxStatus,
  HardwareProfileResponse,
  InferencePreferencesResponse,
  RuntimeModelsResponse,
} from '@/modules/onboarding/helpers/ai-setup-types';
import { unwrapSdk, unwrapSdkOrNull } from '@/lib/sdk-unwrap';

const VLLM_PROBE_API_KEY_HEADER = 'x-ci-vllm-api-key';

async function unwrap<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  return unwrapSdk(promise);
}

export async function fetchInferenceOnboardingProfile(
  backend?: InferenceBackendType,
  vllmUrl?: string,
  vllmApiKey?: string,
  mtplxUrl?: string,
  dsparkUrl?: string,
  mlxUrl?: string,
): Promise<HardwareProfileResponse> {
  const query: Record<string, string> = {};
  if (backend) query.backend = backend;
  // Candidate vLLM/MTPLX/mlx-dspark/MLX URL the operator typed but hasn't saved yet — keeps the
  // profile's installed-model resolution probing the same server the status card reports on.
  if (backend === 'vllm' && vllmUrl?.trim()) query.vllmUrl = vllmUrl.trim();
  if (backend === 'mtplx' && mtplxUrl?.trim()) query.mtplxUrl = mtplxUrl.trim();
  if (backend === 'dspark' && dsparkUrl?.trim()) query.dsparkUrl = dsparkUrl.trim();
  if (backend === 'mlx' && mlxUrl?.trim()) query.mlxUrl = mlxUrl.trim();
  const headers = backend === 'vllm' && vllmApiKey?.trim() ? { [VLLM_PROBE_API_KEY_HEADER]: vllmApiKey.trim() } : undefined;
  return unwrap(
    getOnboardingProfile({
      query: Object.keys(query).length > 0 ? query : undefined,
      headers,
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
  vllmUrl?: string | null;
  mtplxUrl?: string | null;
  dsparkUrl?: string | null;
  mlxUrl?: string | null;
}): Promise<void> {
  await unwrap(
    updatePreferences({
      body: {
        backend: body.backend,
        model: body.model ?? undefined,
        embeddingModel: body.embeddingModel ?? undefined,
        visionModel: body.visionModel ?? undefined,
        vllmApiKey: body.vllmApiKey ?? undefined,
        vllmUrl: body.vllmUrl ?? undefined,
        mtplxUrl: body.mtplxUrl ?? undefined,
        dsparkUrl: body.dsparkUrl ?? undefined,
        mlxUrl: body.mlxUrl ?? undefined,
      },
    } as Parameters<typeof updatePreferences>[0]),
  );
}

export async function fetchVllmInstallStatus(url?: string, apiKey?: string) {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  const headers = apiKey?.trim() ? { [VLLM_PROBE_API_KEY_HEADER]: apiKey.trim() } : undefined;
  return unwrap(getVllmStatus({ query, headers } as Parameters<typeof getVllmStatus>[0]));
}

/**
 * Probe the operator's mlx-dspark server. No API-key header, unlike fetchVllmInstallStatus:
 * mlx-dspark's `/health` is auth-exempt, so detection works with or without a key configured.
 */
export async function fetchDsparkInstallStatus(url?: string): Promise<DsparkStatus> {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  return unwrap(getDsparkStatus({ query })) as Promise<DsparkStatus>;
}

/** Probe the configured Lemonade server through its standard /v1/health endpoint. */
export async function fetchLemonadeInstallStatus(): Promise<LemonadeStatus> {
  return unwrap(getLemonadeStatus()) as Promise<LemonadeStatus>;
}

/** Probe a native mlx-lm server, optionally using an unsaved Settings URL. */
export async function fetchMlxInstallStatus(url?: string): Promise<MlxStatus> {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  return unwrap(getMlxStatus({ query })) as Promise<MlxStatus>;
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

export async function fetchMtplxInstallStatus(url?: string) {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  return unwrap(getMtplxStatus({ query } as Parameters<typeof getMtplxStatus>[0]));
}
