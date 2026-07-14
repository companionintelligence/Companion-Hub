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

// BUG-MCP-1: the plugin's MCP client now speaks Streamable HTTP (single /api/mcp endpoint, a session
// id issued at initialize, JSON or SSE responses). These helpers mock that transport shape:
// responses expose headers.get() + text() (not json()), and initialize issues an Mcp-Session-Id.

/** Wrap a JSON-RPC result in a Streamable HTTP-style response (headers.get + text). */
function mcpRes(result: unknown, sessionId?: string) {
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  if (sessionId) headers.set('mcp-session-id', sessionId);
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
  };
}

/** A benign default inference status so autoConfigure runs cleanly when a test doesn't care about it. */
const EMPTY_STATUS = { hardwareTier: 'high', models: [], backends: [], memoryBudget: {}, cloudProviders: [] };

/** Route an /api/mcp POST by JSON-RPC method (initialize issues a session). Returns null for non-MCP URLs. */
function mcpRoute(url: string, init: RequestInit | undefined, opts: { tools?: unknown[]; onCall?: (name?: string) => unknown } = {}) {
  if (!url.includes('/api/mcp')) return null;
  const body = init?.body ? (JSON.parse(String(init.body)) as { method: string; params?: { name?: string } }) : { method: '' };
  if (body.method === 'initialize') return mcpRes({ serverInfo: { name: 'ci-hub' } }, 'sess-1');
  if (body.method === 'tools/list') return mcpRes({ tools: opts.tools ?? [] });
  if (body.method === 'tools/call') {
    // The real Hub wraps tools/call results via formatToolSuccess: {content:[{type:'text',text:JSON}]}.
    // Emit that exact envelope so the plugin's content-unwrap path is genuinely exercised.
    const payload = opts.onCall ? opts.onCall(body.params?.name) : EMPTY_STATUS;
    return mcpRes({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  }
  return mcpRes({});
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
    delete process.env.HUB_MCP_LEGACY_CLIENT;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.HUB_URL;
    delete process.env.HUB_API_KEY;
    delete process.env.HUB_MCP_API_KEY;
    delete process.env.HUB_WAKE_SECRET;
    delete process.env.HUB_MCP_LEGACY_CLIENT;
    delete process.env.CI_LLM_NUM_CTX;
    delete process.env.OLLAMA_HOST;
  });

  it('should export a register function', () => {
    expect(typeof register).toBe('function');
  });

  it('should register wake HTTP route on /hooks/hub-wake when a wake secret is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/health')) return { ok: true };
        const mcp = mcpRoute(url, init);
        if (mcp) return mcp;
        return { ok: true, json: async () => ({}) };
      }),
    );

    await register(api, { ...baseConfig, wakeSecret: 'test-wake-secret' });

    expect(api.registerHttpRoute).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/hooks/hub-wake' }));
  });

  it('does NOT register the wake route when no wake secret is set (avoids an unauthenticated trigger)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/health')) return { ok: true };
        const mcp = mcpRoute(url, init);
        if (mcp) return mcp;
        return { ok: true, json: async () => ({}) };
      }),
    );

    await register(api, baseConfig); // no wakeSecret in config or env

    expect(api.registerHttpRoute).not.toHaveBeenCalled();
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('wake endpoint disabled'));
  });

  it('should log warning when Hub is unreachable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await register(api, baseConfig);

    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('Hub unreachable'));
  });

  it('does NOT register tools by default (tools come from native mcp.servers.ci-hub config)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/health')) return { ok: true };
        const mcp = mcpRoute(url, init, { tools: [{ name: 'hub_list_apps', description: 'x', inputSchema: {} }] });
        if (mcp) return mcp;
        return { ok: true, json: async () => ({}) };
      }),
    );

    await register(api, baseConfig);

    // Native OpenClaw MCP client owns tool registration now; the plugin must not.
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('native OpenClaw mcp.servers.ci-hub'));
  });

  it('registers tools via the legacy in-plugin client when HUB_MCP_LEGACY_CLIENT=true', async () => {
    process.env.HUB_MCP_LEGACY_CLIENT = 'true';
    const mockTools = [
      { name: 'hub_list_apps', description: 'List apps', inputSchema: { type: 'object' } },
      { name: 'hub_start_app', description: 'Start an app', inputSchema: { type: 'object' } },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/health')) return { ok: true };
        const mcp = mcpRoute(url, init, { tools: mockTools });
        if (mcp) return mcp;
        return { ok: true, json: async () => ({}) };
      }),
    );

    await register(api, baseConfig);

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_list_apps' }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'hub_start_app' }));
  });

  it('should handle MCP connection failure gracefully', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    // Should not throw
    await register(api, baseConfig);

    expect(api.log.warn).toHaveBeenCalled();
  });

  it('registers the ci-hub provider with real Ollama model ids', async () => {
    const status = {
      hardwareTier: 'high',
      backends: [],
      memoryBudget: {},
      cloudProviders: [],
      models: [
        { id: 'catalog-model-id', object: 'model', owned_by: 'local:ollama', state: 'pinned', backend: 'ollama', modality: ['text'], local: true },
      ],
    };
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/health')) return { ok: true };
      const mcp = mcpRoute(url, init, { onCall: (name) => (name === 'hub_get_inference_status' ? status : {}) });
      if (mcp) return mcp;
      if (url === 'http://ci-hub-ollama:11434/api/tags') return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
      return { ok: true, json: async () => ({}) };
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
    expect(catalog.provider.models).toEqual([expect.objectContaining({ id: 'qwen3:8b', name: 'qwen3:8b', contextWindow: 32768, maxTokens: 8192 })]);
    expect(catalog.provider.models.find((model) => model.id === 'auto')).toBeUndefined();
  });

  it('applies the Hub hardware-aware context window (CI_LLM_NUM_CTX) to registered models', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/health')) return { ok: true };
      const mcp = mcpRoute(url, init, { onCall: (name) => (name === 'hub_get_inference_status' ? EMPTY_STATUS : {}) });
      if (mcp) return mcp;
      if (url === 'http://ci-hub-ollama:11434/api/tags') return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    process.env.OLLAMA_HOST = 'http://ci-hub-ollama:11434';
    process.env.CI_LLM_NUM_CTX = '16384';

    await register(api, baseConfig);

    const provider = vi.mocked(api.registerProvider).mock.calls[0]?.[0];
    const catalog = await provider.catalog.run({});
    expect(catalog.provider.models).toEqual([expect.objectContaining({ id: 'qwen3:8b', contextWindow: 16384, params: { num_ctx: 16384 } })]);
  });

  it('caps CI_LLM_NUM_CTX by each model context_window when the model window is smaller', async () => {
    const status = {
      hardwareTier: 'high',
      backends: [],
      memoryBudget: {},
      cloudProviders: [],
      models: [{ id: 'tiny:4k', local: true, modality: ['text'], state: 'pulled', context_window: 4096, max_tokens: 2048 }],
    };
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/health')) return { ok: true };
      const mcp = mcpRoute(url, init, { onCall: (name) => (name === 'hub_get_inference_status' ? status : {}) });
      if (mcp) return mcp;
      // Empty /api/tags -> plugin falls back to Hub inference status, which carries context_window.
      if (url === 'http://ci-hub-ollama:11434/api/tags') return { ok: true, json: async () => ({ models: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    process.env.OLLAMA_HOST = 'http://ci-hub-ollama:11434';
    process.env.CI_LLM_NUM_CTX = '16384';

    await register(api, baseConfig);

    const provider = vi.mocked(api.registerProvider).mock.calls[0]?.[0];
    const catalog = await provider.catalog.run({});
    expect(catalog.provider.models).toEqual([expect.objectContaining({ id: 'tiny:4k', contextWindow: 4096, params: { num_ctx: 4096 } })]);
  });

  describe('R-PLG: Env var fallback', () => {
    it('R-PLG-1: should fall back to HUB_URL env var when config.hubUrl is not provided', async () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'env-api-key';

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          if (url.includes('/api/health')) return { ok: true };
          const mcp = mcpRoute(url, init);
          if (mcp) return mcp;
          return { ok: true, json: async () => ({}) };
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
        vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          if (url.includes('/api/health')) return { ok: true };
          const mcp = mcpRoute(url, init);
          if (mcp) return mcp;
          return { ok: true, json: async () => ({}) };
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
        if (url.includes('/api/mcp')) {
          // Verify the MCP endpoint gets the MCP-specific key.
          expect(init?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer mcp-specific-key' }));
          return mcpRoute(url, init);
        }
        return { ok: true, json: async () => ({}) };
      });
      vi.stubGlobal('fetch', fetchSpy);

      await register(api, {});

      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('ci-os-hub:3000'));
    });

    it('R-PLG-1: should fall back to HUB_API_KEY when HUB_MCP_API_KEY is not set', async () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'fallback-api-key';

      const mockTools = [{ name: 'hub_test', description: 'Test', inputSchema: { type: 'object' } }];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          if (url.includes('/api/health')) return { ok: true };
          const mcp = mcpRoute(url, init, { tools: mockTools });
          if (mcp) return mcp;
          return { ok: true, json: async () => ({}) };
        }),
      );

      await register(api, {});

      // Should not log the "requires hubUrl and mcpApiKey" error — HUB_API_KEY is accepted as fallback
      expect(api.log.error).not.toHaveBeenCalledWith(expect.stringContaining('requires hubUrl'));
    });
  });
});
