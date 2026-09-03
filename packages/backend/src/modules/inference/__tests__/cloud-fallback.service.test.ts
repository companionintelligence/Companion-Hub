import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { CloudFallbackService } from '../cloud-fallback.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';

describe('CloudFallbackService.setProvider', () => {
  let service: CloudFallbackService;
  let configuration: ReturnType<typeof mock<ConfigurationService>>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([]);
    configuration.setInferenceCloudProviders.mockResolvedValue([]);
    service = new CloudFallbackService(mock<LoggerService>(), configuration);
    service.onModuleInit();
  });

  it('backfills the canonical base URL when none is provided (onboarding path)', () => {
    // Onboarding POSTs only provider/apiKey/enabled (+ a defaulted model) — no baseUrl.
    service.setProvider({ provider: 'openai', apiKey: 'sk-test', enabled: true, defaultModel: 'gpt-4o' });

    const provider = service.getProvider('openai');
    expect(provider?.baseUrl).toBe('https://api.openai.com/v1');
    expect(provider?.defaultModel).toBe('gpt-4o');
  });

  it('respects an explicitly provided base URL', () => {
    service.setProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      enabled: true,
      defaultModel: 'claude-opus-4',
      baseUrl: 'https://proxy.internal/v1',
    });

    expect(service.getProvider('anthropic')?.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('backfills a default model when one is missing', () => {
    service.setProvider({ provider: 'google', apiKey: 'key', enabled: true, defaultModel: '' });

    const provider = service.getProvider('google');
    expect(provider?.defaultModel).toBe('gemini-2.5-pro');
    expect(provider?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('keeps the stored API key when a later save omits it (masked Settings field)', () => {
    service.setProvider({ provider: 'openai', apiKey: 'sk-live', enabled: true, defaultModel: 'gpt-4o' });
    service.setProvider({ provider: 'openai', enabled: false, defaultModel: 'gpt-4o' });

    expect(service.getProvider('openai')?.apiKey).toBe('sk-live');
    expect(service.getProvider('openai')?.enabled).toBe(false);
  });

  it('reloads persisted providers on boot', () => {
    configuration.getInferenceCloudProviders.mockReturnValue([
      { provider: 'anthropic', apiKey: 'sk-ant', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://api.anthropic.com/v1' },
    ]);
    const booted = new CloudFallbackService(mock<LoggerService>(), configuration);
    booted.onModuleInit();

    expect(booted.getEnabledProviders()).toHaveLength(1);
    expect(booted.getProvider('anthropic')?.apiKey).toBe('sk-ant');
  });

  it('emits additive env for every enabled provider', () => {
    service.setProvider({ provider: 'openai', apiKey: 'sk-oai', enabled: true, defaultModel: 'gpt-4o' });
    service.setProvider({ provider: 'anthropic', apiKey: 'sk-ant', enabled: true, defaultModel: 'claude-opus-4' });
    service.setProvider({ provider: 'google', apiKey: 'g-key', enabled: false, defaultModel: 'gemini-2.5-pro' });

    expect(service.toAppEnv()).toEqual({
      CI_CLOUD_OPENAI_API_KEY: 'sk-oai',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
      CI_CLOUD_ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
      CI_CLOUD_ANTHROPIC_MODEL: 'claude-opus-4',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });
});
