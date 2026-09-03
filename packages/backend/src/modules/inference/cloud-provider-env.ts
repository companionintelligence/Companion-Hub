import type { CloudProviderConfig, CloudProviderType } from '@ci-hub/common/types';

export interface CloudProviderEnvSpec {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Conventional names apps already read (never OPENAI_API_KEY — that is the local backend). */
  aliases?: string[];
}

export const CLOUD_PROVIDER_ENV: Record<CloudProviderType, CloudProviderEnvSpec> = {
  openai: {
    apiKey: 'CI_CLOUD_OPENAI_API_KEY',
    baseUrl: 'CI_CLOUD_OPENAI_BASE_URL',
    model: 'CI_CLOUD_OPENAI_MODEL',
  },
  anthropic: {
    apiKey: 'CI_CLOUD_ANTHROPIC_API_KEY',
    baseUrl: 'CI_CLOUD_ANTHROPIC_BASE_URL',
    model: 'CI_CLOUD_ANTHROPIC_MODEL',
    aliases: ['ANTHROPIC_API_KEY'],
  },
  google: {
    apiKey: 'CI_CLOUD_GOOGLE_API_KEY',
    baseUrl: 'CI_CLOUD_GOOGLE_BASE_URL',
    model: 'CI_CLOUD_GOOGLE_MODEL',
    aliases: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  },
  'github-copilot': {
    apiKey: 'CI_CLOUD_GITHUB_COPILOT_API_KEY',
    baseUrl: 'CI_CLOUD_GITHUB_COPILOT_BASE_URL',
    model: 'CI_CLOUD_GITHUB_COPILOT_MODEL',
  },
};

/** Env keys Hub rewrites on every AI-app restart / bootstrap.env fetch. */
export function cloudProviderManagedKeys(): string[] {
  const keys = new Set<string>();
  for (const spec of Object.values(CLOUD_PROVIDER_ENV)) {
    keys.add(spec.apiKey);
    keys.add(spec.baseUrl);
    keys.add(spec.model);
    for (const alias of spec.aliases ?? []) {
      keys.add(alias);
    }
  }
  return [...keys];
}

/**
 * Additive cloud-provider credentials. Does not replace the local Ollama/vLLM
 * connection — those stay on CI_LLM_* / OPENAI_API_*.
 */
export function buildCloudProviderEnv(providers: CloudProviderConfig[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of providers) {
    if (!provider.enabled || !provider.apiKey?.trim()) continue;
    const spec = CLOUD_PROVIDER_ENV[provider.provider];
    if (!spec) continue;
    env[spec.apiKey] = provider.apiKey.trim();
    if (provider.baseUrl?.trim()) env[spec.baseUrl] = provider.baseUrl.trim();
    if (provider.defaultModel?.trim()) env[spec.model] = provider.defaultModel.trim();
    for (const alias of spec.aliases ?? []) {
      env[alias] = provider.apiKey.trim();
    }
  }
  return env;
}

export function applyCloudProviderEnv(envMap: Map<string, string>, cloudEnv: Record<string, string> | undefined): void {
  if (!cloudEnv) return;
  for (const [key, value] of Object.entries(cloudEnv)) {
    if (value) envMap.set(key, value);
  }
}
