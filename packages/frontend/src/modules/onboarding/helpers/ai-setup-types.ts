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
  /** Catalog ids already present in Ollama — install skips re-download for these. */
  installedCatalogIds: string[];
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

export interface InferencePreferencesResponse {
  preferredBackend: InferenceBackendType | null;
  preferredModel: string | null;
  preferredEmbeddingModel: string | null;
  preferredVisionModel: string | null;
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
  /** Catalog ids already pulled in Ollama (from live /api/tags). */
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
