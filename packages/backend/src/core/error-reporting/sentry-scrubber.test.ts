import { describe, expect, it } from 'vitest';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { scrubEvent, scrubString } from './sentry-scrubber';

describe('scrubString', () => {
  it('redacts home paths and secrets', () => {
    const input = 'Failed at /Users/alice/Library/Application Support/companion-hub token=super-secret JWT_SECRET=abc123';
    const scrubbed = scrubString(input);

    expect(scrubbed).not.toContain('/Users/alice');
    expect(scrubbed).toContain('[Filtered]');
  });

  it('redacts Linux home paths', () => {
    const scrubbed = scrubString('EACCES at /home/bennett/.internal/state/settings.json');

    expect(scrubbed).not.toContain('/home/bennett');
    expect(scrubbed).toContain('~');
  });

  it('redacts Windows user paths', () => {
    const scrubbed = scrubString('Failed at C:\\Users\\Bennett\\AppData\\Roaming\\companion-hub');

    expect(scrubbed).not.toContain('C:\\Users\\Bennett');
    expect(scrubbed).toContain('~');
  });
});

describe('scrubEvent transient DB handling', () => {
  it('downgrades and fingerprints EAI_AGAIN query failures', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    const event = {
      level: 'error',
      exception: { values: [{ type: 'Error', value: 'Failed query: select id from user' }] },
      tags: {},
    };

    const result = scrubEvent(event as never, { originalException: cause });

    expect(result?.level).toBe('warning');
    expect(result?.fingerprint).toEqual(['transient-db-unreachable']);
    expect(result?.tags?.error_class).toBe('transient-db-unreachable');
  });

  it('downgrades ApiKeyStoreUnavailableError the same way', () => {
    const event = {
      level: 'error',
      exception: { values: [{ type: 'ApiKeyStoreUnavailableError', value: 'API key store unavailable: database unreachable' }] },
      tags: {},
    };

    const result = scrubEvent(event as never, {
      originalException: new ApiKeyStoreUnavailableError(new Error('getaddrinfo EAI_AGAIN ci-hub-db')),
    });

    expect(result?.level).toBe('warning');
    expect(result?.fingerprint).toEqual(['transient-db-unreachable']);
  });
});
