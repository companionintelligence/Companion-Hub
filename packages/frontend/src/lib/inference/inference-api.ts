import {
  getCloudProviders,
  getLemonadeStatus,
  getManualEndpointStatus,
  getOllamaStatus,
  getOmlxStatus,
  getOnboardingProfile,
  getPreferences,
  getRocmStatus,
  getRuntimeModels,
  getTrackedModels,
  getVllmStatus,
  pinModel,
  rescanHardware,
  setCloudProvider,
  startPullModel,
  unloadModel,
  unpinModel,
  updatePreferences,
  updateRocmInstallState,
} from '@/api-client/sdk.gen';
import type { CloudProviderType, InferenceBackendType, TrackedModel } from '@ci-hub/common/types';
import type {
  CloudProviderInput,
  LemonadeStatus,
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
  omlxUrl?: string,
): Promise<HardwareProfileResponse> {
  const query: Record<string, string> = {};
  if (backend) query.backend = backend;
  if (backend === 'vllm' && vllmUrl?.trim()) query.vllmUrl = vllmUrl.trim();
  if (backend === 'omlx' && omlxUrl?.trim()) query.omlxUrl = omlxUrl.trim();
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

/** `POST /inference/models/pull/start`'s body (`PullStartResult` in the backend). The SDK types it `unknown`. */
export interface PullStartReply {
  status: 'already_installed' | 'queued' | 'in_progress' | 'skipped' | 'error';
  reason?: string;
}

export async function startInferenceModelPull(modelId: string, bestEffort = true): Promise<PullStartReply | null> {
  return ((await unwrap(startPullModel({ body: { modelId, bestEffort } } as Parameters<typeof startPullModel>[0]))) ?? null) as PullStartReply | null;
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
  omlxUrl?: string | null;
  decodeEndpoint?: string | null;
  encodeEndpoint?: string | null;
}): Promise<void> {
  await unwrap(
    updatePreferences({
      body: {
        backend: body.backend,
        // `null` clears the stored value. `undefined` is left out of the JSON, and the Hub
        // then keeps what is already on disk. Coercing `null` to `undefined` made a cleared
        // model or vLLM key impossible to remove.
        model: body.model,
        embeddingModel: body.embeddingModel,
        visionModel: body.visionModel,
        vllmApiKey: body.vllmApiKey,
        vllmUrl: body.vllmUrl,
        omlxUrl: body.omlxUrl,
        decodeEndpoint: body.decodeEndpoint,
        encodeEndpoint: body.encodeEndpoint,
      },
    } as Parameters<typeof updatePreferences>[0]),
  );
}

export async function fetchVllmInstallStatus(url?: string, apiKey?: string) {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  const headers = apiKey?.trim() ? { [VLLM_PROBE_API_KEY_HEADER]: apiKey.trim() } : undefined;
  return unwrap(getVllmStatus({ query, headers } as Parameters<typeof getVllmStatus>[0]));
}

/** Probe the operator's oMLX server. No API-key header. */
export async function fetchOmlxInstallStatus(url?: string) {
  const query = url?.trim() ? { url: url.trim() } : undefined;
  return unwrap(getOmlxStatus({ query } as Parameters<typeof getOmlxStatus>[0]));
}

export async function fetchManualEndpointStatus(url: string) {
  return unwrap(getManualEndpointStatus({ query: { url } } as Parameters<typeof getManualEndpointStatus>[0]));
}

/** Probe the configured Lemonade server through its standard /v1/health endpoint. */
export async function fetchLemonadeInstallStatus(): Promise<LemonadeStatus> {
  return unwrap(getLemonadeStatus()) as Promise<LemonadeStatus>;
}

export async function saveCloudProviderConfig(body: { provider: CloudProviderType; apiKey?: string; enabled: boolean }): Promise<void> {
  await unwrap(setCloudProvider({ body } as Parameters<typeof setCloudProvider>[0]));
}

export async function pinInferenceModel(modelId: string): Promise<void> {
  // A refused pin (over the pin budget, or the model cannot be made to fit) is a 201 with
  // `success: false`, not an HTTP error — surface it, or callers report a pin that never happened.
  const result = (await unwrap(pinModel({ body: { modelId } } as Parameters<typeof pinModel>[0]))) as
    | { success?: boolean; message?: string }
    | undefined;
  if (result?.success === false) {
    throw new Error(result.message ?? `Could not pin ${modelId}`);
  }
}

export async function unpinInferenceModel(modelId: string): Promise<void> {
  await unwrap(unpinModel({ body: { modelId } } as Parameters<typeof unpinModel>[0]));
}

/**
 * Take a model out of its engine's memory. The Hub then tracks it as `pulled` — pinned no more —
 * so the next Save pins it again through the load path, which is the one way to make the engine
 * pick up new load options: a pin of a model that is already resident reloads nothing.
 */
export async function unloadInferenceModel(modelId: string): Promise<void> {
  await unwrap(unloadModel({ body: { modelId } } as Parameters<typeof unloadModel>[0]));
}

export async function fetchOllamaInstallStatus() {
  return unwrap(getOllamaStatus());
}
