import type { CloudProviderType, CuratedModel, HardwareProfile, HardwareTier, InferenceBackendType, MemoryBudget } from '@ci-hub/common/types';

/** The Companion agent framework that powers the user's system. */
export type AgentFramework = 'openclaw' | 'hermes';

/** Maps a chosen agent framework to the app store slug (id) that installs it. */
export const AGENT_APP_SLUG: Record<AgentFramework, string> = {
  openclaw: 'ci-openclaw',
  hermes: 'ci-hermes',
};

/** A remote-access transport the user can enable (maps to ExposureMode minus 'local'). */
export type RemoteAccessMode = Exclude<ExposureMode, 'local'>;

/** AI setup state managed by the AiSetupStep and passed down to InstallStep / CompleteStep. */
export interface AiSetupConfig {
  /** Chosen agent frameworks — one or more (OpenClaw is the default); empty to run no agent. */
  agentFrameworks: AgentFramework[];
  selectedModels: string[];
  backend: InferenceBackendType;
  cloudProviders: CloudProviderInput[];
  /**
   * Catalog id of the preferred default model that Companion agents (Hermes, OpenClaw) and the Hub
   * use by default. Always one of `selectedModels` when set. Undefined when AI setup was skipped or
   * the hardware can't run a local model.
   */
  preferredModelId?: string;
  /** Catalog id of the default embedding model to use when one is selected/installed. */
  preferredEmbeddingModelId?: string;
  /** Catalog id of the default vision-capable model to use when one is selected/installed. */
  preferredVisionModelId?: string;
  /**
   * Remote-access transports the user enabled for their Companion agents (Hermes, OpenClaw) and Hub
   * services — any of 'tailscale' (private VPN) and/or 'cloudflare' (public web URL). Empty means
   * local-only (no remote exposure).
   */
  remoteAccess: RemoteAccessMode[];
  /**
   * Single primary remote-access transport derived from {@link remoteAccess} for back-compat with
   * the app installer (which exposes each app under one mode): 'cloudflare' > 'tailscale' > 'local'.
   */
  exposureMode?: ExposureMode;
  skipped: boolean;
  /** Catalog ids already present on the active backend (and Ollama embeddings when chat uses vLLM). */
  installedCatalogIds: string[];
  /** Selected catalog ids backed by Ollama (pull/pin only applies to these). */
  ollamaSelectedModelIds?: string[];
  /** Optional custom API key for host vLLM (persisted to Hub settings as inferenceVllmApiKey). */
  vllmApiKey?: string;
  /** Optional custom vLLM base URL (persisted to Hub settings as inferenceVllmUrl). */
  vllmUrl?: string;
  /** Optional custom MTPLX base URL (persisted to Hub settings as inferenceMtplxUrl). MTPLX has no
   *  API key concept — its server is local-only with no auth, unlike vLLM's optional --api-key. */
  mtplxUrl?: string;
  /**
   * Optional custom mlx-dspark base URL (persisted to Hub settings as inferenceDsparkUrl). No
   * API-key sibling: mlx-dspark's /health probe is auth-exempt, so none is needed to detect it.
   */
  dsparkUrl?: string;
  /** Optional custom mlx-lm base URL (persisted to Hub settings as inferenceMlxUrl). */
  mlxUrl?: string;
  /** When true, onboarding install must not proceed (budget or missing agent model). */
  installBlocked?: boolean;
  installBlockReason?: string;
}

/** How the user reaches their agents/Hub from other devices. "Web" in the UI maps to 'cloudflare'. */
export type ExposureMode = 'cloudflare' | 'tailscale' | 'local';

export interface CloudProviderInput {
  provider: CloudProviderType;
  apiKey: string;
  enabled: boolean;
}

/**
 * How the Hub container's hop to host Ollama failed.
 *
 * `filtered` means a host firewall is dropping the packets — Ollama itself is
 * fine, so offering to install it would send the operator the wrong way.
 */
export type BridgeFailureMode = 'filtered' | 'refused' | 'dns' | 'none';

export interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  bridgeUnreachable?: boolean;
  failureMode?: BridgeFailureMode;
  /** Copy-pasteable command that fixes `filtered`. Runs on the host, not in the container. */
  remediationCommand?: string;
  displayEndpoint?: string;
  hint?: string;
  error?: string;
}

export interface VllmStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  displayEndpoint?: string;
  remediationCommand?: string;
  hint?: string;
  error?: string;
}

/** Same shape as {@link VllmStatus} — MTPLX has no API key field to match since it's a local-only,
 *  unauthenticated server. */
export type MtplxStatus = VllmStatus;

/**
 * Same shape as {@link VllmStatus} plus `loadedModels`: mlx-dspark can be up and healthy with no
 * model resident (the state `serve --no-model` starts in), which the card distinguishes from a
 * server that is actually ready to answer.
 */
export interface DsparkStatus extends VllmStatus {
  /** Full HF repo ids the server reports as loaded. Empty when started with `--no-model`. */
  loadedModels?: string[];
}

/** Same status shape as VllmStatus; generic MLX-LM reports its served model through /v1/models. */
export interface MlxStatus extends VllmStatus {
  loadedModels?: string[];
}

/** Lemonade's health card uses the same connection shape and also reports cached model ids. */
export interface LemonadeStatus extends VllmStatus {
  loadedModels?: string[];
}

export interface InferencePreferencesResponse {
  preferredBackend: InferenceBackendType | null;
  preferredModel: string | null;
  preferredEmbeddingModel: string | null;
  preferredVisionModel: string | null;
  preferredVllmApiKey?: string | null;
  preferredVllmUrl?: string | null;
  preferredMtplxUrl?: string | null;
  preferredDsparkUrl?: string | null;
  preferredMlxUrl?: string | null;
}

export interface RuntimeModelInfo {
  id: string;
  name: string;
  state: 'loaded' | 'unknown';
}

export interface RuntimeModelsResponse {
  backend: InferenceBackendType;
  discoveryUnavailable: boolean;
  models: RuntimeModelInfo[];
}

/** Response shape from GET /api/inference/onboarding-profile */
export interface HardwareProfileResponse {
  hardware: HardwareProfile;
  tier: HardwareTier;
  recommendedModels: CuratedModel[];
  availableModels: CuratedModel[];
  /** Catalog ids already pulled for the active chat backend (+ Ollama embeddings when backend=vllm). */
  installedCatalogIds: string[];
  memoryBudget: MemoryBudget;
  backends: {
    recommended: InferenceBackendType;
    available: Array<{ type: InferenceBackendType; running: boolean; healthy: boolean }>;
  };
  resourceEstimate: {
    totalDiskMb: number;
    totalMemoryMb: number;
    availableMemoryMb: number;
    availableDiskMb: number;
    diskTotalMb: number;
  };
}

/** Cloud key validation rules by provider */
export const CLOUD_KEY_PATTERNS: Record<CloudProviderType, { prefix: string; label: string }> = {
  openai: { prefix: 'sk-', label: 'OpenAI' },
  anthropic: { prefix: 'sk-ant-', label: 'Anthropic' },
  google: { prefix: '', label: 'Google AI' },
  'github-copilot': { prefix: '', label: 'GitHub Copilot' },
};

export function validateCloudKey(provider: CloudProviderType, key: string): string | null {
  if (!key.trim()) return null;
  const pattern = CLOUD_KEY_PATTERNS[provider];
  if (pattern.prefix && !key.startsWith(pattern.prefix)) {
    return `${pattern.label} keys should start with "${pattern.prefix}"`;
  }
  return null;
}
