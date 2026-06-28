import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TAURI_SESSION_STORAGE_KEY, clearStaleTauriSession, getTauriSessionId, setTauriSessionId } from './api-fetch';

const { isTauriReleaseBuild } = vi.hoisted(() => ({
  isTauriReleaseBuild: vi.fn(() => false),
}));

vi.mock('@/lib/tauri-hub-probe', () => ({
  isTauriReleaseBuild,
}));

describe('api-fetch session storage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    isTauriReleaseBuild.mockReturnValue(false);
    setTauriSessionId(null);
  });

  afterEach(() => {
    setTauriSessionId(null);
  });

  it('stores the session in sessionStorage for browser builds', () => {
    setTauriSessionId('browser-session');

    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('browser-session');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
    expect(getTauriSessionId()).toBe('browser-session');
  });

  it('stores the session in localStorage for Tauri release builds', () => {
    isTauriReleaseBuild.mockReturnValue(true);

    setTauriSessionId('desktop-session');

    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('desktop-session');
    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('desktop-session');
    expect(getTauriSessionId()).toBe('desktop-session');
  });

  it('restores a Tauri release session after an in-memory reset (simulated relaunch)', () => {
    isTauriReleaseBuild.mockReturnValue(true);
    setTauriSessionId('desktop-session');

    setTauriSessionId(null);
    localStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'desktop-session');

    expect(getTauriSessionId()).toBe('desktop-session');
  });

  it('migrates legacy sessionStorage sessions into localStorage on read', () => {
    isTauriReleaseBuild.mockReturnValue(true);
    sessionStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'legacy-session');

    expect(getTauriSessionId()).toBe('legacy-session');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('legacy-session');
  });

  it('clears stale sessions from all stores', () => {
    isTauriReleaseBuild.mockReturnValue(true);
    setTauriSessionId('desktop-session');

    clearStaleTauriSession();

    expect(getTauriSessionId()).toBeNull();
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
  });
});
