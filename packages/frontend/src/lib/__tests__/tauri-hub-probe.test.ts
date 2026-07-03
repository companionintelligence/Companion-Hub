import { client } from '@/api-client/client.gen';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHubApiPort, isLocalTauriDevOrigin, isTauriReleaseBuild, probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';

describe('tauri-hub-probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ baseUrl: '', credentials: 'include' });
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

  it('falls back to fetch in local Tauri dev', async () => {
    const invoke = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:5005' },
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

  it('probes the current dev server port before defaults', async () => {
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
    expect(fetch).toHaveBeenCalledTimes(3);
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
