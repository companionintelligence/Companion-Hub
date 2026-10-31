/**
 * End-to-end wiring for the mobile login critical path.
 *
 * Uses the *real* generated API client, the real request interceptor (the one
 * root.tsx installs), the real runtime-fetch swap, and the real
 * mobile-connection + api-fetch session code — only the Tauri native plugins are
 * mocked. This is the regression guard for: after the user picks a Hub,
 * subsequent generated-client calls (the Hub `/login` POST, `userContext`, …)
 * must reach the *remote* Hub through the native HTTP client and carry the
 * `X-CI-Hub-Session` header, so the session is actually authenticated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { client } from '@/api-client/client.gen';
import { getTauriSessionId, setTauriSessionId } from './api-fetch';
import { clearHubConnection, isTauriMobileSync, resetMobileClientCacheForTests, setHubConnection } from './mobile-connection';
import { resetActiveFetch, runtimeFetch } from './runtime-fetch';
import { loadTauriHttpFetch } from './tauri-http-fetch';

// Create the spy in Vitest's hoisted mock scope so the dynamic plugin import
// and this test always observe the same function across the full suite.
const { httpFetch } = vi.hoisted(() => ({
  httpFetch: vi.fn(
    async (..._args: unknown[]) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ),
}));
const { webFetch } = vi.hoisted(() => ({
  webFetch: vi.fn(async () => new Response(JSON.stringify({ source: 'webview' }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));
vi.mock('./tauri-http-fetch', () => ({ loadTauriHttpFetch: vi.fn(async () => httpFetch) }));

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({ get: async () => null, set: vi.fn(async () => {}), delete: vi.fn(async () => {}), save: vi.fn(async () => {}) })),
}));

// Persist the session like an on-device release build.
vi.mock('@/lib/hub-runtime-mode', () => ({ usesCrossOriginDesktopApi: () => true }));

function setMobileTauri() {
  const userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent,
    configurable: true,
  });
  // Node 22+ exposes its own global navigator, separate from JSDOM's window.navigator.
  // The app reads the global, so stub it explicitly instead of relying on realm aliasing.
  vi.stubGlobal('navigator', { userAgent, platform: 'iPhone', maxTouchPoints: 1 });
}

// Install the exact request interceptor root.tsx installs (session header).
// (Test files are module-isolated, so this singleton mutation doesn't leak.)
client.interceptors.request.use((request: Request) => {
  const sid = getTauriSessionId();
  if (sid) request.headers.set('X-CI-Hub-Session', sid);
  return request;
});

beforeEach(() => {
  resetActiveFetch();
  resetMobileClientCacheForTests();
  httpFetch.mockClear();
  webFetch.mockClear();
  vi.mocked(loadTauriHttpFetch).mockClear();
  vi.stubGlobal('fetch', webFetch);
  localStorage.clear();
  sessionStorage.clear();
  setMobileTauri();
  // Clearing a null session checks the current platform; install the mobile
  // runtime first so that cleanup cannot cache a desktop result from Node's UA.
  setTauriSessionId(null);
});

afterEach(async () => {
  setTauriSessionId(null);
  await clearHubConnection();
  vi.unstubAllGlobals();
});

describe('mobile login integration', () => {
  it('routes an authenticated generated-client call to the chosen Hub via native fetch + session header', async () => {
    expect(navigator.userAgent).toContain('iPhone');
    expect(isTauriMobileSync()).toBe(true);
    await setHubConnection('https://hub-apple-acme.ci.computer/');
    setTauriSessionId('sess-abc'); // as login onSuccess does

    expect(loadTauriHttpFetch).toHaveBeenCalledTimes(1);
    expect(client.getConfig().baseUrl).toBe('https://hub-apple-acme.ci.computer');
    expect(client.getConfig().fetch).toBe(runtimeFetch);
    await client.get({ url: '/api/user-context' });

    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(webFetch).not.toHaveBeenCalled();
    const req = httpFetch.mock.calls[0]?.[0] as Request;
    expect(req.url).toBe('https://hub-apple-acme.ci.computer/api/user-context'); // remote Hub, trailing slash trimmed
    expect(req.headers.get('X-CI-Hub-Session')).toBe('sess-abc'); // authenticated
  });

  it('carries the session to a *different* Hub after a switch (clear → reconnect)', async () => {
    await setHubConnection('https://hub-a.ci.computer');
    setTauriSessionId('sess-a');
    await client.get({ url: '/api/user-context' });
    expect((httpFetch.mock.calls[0]?.[0] as Request).url).toBe('https://hub-a.ci.computer/api/user-context');

    await clearHubConnection();
    httpFetch.mockClear();

    await setHubConnection('https://hub-b.ci.computer');
    setTauriSessionId('sess-b');
    await client.get({ url: '/api/user-context' });

    const req = httpFetch.mock.calls[0]?.[0] as Request;
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(req.url).toBe('https://hub-b.ci.computer/api/user-context'); // native fetch, new Hub — not stranded on window.fetch
    expect(req.headers.get('X-CI-Hub-Session')).toBe('sess-b');
  });

  it('sends no session header before login (first request is unauthenticated)', async () => {
    await setHubConnection('https://hub-x.ci.computer');
    // no setTauriSessionId — user has not logged into the Hub yet

    await client.get({ url: '/api/registration/status' });

    const req = httpFetch.mock.calls[0]?.[0] as Request;
    expect(req.url).toBe('https://hub-x.ci.computer/api/registration/status');
    expect(req.headers.get('X-CI-Hub-Session')).toBeNull();
  });
});
