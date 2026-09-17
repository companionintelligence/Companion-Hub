import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPersistedDesktopPortalToken,
  isUsedDesktopPortalToken,
  persistDesktopPortalToken,
  rememberUsedDesktopPortalToken,
  takePersistedDesktopPortalToken,
} from './deep-link-auth';

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

describe('used desktop portal tokens', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('remembers used tokens across a simulated reload', () => {
    expect(isUsedDesktopPortalToken('tok-a')).toBe(false);
    rememberUsedDesktopPortalToken('tok-a');
    rememberUsedDesktopPortalToken('tok-a');
    expect(isUsedDesktopPortalToken('tok-a')).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('ci-hub.used-desktop-portal-tokens') ?? '[]')).toEqual(['tok-a']);
  });

  it('keeps only the most recent tokens', () => {
    for (let i = 0; i < 25; i++) rememberUsedDesktopPortalToken(`tok-${i}`);
    expect(isUsedDesktopPortalToken('tok-0')).toBe(false);
    expect(isUsedDesktopPortalToken('tok-24')).toBe(true);
  });

  it('treats unreadable storage as no used tokens', () => {
    sessionStorage.setItem('ci-hub.used-desktop-portal-tokens', 'not json');
    expect(isUsedDesktopPortalToken('tok-a')).toBe(false);
    rememberUsedDesktopPortalToken('tok-a');
    expect(isUsedDesktopPortalToken('tok-a')).toBe(true);
  });
});
