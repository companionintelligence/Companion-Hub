import type { OpenClawPluginApi, PluginConfig, PluginLogger } from './types';
import { fetchWithTimeout } from './http';
import { createWakeEndpointHandler } from './wake-endpoint';
import { SseListenerService } from './sse-listener';

/**
 * OpenClaw plugin entry point — MUST be synchronous.
 *
 * OpenClaw's loader calls register() and throws "plugin register must be synchronous"
 * if it returns a promise, so an `async register` never loads at all. It also *closes*
 * the plugin API the moment register() returns: after that, every register* call is a
 * silent no-op (only emitAgentEvent, sendSessionAttachment, scheduleSessionTurn and
 * unscheduleSessionTurnsByTag stay callable). So deferring a registration into a
 * `.then()` does not work either — it would appear to succeed and quietly do nothing.
 *
 * Everything that registers therefore happens here, synchronously. Every call that
 * needs the network is deferred into a background probe that only mutates state a sync
 * callback reads.
 */
export function register(rawApi: OpenClawPluginApi, config: PluginConfig): void {
  // OpenClaw does not reliably provide api.log — its own bundled plugins all call it
  // defensively (`api.log?.info?.()`), and on the appliance it is undefined, so a bare
  // api.log.info() throws. That throw used to be invisible: an async register()'s
  // rejection was swallowed by the loader, so the plugin just "didn't work". Normalize
  // once, here, and hand every consumer an api whose log always works.
  const api = withSafeLogger(rawApi);

  // Fall back to env vars for zero-config when running inside CI-Hub (R-PLG-1)
  const hubUrl = config.hubUrl || process.env.HUB_URL;
  const hubApiKey = config.hubApiKey || process.env.HUB_API_KEY;
  // The SSE/MCP key (separate from the REST API key, R-PLG-1). Consumed ONLY by the SSE
  // listener below — the wake webhook authenticates with wakeSecret, so this key does not
  // gate plugin startup.
  const mcpApiKey = config.mcpApiKey || process.env.HUB_MCP_API_KEY || hubApiKey;
  const wakeSecret = config.wakeSecret || process.env.HUB_WAKE_SECRET;

  // hubUrl is the only hard requirement: it backs the health probe and is the base URL for
  // every Hub call. Do NOT also require mcpApiKey here — the wake webhook (wakeSecret) and
  // health probe (hubUrl) need no key, and requiring one would refuse to mount the wake
  // endpoint on a wake-only / MCP-disabled Hub. mcpApiKey is checked where it is used (SSE).
  if (!hubUrl) {
    api.log.error('CI-Hub plugin requires hubUrl (via config.hubUrl or the HUB_URL env var)');
    return;
  }

  api.log.info(`CI-Hub plugin initializing (hub: ${hubUrl})`);

  // Wake webhook — only when a wake secret is set. The handler enforces the Bearer
  // check ONLY when a secret is present, so mounting the route without one would
  // expose an unauthenticated agent-wake trigger.
  if (wakeSecret) {
    api.registerHttpRoute({
      method: 'POST',
      path: '/hooks/hub-wake',
      handler: createWakeEndpointHandler(api, wakeSecret, config.wakeFilter),
    });
    api.log.info('Registered wake endpoint: POST /hooks/hub-wake');
  } else {
    api.log.warn('HUB_WAKE_SECRET not set — wake endpoint disabled (would be unauthenticated otherwise)');
  }

  if (process.env.HUB_MCP_LEGACY_CLIENT === 'true') {
    // This rollback path registered tools after awaiting tools/list. Under the
    // synchronous-register contract a late registerTool() is silently dropped, so the
    // path cannot be honoured — say so rather than appear to work.
    api.log.error(
      'HUB_MCP_LEGACY_CLIENT=true is no longer supported: OpenClaw requires plugin register() to be synchronous, so tools cannot be registered after awaiting tools/list. Hub tools are served by the native mcp.servers.ci-hub entry in openclaw.json.',
    );
  } else {
    api.log.info('Hub MCP tools served via native OpenClaw mcp.servers.ci-hub config');
  }

  // Background work that registers nothing, and so is safe after register() returns.
  void probeHubHealth(api, hubUrl);

  if (config.sseEnabled) {
    // SSE is the only surface that needs the key — it authenticates the /sse/app stream with
    // a Bearer token. With a key, start it; without one it would send `Bearer undefined`, so
    // skip the listener (rather than start a doomed one) and say why.
    if (mcpApiKey) {
      const sseListener = new SseListenerService(hubUrl, mcpApiKey, api, config.wakeFilter);
      void sseListener.start().catch((error) => {
        api.log.warn(`SSE listener failed to start: ${describeError(error)}`);
      });
    } else {
      api.log.warn('SSE listener enabled but no API key is set (config.mcpApiKey / HUB_MCP_API_KEY / HUB_API_KEY) — SSE disabled');
    }
  }

  // This plugin intentionally does NOT register an inference/model provider (CI-Hub#895).
  //
  // A provider registered through the plugin API (api.registerProvider) resolves its
  // transport against OpenClaw's api-provider registry, whose built-ins are
  // anthropic-messages / openai-completions / … — there is no `ollama` implementation. So a
  // plugin-registered `ci-hub` provider with `api: "ollama"` makes the first LLM call die
  // with "No API provider registered for api: ollama", taking chat down. (A config-declared
  // provider in openclaw.json resolves `ollama` fine, via a separate provider-runtime-plugin
  // path the plugin API never reaches — hence the asymmetry.)
  //
  // On a CI appliance the working `models.providers.ci-hub` (native Ollama transport, live
  // model discovery, default-model selection) is written to openclaw.json by CI-OpenClaw's
  // config-reconcile — the single source of truth. A plugin registration here would be both
  // redundant AND an override hazard: two writers of the same `ci-hub` id, the exact
  // condition that broke chat. Do not reintroduce api.registerProvider/registerSpeechProvider.
  api.log.info(
    'ci-hub chat models come from openclaw.json (models.providers.ci-hub, written by config-reconcile); this plugin registers no LLM or speech provider — see CI-Hub#895',
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A logger that always works.
 *
 * OpenClaw names this member `logger`, not `log` — verified against openclaw@2026.6.11,
 * whose plugin api is `{ ..., logger: PluginLogger, ... }` with no `log` at all. This
 * package's own interface has always said `log`, so every line the plugin ever wrote went
 * to the console fallback instead of the gateway's plugin logger. Prefer the real member,
 * accept `log` for hosts (and tests) that supply it, and only then fall back to console.
 */
function createSafeLogger(api: OpenClawPluginApi): PluginLogger {
  const fallbacks: Record<keyof PluginLogger, (message: string) => void> = {
    info: (message) => console.info(`[ci-hub] ${message}`),
    warn: (message) => console.warn(`[ci-hub] ${message}`),
    error: (message) => console.error(`[ci-hub] ${message}`),
    debug: (message) => console.info(`[ci-hub] ${message}`),
  };

  const emit =
    (level: keyof PluginLogger) =>
    (message: string): void => {
      // Resolved per call, not snapshotted: a logger the host attaches after register()
      // would otherwise be ignored for the life of the plugin.
      const host = api as { logger?: Partial<PluginLogger>; log?: Partial<PluginLogger> };
      for (const candidate of [host.logger, host.log]) {
        const hostFn = candidate?.[level];
        if (typeof hostFn === 'function') {
          hostFn.call(candidate, message);
          return;
        }
      }
      fallbacks[level](message);
    };

  return { info: emit('info'), warn: emit('warn'), error: emit('error'), debug: emit('debug') };
}

/**
 * Give downstream code an api whose `log` always works, without hiding the rest of it.
 *
 * `Object.create(api)` rather than a copy or a Proxy:
 *   - Not a hand-listed copy. OpenClaw's real api carries far more than this package's
 *     interface declares (config, pluginConfig, runtime, session, agent, runContext,
 *     lifecycle, registerHook, registerChannel, registerGatewayMethod, …). Rebuilding it
 *     from a subset silently drops every member we did not think to name, which is how a
 *     wrapper turns into an outage the first time some consumer reaches for one.
 *   - Not a Proxy. A Proxy's [[Get]] trap may not report a substitute for a non-writable,
 *     non-configurable own data property, so overriding `log` on a frozen host throws on
 *     first access.
 *
 * A prototype delegate has neither problem: every member resolves through to the host, and
 * an own `log` shadows it. OpenClaw builds its api as a plain object literal (buildPluginApi),
 * so `this` binding through the delegate is safe.
 */
export function withSafeLogger(api: OpenClawPluginApi): OpenClawPluginApi {
  const wrapped = Object.create(api) as OpenClawPluginApi;
  Object.defineProperty(wrapped, 'log', {
    value: createSafeLogger(api),
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}

/** Hub reachability is advisory only — it gates nothing, so it can resolve late. */
async function probeHubHealth(api: OpenClawPluginApi, hubUrl: string): Promise<void> {
  try {
    const healthResponse = await fetchWithTimeout(`${hubUrl.replace(/\/$/, '')}/api/health`, {});
    if (!healthResponse.ok) {
      api.log.warn(`Hub health check failed: ${healthResponse.status}`);
    }
  } catch (error) {
    api.log.warn(`Hub unreachable at ${hubUrl}: ${describeError(error)}`);
  }
}
