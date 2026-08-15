import { client } from '@/api-client/client.gen';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHubApiPort, isTauriReleaseBuild, probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';
import { isLocalTauriDevOrigin } from '@/lib/hub-runtime-mode';

describe('tauri-hub-probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ baseUrl: '', credentials: 'include' });
  });

  // `restoreAllMocks` covers neither `stubGlobal` nor a hand-assigned
  // `__TAURI_INTERNALS__`, so without this each test inherits the previous
  // one's runtime mode and reads as passing for the wrong reason.
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('uses native check_hub_status in Tauri release builds', async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'check_hub_status' && args?.url === 'http://127.0.0.1:5002') {
        return true;
      }
      return false;
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'https://tauri.localhost' },
    });
    (window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke };

    expect(isTauriReleaseBuild()).toBe(true);
    const port = await probeHealthyHubApiPort(true);
    expect(port).toBe(5002);
    expect(invoke).toHaveBeenCalledWith('check_hub_status', { url: 'http://127.0.0.1:5002' });
    expect(client.getConfig().baseUrl).toBe('http://127.0.0.1:5002');
  });

  it('on the Vite local frontend, prefers source API 5004 over a leftover Docker Hub on 5002', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:5005', port: '5005' },
    });

    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    expect(await probeHealthyHubApiPort()).toBe(5004);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/health/live']);
  });

  it('does not bind the API client to :5004/:5002 while the UI is the Vite :5005 proxy', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:5005', port: '5005' },
    });
    client.setConfig({ baseUrl: 'http://127.0.0.1:5004', credentials: 'include' });

    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    expect(await probeHealthyHubApiPort(true)).toBe(5004);
    expect(client.getConfig().baseUrl).toBe('');
    expect(client.getConfig().credentials).toBe('include');
  });

  it('falls back to fetch in local Tauri dev', async () => {
    const invoke = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:5005', port: '5005' },
    });
    (window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: url === 'http://127.0.0.1:5004/api/health/live',
      })),
    );

    expect(isTauriReleaseBuild()).toBe(false);
    const port = await probeHealthyHubApiPort();
    expect(port).toBe(5004);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('probes the current dev server port before defaults, and stops there', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5012', port: '5012' },
    });

    const fetch = vi.fn(async (url: string) => ({
      ok: url === 'http://127.0.0.1:5012/api/health/live',
    }));
    vi.stubGlobal('fetch', fetch);

    const port = await probeHealthyHubApiPort();
    expect(port).toBe(5012);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:5012/api/health/live', expect.any(Object));
    // Short-circuit: 5002 and 5004 are never requested once the first candidate answers.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not probe further ports once one answers on a same-origin desktop', async () => {
    // The packaged desktop serves the stack UI from the Hub's own port, so the
    // first candidate always answers. Probing past it produced a recurring
    // ERR_CONNECTION_REFUSED for :5004 on every 3s hub-status poll.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5002', port: '5002' },
    });
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(),
    };

    const fetch = vi.fn(async (url: string) => ({
      ok: url === 'http://127.0.0.1:5002/api/health/live',
    }));
    vi.stubGlobal('fetch', fetch);

    expect(isTauriReleaseBuild()).toBe(false);
    expect(await probeHealthyHubApiPort()).toBe(5002);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('http://127.0.0.1:5004/api/health/live', expect.any(Object));
  });

  it('falls through candidates in order when earlier ports do not answer', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5012', port: '5012' },
    });

    const fetch = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:5012/api/health/live') throw new Error('connection refused');
      return { ok: url === 'http://127.0.0.1:5004/api/health/live' };
    });
    vi.stubGlobal('fetch', fetch);

    const port = await probeHealthyHubApiPort();
    expect(port).toBe(5004);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:5012/api/health/live',
      'http://127.0.0.1:5002/api/health/live',
      'http://127.0.0.1:5004/api/health/live',
    ]);
  });

  it('a non-ok response does not win, and does not stop the sweep', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5012', port: '5012' },
    });

    const fetch = vi.fn(async (url: string) => {
      const healthy = url === 'http://127.0.0.1:5002/api/health/live';
      return { ok: healthy, status: healthy ? 200 : 503 };
    });
    vi.stubGlobal('fetch', fetch);

    expect(await probeHealthyHubApiPort()).toBe(5002);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns null after trying every candidate when none answers', async () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5012', port: '5012' },
    });

    // Both failure modes in one sweep: a refused connection, then a server that
    // is listening but is not the Hub API.
    const fetch = vi.fn(async (url: string) => {
      if (url === 'http://127.0.0.1:5012/api/health/live') throw new Error('connection refused');
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetch);

    expect(await probeHealthyHubApiPort(true)).toBeNull();
    // Only success may short-circuit the sweep — a failure has to keep going,
    // or a healthy port behind a dead one becomes unreachable.
    expect(fetch).toHaveBeenCalledTimes(3);
    // Nothing answered, so the client must not be left pointed at a dead port.
    expect(client.getConfig().baseUrl).toBe('');
  });

  it('treats 127 loopback origins as local Tauri dev', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://127.0.0.1:5002' },
    });
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(),
    };

    expect(isTauriReleaseBuild()).toBe(false);
  });

  it('does not treat localhost subdomains as local Tauri dev', () => {
    expect(isLocalTauriDevOrigin('http://localhost.example.com:5002')).toBe(false);
    expect(isLocalTauriDevOrigin('http://127.0.0.1.example.com:5002')).toBe(false);
    expect(isLocalTauriDevOrigin('http://localhost:5002')).toBe(true);
    expect(isLocalTauriDevOrigin('http://127.0.0.1:5002')).toBe(true);
  });

  it('configureHubApiPort omits credentials in release builds', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'https://tauri.localhost' },
    });
    (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(),
    };

    configureHubApiPort(5002);
    expect(client.getConfig().credentials).toBe('omit');
  });
});
