import { describe, expect, it } from 'vitest';
import { scrubString } from './sentry-scrubber';

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
