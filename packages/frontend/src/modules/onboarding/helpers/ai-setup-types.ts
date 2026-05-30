import type { CloudProviderType, CuratedModel, HardwareProfile, HardwareTier, InferenceBackendType, MemoryBudget } from '@ci-hub/common/types';

/** The Companion agent framework that powers the user's system. */
export type AgentFramework = 'openclaw' | 'hermes';

/** Maps a chosen agent framework to the app store slug (id) that installs it. */
export const AGENT_APP_SLUG: Record<AgentFramework, string> = {
  openclaw: 'openclaw',
  hermes: 'hermes-agent',
};

/** AI setup state managed by the AiSetupStep and passed down to InstallStep / CompleteStep. */
export interface AiSetupConfig {
  /** Chosen agent framework. OpenClaw is the default, but the user can deselect to run no agent. */
  agentFramework?: AgentFramework;
  selectedModels: string[];
  backend: InferenceBackendType;
  cloudProviders: CloudProviderInput[];
  /**
   * Catalog id of the preferred default model that Companion agents (Hermes, OpenClaw) and the Hub
   * use by default. Always one of `selectedModels` when set. Undefined when AI setup was skipped or
   * the hardware can't run a local model.
   */
  preferredModelId?: string;
  /**
   * Preferred remote-access transport for the user's Companion agents (Hermes, OpenClaw) and Hub
   * services: 'tailscale' (private VPN), 'cloudflare' (public web URL), or 'local' (no remote
   * exposure). Seeds the default exposure mode used when onboarding installs apps. Undefined when
   * AI setup was skipped.
   */
  exposureMode?: ExposureMode;
  skipped: boolean;
}

/** How the user reaches their agents/Hub from other devices. "Web" in the UI maps to 'cloudflare'. */
export type ExposureMode = 'cloudflare' | 'tailscale' | 'local';

export interface CloudProviderInput {
  provider: CloudProviderType;
  apiKey: string;
  enabled: boolean;
}

export interface InferencePreferencesResponse {
  preferredBackend: InferenceBackendType | null;
  preferredModel: string | null;
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
  memoryBudget: MemoryBudget;
  backends: {
    recommended: InferenceBackendType;
    available: Array<{ type: InferenceBackendType; running: boolean; healthy: boolean }>;
  };
  resourceEstimate: {
    totalDiskMb: number;
    totalMemoryMb: number;
    availableMemoryMb: number;
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
