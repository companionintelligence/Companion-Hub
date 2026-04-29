import { describe, expect, it, vi, beforeEach } from 'vitest';
import { register } from '../src/index';
import type { OpenClawPluginApi, PluginConfig } from '../src/types';

function createMockApi(): OpenClawPluginApi {
  return {
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    wake: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe('CI-Hub Plugin', () => {
  let api: OpenClawPluginApi;
  const baseConfig: PluginConfig = {
    hubUrl: 'http://localhost:5002',
    hubApiKey: 'test-key',
  };

  beforeEach(() => {
    api = createMockApi();
    vi.restoreAllMocks();
  });

  it('should export a register function', () => {
    expect(typeof register).toBe('function');
  });

  it('should register wake HTTP route on /hooks/hub-wake', async () => {
    // Mock fetch to simulate Hub health check + MCP init
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) }));

    await register(api, baseConfig);

    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/hooks/hub-wake',
      }),
    );
  });

  it('should log warning when Hub is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await register(api, baseConfig);

    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('Hub unreachable'));
  });

  it('should register tools from MCP server', async () => {
    const mockTools = [
      { name: 'hub_list_apps', description: 'List apps', inputSchema: { type: 'object' } },
      { name: 'hub_start_app', description: 'Start an app', inputSchema: { type: 'object' } },
    ];

    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/health')) return { ok: true };
        callCount++;
        if (callCount === 1) {
          // initialize
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
        }
        // tools/list
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 2, result: { tools: mockTools } }) };
      }),
    );

    await register(api, baseConfig);

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_list_apps' }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_start_app' }));
  });

  it('should handle MCP connection failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    // Should not throw
    await register(api, baseConfig);

    expect(api.log.warn).toHaveBeenCalled();
  });
});
