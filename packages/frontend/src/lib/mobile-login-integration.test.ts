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
import { clearHubConnection, setHubConnection } from './mobile-connection';

// Native Tauri HTTP client — records what it is asked to fetch.
const httpFetch = vi.fn(
  async (..._args: unknown[]) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
);
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: httpFetch }));

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({ get: async () => null, set: vi.fn(async () => {}), delete: vi.fn(async () => {}), save: vi.fn(async () => {}) })),
}));

// Persist the session like an on-device release build.
vi.mock('@/lib/hub-runtime-mode', () => ({ usesCrossOriginDesktopApi: () => true }));

function setMobileTauri() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    configurable: true,
  });
}

// Install the exact request interceptor root.tsx installs (session header).
// (Test files are module-isolated, so this singleton mutation doesn't leak.)
client.interceptors.request.use((request: Request) => {
  const sid = getTauriSessionId();
  if (sid) request.headers.set('X-CI-Hub-Session', sid);
  return request;
});

beforeEach(() => {
  httpFetch.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  setTauriSessionId(null);
  setMobileTauri();
});

afterEach(async () => {
  setTauriSessionId(null);
  await clearHubConnection();
});

describe('mobile login integration', () => {
  it('routes an authenticated generated-client call to the chosen Hub via native fetch + session header', async () => {
    await setHubConnection('https://hub-apple-acme.ci.computer/');
    setTauriSessionId('sess-abc'); // as login onSuccess does

    await client.get({ url: '/api/user-context' });

    expect(httpFetch).toHaveBeenCalledTimes(1);
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
