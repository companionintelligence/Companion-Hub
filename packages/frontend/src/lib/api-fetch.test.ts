import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '@/api-client/client.gen';
import { apiFetch, TAURI_SESSION_STORAGE_KEY, clearStaleTauriSession, getTauriSessionId, setTauriSessionId } from './api-fetch';
import { resetActiveFetch, setActiveFetch } from './runtime-fetch';

const { isTauriReleaseBuild } = vi.hoisted(() => ({
  isTauriReleaseBuild: vi.fn(() => false),
}));

vi.mock('@/lib/tauri-hub-probe', () => ({
  isTauriReleaseBuild,
}));

const { handleSessionExpired } = vi.hoisted(() => ({ handleSessionExpired: vi.fn(async () => {}) }));
vi.mock('@/lib/session-expired', () => ({ handleSessionExpired }));

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

describe('apiFetch (raw helper — session header + native routing)', () => {
  let active: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    isTauriReleaseBuild.mockReturnValue(true); // mobile/desktop release: session via header
    setTauriSessionId(null);
    handleSessionExpired.mockClear();
    // Point the client at a remote Hub and route through a fake native fetch.
    client.setConfig({ baseUrl: 'https://hub-x.ci.computer', credentials: 'omit' });
    active = vi.fn(async () => new Response('{}', { status: 200 }));
    setActiveFetch(active as unknown as typeof fetch);
  });

  afterEach(() => {
    resetActiveFetch();
    client.setConfig({ baseUrl: undefined });
    setTauriSessionId(null);
  });

  it('prepends the Hub baseUrl and attaches the X-CI-Hub-Session header', async () => {
    setTauriSessionId('sess-xyz');

    await apiFetch('/api/mcp-admin/status');

    expect(active).toHaveBeenCalledTimes(1);
    const [url, init] = active.mock.calls[0] ?? [];
    expect(url).toBe('https://hub-x.ci.computer/api/mcp-admin/status');
    expect((init.headers as Headers).get('X-CI-Hub-Session')).toBe('sess-xyz');
    expect(init.credentials).toBe('omit'); // honors the configured cross-origin mode
  });

  it('triggers session-expired handling on a 401 for a protected path', async () => {
    active.mockResolvedValue(new Response('{}', { status: 401 }));

    await apiFetch('/api/mcp-admin/status');

    await vi.waitFor(() => expect(handleSessionExpired).toHaveBeenCalledTimes(1));
  });

  it('does NOT trigger session-expired on a 401 from the login endpoint', async () => {
    active.mockResolvedValue(new Response('{}', { status: 401 }));

    await apiFetch('/api/auth/login', { method: 'POST' });

    // give the (never-scheduled) dynamic import a tick — it must stay uncalled
    await Promise.resolve();
    expect(handleSessionExpired).not.toHaveBeenCalled();
  });
});
