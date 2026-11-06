import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '@/api-client/client.gen';
import { apiFetch, getTauriSessionId, hydrateDesktopSession, setTauriSessionId, TAURI_SESSION_STORAGE_KEY } from './api-fetch';
import { resetActiveFetch, setActiveFetch } from './runtime-fetch';

// The desktop is not a phone.
vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => false,
  isMobileClient: () => false,
}));

type NativeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The X-CI-Hub-Session header of one recorded native fetch call, or null when it was not sent. */
function sessionHeaderOf(call: [RequestInfo | URL, RequestInit?] | undefined): string | null {
  return new Headers(call?.[1]?.headers).get('X-CI-Hub-Session');
}

/** The keychain behind the fake Tauri IPC: the native secure store's commands, over a plain Map. */
const keychain = new Map<string, string>();

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  const key = String(args?.key);
  switch (cmd) {
    case 'plugin:ci-auth|secure_get':
      return { value: keychain.get(key) ?? null };
    case 'plugin:ci-auth|secure_set':
      keychain.set(key, String(args?.value));
      return undefined;
    case 'plugin:ci-auth|secure_remove':
      keychain.delete(key);
      return undefined;
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

type TauriWindow = { __TAURI_INTERNALS__?: { invoke: typeof invoke } };
const tauriWindow = window as unknown as TauriWindow;

beforeEach(() => {
  keychain.clear();
  localStorage.clear();
  sessionStorage.clear();
  invoke.mockClear();
  tauriWindow.__TAURI_INTERNALS__ = { invoke };
  // Start from a known in-memory state: the keychain is the only store the desktop writes.
  setTauriSessionId(null);
  invoke.mockClear();
});

afterEach(() => {
  setTauriSessionId(null);
  delete tauriWindow.__TAURI_INTERNALS__;
  resetActiveFetch();
  client.setConfig({ baseUrl: undefined });
  vi.restoreAllMocks();
});

describe('desktop session in the OS keychain', () => {
  it('writes the session id to the keychain and not to localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    setTauriSessionId('abc');

    await vi.waitFor(() => expect(keychain.get('ci.hub.session')).toBe('abc'));
    expect(setItem).not.toHaveBeenCalledWith(TAURI_SESSION_STORAGE_KEY, expect.anything());
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('forgets the session in the keychain and clears a copy left in localStorage when cleared', async () => {
    keychain.set('ci.hub.session', 'abc');
    localStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'stale-copy');

    setTauriSessionId(null);

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_remove', { key: 'ci.hub.session' }));
    await vi.waitFor(() => expect(keychain.has('ci.hub.session')).toBe(false));
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('loads the session from the keychain at startup, with no web-storage read', async () => {
    keychain.set('ci.hub.session', 'from-keychain');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    await expect(hydrateDesktopSession()).resolves.toBe('from-keychain');

    expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_get', { key: 'ci.hub.session' });
    expect(getTauriSessionId()).toBe('from-keychain');
    expect(getItem).not.toHaveBeenCalled();
  });

  it('moves a session an older build left in localStorage into the keychain, then removes the web copy', async () => {
    localStorage.setItem(TAURI_SESSION_STORAGE_KEY, 'legacy-id');

    await expect(hydrateDesktopSession()).resolves.toBe('legacy-id');

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_set', { key: 'ci.hub.session', value: 'legacy-id' }));
    expect(keychain.get('ci.hub.session')).toBe('legacy-id');
    expect(localStorage.getItem(TAURI_SESSION_STORAGE_KEY)).toBeNull();
    expect(getTauriSessionId()).toBe('legacy-id');
  });

  it('sends X-CI-Hub-Session once the keychain session is hydrated, and not before', async () => {
    client.setConfig({ baseUrl: 'https://hub-x.ci.computer', credentials: 'omit' });
    keychain.set('ci.hub.session', 'hydrated-id');
    const nativeFetch = vi.fn<NativeFetch>(async () => new Response('{}', { status: 200 }));
    setActiveFetch(nativeFetch);

    await apiFetch('/api/apps');
    await hydrateDesktopSession();
    await apiFetch('/api/apps');

    const [before, after] = nativeFetch.mock.calls;
    expect(sessionHeaderOf(before)).toBeNull();
    expect(after?.[0]).toBe('https://hub-x.ci.computer/api/apps');
    expect(sessionHeaderOf(after)).toBe('hydrated-id');
  });
});
