import { describe, expect, it } from 'vitest';
import { applyCloudProviderEnv, buildCloudProviderEnv, cloudProviderManagedKeys } from '../cloud-provider-env';

describe('buildCloudProviderEnv', () => {
  it('emits CI_CLOUD_* and conventional aliases for every enabled provider', () => {
    expect(
      buildCloudProviderEnv([
        { provider: 'openai', apiKey: 'sk-oai', enabled: true, defaultModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        { provider: 'anthropic', apiKey: 'sk-ant', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://api.anthropic.com/v1' },
        {
          provider: 'google',
          apiKey: 'g-key',
          enabled: true,
          defaultModel: 'gemini-2.5-pro',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        },
        { provider: 'github-copilot', apiKey: 'gh-key', enabled: false, defaultModel: 'claude-opus-4' },
      ]),
    ).toEqual({
      CI_CLOUD_OPENAI_API_KEY: 'sk-oai',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
      CI_CLOUD_ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
      CI_CLOUD_ANTHROPIC_MODEL: 'claude-opus-4',
      ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_GOOGLE_API_KEY: 'g-key',
      CI_CLOUD_GOOGLE_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      CI_CLOUD_GOOGLE_MODEL: 'gemini-2.5-pro',
      GOOGLE_API_KEY: 'g-key',
      GEMINI_API_KEY: 'g-key',
    });
  });

  it('skips providers without a key', () => {
    expect(buildCloudProviderEnv([{ provider: 'openai', enabled: true, defaultModel: 'gpt-4o' }])).toEqual({});
  });
});

describe('applyCloudProviderEnv', () => {
  it('copies keys onto an env map', () => {
    const envMap = new Map<string, string>([['EXISTING', '1']]);
    applyCloudProviderEnv(envMap, { ANTHROPIC_API_KEY: 'sk-ant' });
    expect(envMap.get('EXISTING')).toBe('1');
    expect(envMap.get('ANTHROPIC_API_KEY')).toBe('sk-ant');
  });
});

describe('cloudProviderManagedKeys', () => {
  it('includes every Hub-managed cloud key', () => {
    const keys = cloudProviderManagedKeys();
    expect(keys).toContain('CI_CLOUD_OPENAI_API_KEY');
    expect(keys).toContain('ANTHROPIC_API_KEY');
    expect(keys).toContain('GEMINI_API_KEY');
    expect(keys).toContain('CI_CLOUD_GITHUB_COPILOT_API_KEY');
  });
});
