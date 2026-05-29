import type { CloudProviderType, CuratedModel, HardwareProfile, HardwareTier, InferenceBackendType, MemoryBudget } from '@ci-hub/common/types';

/** AI setup state managed by the AiSetupStep and passed down to InstallStep / CompleteStep. */
export interface AiSetupConfig {
  selectedModels: string[];
  backend: InferenceBackendType;
  cloudProviders: CloudProviderInput[];
  /**
   * Catalog id of the preferred default model that Companion agents (Hermes, OpenClaw) and the Hub
   * use by default. Always one of `selectedModels` when set. Undefined when AI setup was skipped or
   * the hardware can't run a local model.
   */
  preferredModelId?: string;
  skipped: boolean;
}

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
