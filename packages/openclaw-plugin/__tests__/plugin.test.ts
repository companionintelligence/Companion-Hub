import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { register, withSafeLogger } from '../src/index';
import type { OpenClawPluginApi, PluginConfig } from '../src/types';

/**
 * A mock host api. It intentionally exposes `registerProvider` / `registerSpeechProvider`
 * even though this plugin's OpenClawPluginApi no longer declares them: the REAL OpenClaw host
 * offers them, and several regression tests below prove the plugin NEVER calls them.
 * Registering a `ci-hub` provider through the plugin API resolved its transport against
 * OpenClaw's api-provider registry (no `ollama` implementation) and took chat down with
 * "No API provider registered for api: ollama" — the whole point of CI-Hub#895.
 */
type MockApi = OpenClawPluginApi & {
  registerProvider: ReturnType<typeof vi.fn>;
  registerSpeechProvider: ReturnType<typeof vi.fn>;
};

function createMockApi(): MockApi {
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
  } as MockApi;
}

/** A fetch mock that answers the health probe and nothing else — the plugin makes no other calls. */
function healthOnlyFetch() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('/api/health')) return { ok: true };
    return { ok: true, json: async () => ({}) };
  });
}

describe('CI-Hub Plugin', () => {
  let api: MockApi;
  const baseConfig: PluginConfig = {
    hubUrl: 'http://localhost:5002',
    hubApiKey: 'test-key',
  };

  const clearEnv = () => {
    delete process.env.HUB_URL;
    delete process.env.HUB_API_KEY;
    delete process.env.HUB_MCP_API_KEY;
    delete process.env.HUB_WAKE_SECRET;
    delete process.env.HUB_MCP_LEGACY_CLIENT;
    delete process.env.CI_HUB_PLUGIN_INFERENCE;
  };

  beforeEach(() => {
    api = createMockApi();
    vi.restoreAllMocks();
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it('should export a register function', () => {
    expect(typeof register).toBe('function');
  });

  // The bug this guards: OpenClaw does not reliably supply api.log (its own plugins call
  // it as api.log?.info?.()), so `api.log.info(...)` throws. While register() was async
  // the loader swallowed that rejection, so the plugin silently did nothing.
  it('survives an api with no log (OpenClaw does not always provide one)', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());
    const apiWithoutLog = { ...createMockApi(), log: undefined } as unknown as OpenClawPluginApi;

    expect(() => register(apiWithoutLog, { ...baseConfig, wakeSecret: 's' })).not.toThrow();
    // and it still did its work, rather than bailing out early
    expect(apiWithoutLog.registerHttpRoute).toHaveBeenCalled();
  });

  // Pinned against the api OpenClaw ACTUALLY passes (verified against openclaw@2026.6.11's
  // buildPluginApi): a plain object literal exposing `logger`, and carrying members this
  // package's interface never declared (config, runtime, session, registerHook, …).
  // It has NO `log`. The plugin wrote to `api.log` for its whole life, so every line went
  // to the console fallback and never reached the gateway's plugin logger.
  it('logs through the host logger — OpenClaw calls it `logger`, not `log`', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const hostApi = {
      id: 'ci-hub',
      logger, // <- the real member name; there is no `log`
      config: { some: 'openclaw config' },
      registerHook: vi.fn(),
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
    } as unknown as OpenClawPluginApi;

    register(hostApi, { ...baseConfig, wakeSecret: 's' });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('CI-Hub plugin initializing'));
  });

  // The wrapper must not rebuild the api from the subset of members this package happens to
  // declare — the host's real surface is much larger, and anything dropped becomes
  // `undefined` for every downstream consumer.
  it('does not hide host api members that our interface never declared', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());
    const registerHook = vi.fn();
    const hostApi = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: { model: 'gemma4:e2b' },
      registerHook,
      registerTool: vi.fn(),
      registerHttpRoute: vi.fn(),
    } as unknown as OpenClawPluginApi;

    // This is the api register() hands to the wake handler and the SSE listener; anything
    // the host exposed must still be reachable through it.
    const wrapped = withSafeLogger(hostApi) as unknown as Record<string, unknown>;

    expect(wrapped.config).toEqual({ model: 'gemma4:e2b' });
    expect(wrapped.registerHook).toBeTypeOf('function');
    (wrapped.registerHook as () => void)();
    expect(registerHook).toHaveBeenCalled();
  });

  // The bug this guards: OpenClaw's loader throws "plugin register must be synchronous"
  // if register() returns a promise, so an async register never loads the plugin AT ALL
  // — no wake route, and the CLI refuses to start. It is a one-word regression (`async`)
  // with no other symptom, so pin the contract directly.
  it('register() MUST return synchronously — OpenClaw rejects a promise-returning register', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());

    const result = register(api, { ...baseConfig, wakeSecret: 'test-wake-secret' }) as unknown;

    expect(result).toBeUndefined();
    expect(result).not.toBeInstanceOf(Promise);
    // Everything that registers must have done so before register() returned, because
    // the plugin API is closed at that point and later register* calls are no-ops.
    expect(api.registerHttpRoute).toHaveBeenCalled();
  });

  it('should register wake HTTP route on /hooks/hub-wake when a wake secret is set', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());

    register(api, { ...baseConfig, wakeSecret: 'test-wake-secret' });

    expect(api.registerHttpRoute).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/hooks/hub-wake' }));
  });

  it('does NOT register the wake route when no wake secret is set (avoids an unauthenticated trigger)', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());

    register(api, baseConfig); // no wakeSecret in config or env

    expect(api.registerHttpRoute).not.toHaveBeenCalled();
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('wake endpoint disabled'));
  });

  it('should log warning when Hub is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    register(api, baseConfig);

    // register() is synchronous by contract, so the health probe resolves after it
    // returns — the warning is emitted on a later tick rather than inline.
    await vi.waitFor(() => {
      expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('Hub unreachable'));
    });
  });

  it('does NOT register tools (tools come from the native mcp.servers.ci-hub config)', () => {
    vi.stubGlobal('fetch', healthOnlyFetch());

    register(api, baseConfig);

    // Native OpenClaw MCP client owns tool registration now; the plugin must not.
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('native OpenClaw mcp.servers.ci-hub'));
  });

  it('refuses the legacy in-plugin tool client (HUB_MCP_LEGACY_CLIENT=true) instead of silently dropping tools', () => {
    process.env.HUB_MCP_LEGACY_CLIENT = 'true';
    vi.stubGlobal('fetch', healthOnlyFetch());

    register(api, baseConfig);

    // Registering tools requires awaiting tools/list, and OpenClaw closes the plugin
    // API when register() returns — a late registerTool() is silently discarded. So the
    // path cannot be honoured, and we must say so rather than appear to work.
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.log.error).toHaveBeenCalledWith(expect.stringContaining('HUB_MCP_LEGACY_CLIENT=true is no longer supported'));
  });

  // Guards the regression that broke chat on the appliance: a plugin-registered provider
  // with api "ollama" has no api-provider implementation to resolve against, so the first
  // LLM call dies with "No API provider registered for api: ollama". The working provider
  // comes from openclaw.json (config-reconcile), so the plugin must NEVER register one —
  // not even behind the old CI_HUB_PLUGIN_INFERENCE flag, which is now inert. (CI-Hub#895)
  it('NEVER registers an LLM or speech provider, even with the legacy CI_HUB_PLUGIN_INFERENCE=1 flag set', () => {
    process.env.CI_HUB_PLUGIN_INFERENCE = '1'; // the removed opt-in — must be a no-op now
    vi.stubGlobal('fetch', healthOnlyFetch());

    register(api, { ...baseConfig, wakeSecret: 'test-wake-secret' });

    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.registerSpeechProvider).not.toHaveBeenCalled();
    expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('registers no LLM or speech provider'));
  });

  // The plugin's only authenticated MCP session ever existed to feed inference discovery.
  // With inference removed there is nothing to discover, so the plugin must open no MCP
  // session at all — not even a background one — regardless of the legacy flag. (CI-Hub#895)
  it('NEVER opens an MCP session (/api/mcp), even with CI_HUB_PLUGIN_INFERENCE=1', async () => {
    process.env.CI_HUB_PLUGIN_INFERENCE = '1';
    const fetchMock = healthOnlyFetch();
    vi.stubGlobal('fetch', fetchMock);

    register(api, { ...baseConfig, wakeSecret: 'test-wake-secret' });

    // Let the background health probe settle, so any MCP connect would have fired too.
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/health'), expect.anything());
    });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/mcp'), expect.anything());
  });

  describe('R-PLG: Env var fallback', () => {
    it('R-PLG-1: should fall back to HUB_URL env var when config.hubUrl is not provided', () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'env-api-key';
      vi.stubGlobal('fetch', healthOnlyFetch());

      register(api, {});

      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('ci-os-hub:3000'));
    });

    it('R-PLG-1: should prefer config values over env vars', () => {
      process.env.HUB_URL = 'http://env-hub:3000';
      process.env.HUB_API_KEY = 'env-key';
      vi.stubGlobal('fetch', healthOnlyFetch());

      register(api, baseConfig);

      // Should use config.hubUrl, not env
      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('localhost:5002'));
    });

    it('R-PLG-1: should log error and return when neither config nor env provides hubUrl', () => {
      register(api, {});

      expect(api.log.error).toHaveBeenCalledWith(expect.stringContaining('requires hubUrl and mcpApiKey'));
      expect(api.registerHttpRoute).not.toHaveBeenCalled();
    });

    it('R-PLG-1: should accept HUB_MCP_API_KEY as the required key (no HUB_API_KEY needed)', () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_MCP_API_KEY = 'mcp-specific-key';
      vi.stubGlobal('fetch', healthOnlyFetch());

      register(api, {});

      // HUB_MCP_API_KEY satisfies mcpApiKey, so the plugin initializes rather than erroring out.
      expect(api.log.error).not.toHaveBeenCalledWith(expect.stringContaining('requires hubUrl'));
      expect(api.log.info).toHaveBeenCalledWith(expect.stringContaining('ci-os-hub:3000'));
    });

    it('R-PLG-1: should fall back to HUB_API_KEY when HUB_MCP_API_KEY is not set', () => {
      process.env.HUB_URL = 'http://ci-os-hub:3000';
      process.env.HUB_API_KEY = 'fallback-api-key';
      vi.stubGlobal('fetch', healthOnlyFetch());

      register(api, {});

      // Should not log the "requires hubUrl and mcpApiKey" error — HUB_API_KEY is accepted as fallback
      expect(api.log.error).not.toHaveBeenCalledWith(expect.stringContaining('requires hubUrl'));
    });
  });
});
