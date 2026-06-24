import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setTauriSessionId } = vi.hoisted(() => ({
  setTauriSessionId: vi.fn(),
}));

vi.mock('./api-fetch', () => ({
  setTauriSessionId,
}));

import { clearClientHubState, clearRememberedPortalAccountEmail } from './clear-client-hub-state';

describe('clearClientHubState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem('device-registered', 'true');
    sessionStorage.setItem('device-registered-at', String(Date.now()));
    sessionStorage.setItem('ci-hub-registration-drift-choice', 'restore');
    localStorage.setItem('ci-hub.portalAccountEmail', 'operator@example.com');
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('clears registration, drift, session, and portal hints by default', () => {
    clearClientHubState();

    expect(sessionStorage.getItem('device-registered')).toBeNull();
    expect(sessionStorage.getItem('device-registered-at')).toBeNull();
    expect(sessionStorage.getItem('ci-hub-registration-drift-choice')).toBeNull();
    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBeNull();
    expect(setTauriSessionId).toHaveBeenCalledWith(null);
  });

  it('can keep the remembered portal email on logout-style clears', () => {
    clearClientHubState({ keepPortalEmail: true });

    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBe('operator@example.com');
    expect(setTauriSessionId).toHaveBeenCalledWith(null);
  });

  it('clears remembered portal email directly', () => {
    clearRememberedPortalAccountEmail();

    expect(localStorage.getItem('ci-hub.portalAccountEmail')).toBeNull();
  });
});
