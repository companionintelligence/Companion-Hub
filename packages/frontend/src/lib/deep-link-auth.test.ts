import { afterEach, describe, expect, it } from 'vitest';
import { clearPersistedDesktopPortalToken, persistDesktopPortalToken, takePersistedDesktopPortalToken } from './deep-link-auth';

describe('desktop portal token persist', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a token across a simulated reload', () => {
    persistDesktopPortalToken('tok-reload');
    expect(takePersistedDesktopPortalToken()).toBe('tok-reload');
    clearPersistedDesktopPortalToken();
    expect(takePersistedDesktopPortalToken()).toBeNull();
  });
});
