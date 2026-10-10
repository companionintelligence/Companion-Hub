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
  /** Optional custom oMLX base URL. */
  omlxUrl?: string;
  /** Manual decode endpoint. Overrides the selected engine's chat URL when set. */
  decodeEndpoint?: string;
  /** Manual encode endpoint. Overrides the embedding host when set. */
  encodeEndpoint?: string;
  /** When true, onboarding install must not proceed (budget or missing agent model). */
  installBlocked?: boolean;
  installBlockReason?: string;
  /**
   * The selected local engine has not reported ready. Weak hardware leaves this unset:
   * that machine is not waiting on an engine. Install & Finish uses the same rule as Continue.
   */
  engineBlocked?: boolean;
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

/** oMLX answers the same OpenAI-compatible health shape as vLLM, without an API key. */
export type OmlxStatus = VllmStatus;

/** Lemonade's health card uses the same connection shape and also reports cached model ids. */
export interface LemonadeStatus extends VllmStatus {
  /** Downloaded model ids. Not what is in memory. */
  loadedModels?: string[];
  /** Model ids Lemonade is actually holding, when the health body can say. */
  residentModels?: string[];
  /** How the probe failed; `auth` means Lemonade answered and refused the Hub's key. */
  failureMode?: BridgeFailureMode | 'auth';
  /** The Hub host's OS, from the host probe: the systemd and firewall steps are Linux-only. */
  hostPlatform?: string;
  /** The Hub holds a `LEMONADE_API_KEY`. */
  apiKeyConfigured?: boolean;
  /** Host firewall rules for the Hub's network and the app subnet; empty when the host has no enabled firewall. */
  firewallCommands?: string[];
}

export interface InferencePreferencesResponse {
  preferredBackend: InferenceBackendType | null;
  preferredModel: string | null;
  preferredEmbeddingModel: string | null;
  preferredVisionModel: string | null;
  preferredVllmApiKey?: string | null;
  preferredVllmUrl?: string | null;
  preferredOmlxUrl?: string | null;
  preferredDecodeEndpoint?: string | null;
  preferredEncodeEndpoint?: string | null;
}

export interface RuntimeModelInfo {
  id: string;
  name: string;
  /** In the engine's inventory (on disk), not resident in VRAM — see inference.controller.ts. */
  state: 'available' | 'unknown';
  /** True when the engine's residency read says this id is in memory. */
  resident?: boolean;
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
    /** The hardware's pick, whether or not it answers. Choose with `recommendedInferenceBackend`, which checks. */
    recommended: InferenceBackendType;
    /** `modelsLoaded` counts the models the engine has. A Hub older than that field leaves it out. */
    available: Array<{ type: InferenceBackendType; running: boolean; healthy: boolean; modelsLoaded?: number }>;
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
