import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { usesCrossOriginDesktopApi } = vi.hoisted(() => ({
  usesCrossOriginDesktopApi: vi.fn(() => false),
}));

vi.mock('@/lib/hub-runtime-mode', () => ({
  usesCrossOriginDesktopApi,
}));

const { isTauriMobileSync, isMobileClient } = vi.hoisted(() => ({
  isTauriMobileSync: vi.fn(() => false),
  isMobileClient: vi.fn(() => false),
}));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync,
  isMobileClient,
}));

const { mockStoreData, mockStoreSet, mockStoreDelete, mockStoreSave } = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    mockStoreData: data,
    mockStoreSet: vi.fn(async (k: string, v: unknown) => {
      data[k] = v;
    }),
    mockStoreDelete: vi.fn(async (k: string) => {
      delete data[k];
    }),
    mockStoreSave: vi.fn(async () => {}),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({})),
}));

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => mockStoreData[k] ?? null,
    set: mockStoreSet,
    delete: mockStoreDelete,
    save: mockStoreSave,
  })),
}));

const { handleSessionExpired } = vi.hoisted(() => ({ handleSessionExpired: vi.fn(async () => {}) }));
vi.mock('@/lib/session-expired', () => ({ handleSessionExpired }));

import { client } from '@/api-client/client.gen';
import {
  HUB_SESSION_ISSUED_AT_KEY,
  TAURI_SESSION_STORAGE_KEY,
  apiFetch,
  clearMobileSession,
  clearStaleTauriSession,
  getTauriSessionId,
  hydrateMobileSession,
  resetMobileSessionStoreForTests,
  setTauriSessionId,
} from './api-fetch';
import { resetActiveFetch, setActiveFetch } from './runtime-fetch';

describe('api-fetch session storage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key];
    }
    mockStoreSet.mockClear();
    mockStoreDelete.mockClear();
    isTauriMobileSync.mockReturnValue(false);
    isMobileClient.mockReturnValue(false);
    usesCrossOriginDesktopApi.mockReturnValue(false);
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
    usesCrossOriginDesktopApi.mockReturnValue(true);

    setTauriSessionId('desktop-session');

    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('desktop-session');
    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('desktop-session');
    expect(getTauriSessionId()).toBe('desktop-session');
  });

  it('restores a Tauri release session after an in-memory reset (simulated relaunch)', () => {
    usesCrossOriginDesktopApi.mockReturnValue(true);
    setTauriSessionId('desktop-session');

    setTauriSessionId(null);
    localStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'desktop-session');

    expect(getTauriSessionId()).toBe('desktop-session');
  });

  it('migrates legacy sessionStorage sessions into localStorage on read', () => {
    usesCrossOriginDesktopApi.mockReturnValue(true);
    sessionStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'legacy-session');

    expect(getTauriSessionId()).toBe('legacy-session');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBe('legacy-session');
  });

  it('clears stale sessions from all stores', () => {
    usesCrossOriginDesktopApi.mockReturnValue(true);
    setTauriSessionId('desktop-session');

    clearStaleTauriSession();

    expect(getTauriSessionId()).toBeNull();
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('api-fetch mobile secure session storage', () => {
  beforeEach(async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => ({})),
    };
    resetMobileSessionStoreForTests();
    localStorage.clear();
    sessionStorage.clear();
    setTauriSessionId(null);
    await clearMobileSession();
    for (const key of Object.keys(mockStoreData)) {
      delete mockStoreData[key];
    }
    mockStoreSet.mockClear();
    mockStoreDelete.mockClear();
    mockStoreSave.mockClear();
    isTauriMobileSync.mockReturnValue(true);
    isMobileClient.mockReturnValue(true);
    usesCrossOriginDesktopApi.mockReturnValue(true);
  });

  afterEach(async () => {
    setTauriSessionId(null);
    await clearMobileSession();
    resetMobileSessionStoreForTests();
  });

  it('persists session to Tauri store and keeps in-memory cache without plaintext localStorage', async () => {
    setTauriSessionId('mobile-secure-token', 123456789);

    expect(getTauriSessionId()).toBe('mobile-secure-token');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();

    await vi.waitFor(() => {
      expect(mockStoreSet).toHaveBeenCalledWith(TAURI_SESSION_STORAGE_KEY, 'mobile-secure-token');
      expect(mockStoreSet).toHaveBeenCalledWith(HUB_SESSION_ISSUED_AT_KEY, '123456789');
      expect(mockStoreSave).toHaveBeenCalled();
    });
  });

  it('hydrates in-memory cache from Tauri store on cold start', async () => {
    mockStoreData[TAURI_SESSION_STORAGE_KEY] = 'persisted-mobile-token';
    mockStoreData[HUB_SESSION_ISSUED_AT_KEY] = '987654321';

    const hydrated = await hydrateMobileSession();

    expect(hydrated).toBe('persisted-mobile-token');
    expect(getTauriSessionId()).toBe('persisted-mobile-token');
  });

  it('migrates legacy localStorage session into Tauri store on mobile hydration', async () => {
    localStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'legacy-mobile-token');

    const hydrated = await hydrateMobileSession();

    expect(hydrated).toBe('legacy-mobile-token');
    expect(getTauriSessionId()).toBe('legacy-mobile-token');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();

    await vi.waitFor(() => {
      expect(mockStoreSet).toHaveBeenCalledWith(TAURI_SESSION_STORAGE_KEY, 'legacy-mobile-token');
      expect(mockStoreSave).toHaveBeenCalled();
    });
  });

  it('clears session from Tauri store when clearStaleTauriSession is called', async () => {
    setTauriSessionId('mobile-token-to-clear');
    clearStaleTauriSession();

    expect(getTauriSessionId()).toBeNull();
    await vi.waitFor(() => {
      expect(mockStoreDelete).toHaveBeenCalledWith(TAURI_SESSION_STORAGE_KEY);
      expect(mockStoreDelete).toHaveBeenCalledWith(HUB_SESSION_ISSUED_AT_KEY);
      expect(mockStoreSave).toHaveBeenCalled();
    });
  });
});

describe('apiFetch (raw helper — session header + native routing)', () => {
  let active: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    usesCrossOriginDesktopApi.mockReturnValue(true); // mobile/desktop release: session via header
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

describe('api-fetch 401 handling', () => {
  beforeEach(() => {
    handleSessionExpired.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the user to login when a normal request 401s', async () => {
    await apiFetch('/api/apps');

    await vi.waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
  });

  it.each(['/api/auth/login', '/api/auth/logout', '/api/auth/session/refresh', '/api/auth/browser-handoff/mint'])(
    'leaves the session alone when %s 401s',
    async (path) => {
      // The handoff mint is a best-effort bridge on the way to an external open and is
      // documented as fail-open: a 401 there must not tear the page down mid-click,
      // which also aborted the pending open and left the user on a login screen (#944).
      //
      // The exempt request goes FIRST and a non-exempt control second. The handler is
      // reached through a dynamic import, so waiting a fixed tick would pass vacuously on
      // a slow resolve; waiting for the control instead proves the pipeline had time, and
      // because the exempt call queued its continuation first, anything it was going to
      // fire has already fired by the time the control's does.
      await apiFetch(path);
      await apiFetch('/api/apps');

      await vi.waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
      expect(handleSessionExpired).toHaveBeenCalledTimes(1);
    },
  );
});
