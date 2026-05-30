import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { CloudFallbackService } from '../cloud-fallback.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('CloudFallbackService.setProvider', () => {
  let service: CloudFallbackService;

  beforeEach(() => {
    service = new CloudFallbackService(mock<LoggerService>());
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
});
