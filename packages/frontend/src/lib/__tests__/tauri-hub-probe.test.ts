import { client } from '@/api-client/client.gen';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHubApiPort, isTauriReleaseBuild, probeHealthyHubApiPort } from '@/lib/tauri-hub-probe';

describe('tauri-hub-probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ baseUrl: '', credentials: 'include' });
  });

  it('uses native check_hub_status in Tauri release builds', async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'check_hub_status' && args?.url === 'http://localhost:5002') {
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
    expect(invoke).toHaveBeenCalledWith('check_hub_status', { url: 'http://localhost:5002' });
    expect(client.getConfig().baseUrl).toBe('http://localhost:5002');
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
        ok: url === 'http://localhost:5004/api/health/live',
      })),
    );

    expect(isTauriReleaseBuild()).toBe(false);
    const port = await probeHealthyHubApiPort();
    expect(port).toBe(5004);
    expect(invoke).not.toHaveBeenCalled();
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
