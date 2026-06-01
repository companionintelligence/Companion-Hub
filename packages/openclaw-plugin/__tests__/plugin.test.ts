import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { register } from '../src/index';
import type { OpenClawPluginApi, PluginConfig } from '../src/types';

function createMockApi(): OpenClawPluginApi {
  return {
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    wake: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

/** Create a ReadableStream that emits SSE data with the endpoint event */
function createSseStream(messagesUrl: string) {
  const data = `event: endpoint\ndata: ${messagesUrl}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
    },
  });
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
    delete process.env.HUB_URL;
    delete process.env.HUB_API_KEY;
    delete process.env.HUB_MCP_API_KEY;
    delete process.env.HUB_WAKE_SECRET;
  });

  afterEach(() => {
    delete process.env.HUB_URL;
    delete process.env.HUB_API_KEY;
    delete process.env.HUB_MCP_API_KEY;
    delete process.env.HUB_WAKE_SECRET;
  });

  it('should export a register function', () => {
    expect(typeof register).toBe('function');
  });

  it('should register wake HTTP route on /hooks/hub-wake', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/health')) return { ok: true };
        if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
      }),
    );

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

    let jsonRpcCallCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/health')) return { ok: true };
        if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
        jsonRpcCallCount++;
        if (jsonRpcCallCount === 1) {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
        }
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

  it('registers the ci-hub provider with real Ollama model ids', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/health')) return { ok: true };
      if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
      if (url === 'http://ci-hub-ollama:11434/api/tags') {
        return {
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen3:8b' }],
          }),
        };
      }
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.method === 'initialize') {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { serverInfo: {} } }) };
      }
      if (body?.method === 'tools/list') {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }) };
      }
      if (body?.method === 'tools/call' && body?.params?.name === 'hub_get_inference_status') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              hardwareTier: 'high',
              backends: [],
              memoryBudget: {},
              cloudProviders: [],
              models: [
                {
                  id: 'catalog-model-id',
                  object: 'model',
                  owned_by: 'local:ollama',
                  state: 'pinned',
                  backend: 'ollama',
                  modality: ['text'],
                  local: true,
                },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body?.id ?? 1, result: {} }) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    process.env.OLLAMA_HOST = 'http://ci-hub-ollama:11434';

    await register(api, baseConfig);

    expect(api.registerProvider).toHaveBeenCalledTimes(1);
    const provider = vi.mocked(api.registerProvider).mock.calls[0]?.[0];
    expect(provider?.id).toBe('ci-hub');
    expect(provider).toBeDefined();

    const catalog = await provider.catalog.run({});
    expect(catalog.provider.baseUrl).toBe('http://ci-hub-ollama:11434');
    expect(catalog.provider.api).toBe('ollama');
    expect(catalog.provider.models).toEqual([
      expect.objectContaining({
        id: 'qwen3:8b',
        name: 'qwen3:8b',
        contextWindow: 32768,
        maxTokens: 8192,
      }),
    ]);
    expect(catalog.provider.models.find((model) => model.id === 'auto')).toBeUndefined();
  });

  describe('R-PLG: Env var fallback', () => {
    it('R-PLG-1: should fall back to HUB_URL env var when config.hubUrl is not provided', async () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'env-api-key';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/health')) return { ok: true };
          if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://ci-os-hub:3000/api/mcp/messages') };
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
        }),
      );

      await register(api, {});

      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('ci-os-hub:3000'));
    });

    it('R-PLG-1: should prefer config values over env vars', async () => {
      process.env.HUB_URL = 'http://env-hub:3000';
      process.env.HUB_API_KEY = 'env-key';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/health')) return { ok: true };
          if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://localhost:5002/api/mcp/messages') };
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
        }),
      );

      await register(api, baseConfig);

      // Should use config.hubUrl, not env
      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('localhost:5002'));
    });

    it('R-PLG-1: should log error and return when neither config nor env provides hubUrl', async () => {
      await register(api, {});

      expect(api.log.error).toHaveBeenCalledWith(expect.stringContaining('requires hubUrl and mcpApiKey'));
      expect(api.registerHttpRoute).not.toHaveBeenCalled();
    });

    it('R-PLG-1: should use HUB_MCP_API_KEY env var for MCP authentication', async () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_MCP_API_KEY = 'mcp-specific-key';

      const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/health')) return { ok: true };
        if (url.includes('/api/mcp/sse')) {
          // Verify MCP endpoint gets the MCP-specific key
          expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer mcp-specific-key' }));
          return { ok: true, body: createSseStream('http://ci-os-hub:3000/api/mcp/messages') };
        }
        return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
      });
      vi.stubGlobal('fetch', fetchSpy);

      await register(api, {});

      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('ci-os-hub:3000'));
    });

    it('R-PLG-1: should fall back to HUB_API_KEY when HUB_MCP_API_KEY is not set', async () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'fallback-api-key';

      const mockTools = [{ name: 'hub_test', description: 'Test', inputSchema: { type: 'object' } }];
      let jsonRpcCallCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/health')) return { ok: true };
          if (url.includes('/api/mcp/sse')) return { ok: true, body: createSseStream('http://ci-os-hub:3000/api/mcp/messages') };
          jsonRpcCallCount++;
          if (jsonRpcCallCount === 1) {
            return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }) };
          }
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 2, result: { tools: mockTools } }) };
        }),
      );

      await register(api, {});

      // Should not log the "requires hubUrl and mcpApiKey" error — HUB_API_KEY is accepted as fallback
      expect(api.log.error).not.toHaveBeenCalledWith(expect.stringContaining('requires hubUrl'));
    });
  });
});
