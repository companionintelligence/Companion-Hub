import type { OpenClawPluginApi, PluginConfig, HubInferenceStatus, OpenClawModelEntry, PluginLogger } from './types';
import { fetchWithTimeout, McpClient } from './mcp-client';
import { createWakeEndpointHandler } from './wake-endpoint';
import { SseListenerService } from './sse-listener';

/**
 * Unwrap a Hub MCP tools/call result into its raw payload. The Hub wraps every tool result via
 * formatToolSuccess as `{ content: [{ type: 'text', text: JSON.stringify(payload) }], isError? }`,
 * so a caller that needs the domain object must parse content[0].text. Returns null on an error
 * result or an unparseable body (callers then fall back, e.g. to the REST inference endpoint).
 */
function unwrapToolResult<T>(result: unknown): T | null {
  const wrapped = result as { content?: Array<{ text?: string }>; isError?: boolean } | null | undefined;
  if (!wrapped || wrapped.isError) {
    return null;
  }
  const text = wrapped.content?.[0]?.text;
  if (typeof text !== 'string') {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

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
 * needs the network is deferred into the lazily-invoked catalog.run(), or into a
 * background probe that only mutates state a sync callback reads.
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
  // MCP endpoint uses a separate key from the REST API (R-PLG-1)
  const mcpApiKey = config.mcpApiKey || process.env.HUB_MCP_API_KEY || hubApiKey;
  const wakeSecret = config.wakeSecret || process.env.HUB_WAKE_SECRET;

  if (!hubUrl || !mcpApiKey) {
    api.log.error('CI-Hub plugin requires hubUrl and mcpApiKey (via config or HUB_URL/HUB_MCP_API_KEY env vars)');
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

  // The in-plugin MCP client exists only for the plugin's OWN authenticated Hub calls
  // (hub_get_inference_status); agent-facing tools come from OpenClaw's native
  // mcp.servers.ci-hub entry. register() cannot await, so connect in the background
  // and hand the pending handle to whoever needs the client.
  const mcpClient = new McpClient(hubUrl, mcpApiKey, api.log);
  const mcpReady = mcpClient.connect().catch((error) => {
    api.log.warn(`Hub MCP client failed to connect: ${describeError(error)}`);
  });

  if (process.env.HUB_MCP_LEGACY_CLIENT === 'true') {
    // This rollback path registered tools after awaiting tools/list. Under the
    // synchronous-register contract a late registerTool() is silently dropped, so the
    // path cannot be honoured — say so rather than appear to work.
    api.log.error(
      'HUB_MCP_LEGACY_CLIENT=true is no longer supported: OpenClaw requires plugin register() to be synchronous, so tools cannot be registered after awaiting tools/list. Hub tools are served by the native mcp.servers.ci-hub entry in openclaw.json.',
    );
  } else {
    api.log.info('Hub MCP tools served via native OpenClaw mcp.servers.ci-hub config; in-plugin client used only for inference discovery');
  }

  // Background work that registers nothing, and so is safe after register() returns.
  void probeHubHealth(api, hubUrl);

  if (config.sseEnabled) {
    const sseListener = new SseListenerService(hubUrl, mcpApiKey, api, config.wakeFilter);
    void sseListener.start().catch((error) => {
      api.log.warn(`SSE listener failed to start: ${describeError(error)}`);
    });
  }

  // Inference auto-config (OC-1) is OFF unless explicitly asked for.
  //
  // It registers a "ci-hub" provider whose transport is `api: "ollama"`. OpenClaw
  // resolves that fine for a provider declared in openclaw.json, but a provider
  // registered through the plugin API resolves against the api-provider registry,
  // where "ollama" has no implementation — the first LLM call then dies with
  // "No API provider registered for api: ollama", taking chat down with it.
  //
  // This never surfaced because the plugin could not load at all (its register() was
  // async), so the path is unproven. On a CI appliance it is also redundant:
  // CI-OpenClaw's server.cjs already writes models.providers.ci-hub into
  // openclaw.json, which is the definition that actually works. Keep the code, keep it
  // opt-in, and do not let a broken registration break the agent by default.
  if (process.env.CI_HUB_PLUGIN_INFERENCE === '1') {
    registerInference({ api, hubUrl, apiKey: mcpApiKey, mcpClient, mcpReady });
  } else {
    api.log.info('Inference auto-config disabled (set CI_HUB_PLUGIN_INFERENCE=1 to enable); the ci-hub provider comes from openclaw.json');
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap the api so `log` is always callable, falling back to the console when the host
 * omits it (or omits individual levels). Proxied rather than copied so the loader's own
 * guarded-api semantics — every other method still routes to OpenClaw — are preserved.
 */
function withSafeLogger(api: OpenClawPluginApi): OpenClawPluginApi {
  const host = (api as { log?: Partial<PluginLogger> }).log;

  // Where a level goes when the host supplies no logger. OpenClaw pipes the plugin's
  // stdout/stderr into the gateway log, so this stays visible rather than vanishing.
  const fallbacks: Record<keyof PluginLogger, (message: string) => void> = {
    info: (message) => console.info(`[ci-hub] ${message}`),
    warn: (message) => console.warn(`[ci-hub] ${message}`),
    error: (message) => console.error(`[ci-hub] ${message}`),
    debug: (message) => console.info(`[ci-hub] ${message}`),
  };

  const emit =
    (level: keyof PluginLogger) =>
    (message: string): void => {
      const hostFn = host?.[level];
      if (typeof hostFn === 'function') {
        hostFn.call(host, message);
        return;
      }
      fallbacks[level](message);
    };

  const log: PluginLogger = {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
  };

  return new Proxy(api, {
    get: (target, prop, receiver) => (prop === 'log' ? log : Reflect.get(target, prop, receiver)),
  });
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

interface InferenceDeps {
  api: OpenClawPluginApi;
  hubUrl: string;
  apiKey: string;
  mcpClient: McpClient;
  mcpReady: Promise<unknown>;
}

/** TTS availability is only knowable after an async probe, but isConfigured() is a
 *  sync callback invoked later — so the probe fills this in after registration. */
interface TtsState {
  ready: boolean;
  modelId: string;
}

/**
 * Register the inference surfaces synchronously (OC-1).
 * S-OC-1.2: local models are exposed as the "ci-hub" provider.
 * S-OC-1.3: local models cost { input: 0, output: 0 }.
 * S-OC-3.1: TTS is exposed when Lemonade reports loaded TTS models.
 *
 * Discovery itself is lazy: catalog.run() is invoked by OpenClaw well after
 * registration, which is what lets register() stay synchronous without losing the
 * model catalog.
 */
function registerInference(deps: InferenceDeps): void {
  const { api, hubUrl, apiKey, mcpClient, mcpReady } = deps;
  const ollamaNativeUrl = (process.env.OLLAMA_HOST ?? 'http://ci-hub-ollama:11434').replace(/\/$/, '');

  // Fetched at most once; the model catalog and the TTS probe share the result.
  let statusPromise: Promise<HubInferenceStatus | null> | null = null;
  const getInferenceStatus = (): Promise<HubInferenceStatus | null> => {
    statusPromise ??= fetchInferenceStatus(api, hubUrl, mcpClient, mcpReady);
    return statusPromise;
  };

  const tts: TtsState = { ready: false, modelId: 'kokoro-v1' };

  if (api.registerProvider) {
    api.registerProvider({
      id: 'ci-hub',
      label: 'CI Hub (Local)',
      resolveSyntheticAuth: () => ({
        available: true,
        apiKey,
      }),
      catalog: {
        order: 'simple',
        run: async () => ({
          provider: {
            baseUrl: ollamaNativeUrl,
            apiKey: 'ollama',
            api: 'ollama',
            models: await discoverLocalModels(api, ollamaNativeUrl, getInferenceStatus),
          },
        }),
      },
    });
  }

  if (api.registerSpeechProvider) {
    // The Hub no longer proxies inference — point OpenClaw at the Ollama container's
    // own OpenAI-compatible /v1 directly (OLLAMA_HOST is injected into every
    // Hub-installed app).
    const inferenceBaseUrl = `${ollamaNativeUrl}/v1`;

    api.registerSpeechProvider({
      id: 'ci-hub',
      label: 'CI Hub TTS (Local)',
      // Reports false until the probe below confirms Lemonade has a loaded TTS model,
      // so OpenClaw will not select this provider before it can actually serve.
      isConfigured: () => tts.ready,
      synthesize: async (req) => {
        const response = await fetch(`${inferenceBaseUrl}/audio/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: tts.modelId,
            input: req.text,
            voice: req.voice ?? 'default',
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          api.log.error(`CI Hub TTS request failed (${response.status}): ${errorText.slice(0, 500)}`);
          throw new Error(`CI Hub TTS request failed: ${response.status} ${response.statusText}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        return {
          audioBuffer,
          outputFormat: 'mp3',
          fileExtension: '.mp3',
          voiceCompatible: true,
        };
      },
    });
  }

  void probeTtsAvailability(api, getInferenceStatus, tts);
}

/**
 * S-OC-1.1: discover inference capabilities via the authenticated MCP call
 * (hub_get_inference_status). The REST fallback only fires if that fails — and
 * /api/inference/status requires a Hub session the plugin lacks, so it typically
 * 401s; the MCP call is the plugin's working channel.
 */
async function fetchInferenceStatus(
  api: OpenClawPluginApi,
  hubUrl: string,
  mcpClient: McpClient,
  mcpReady: Promise<unknown>,
): Promise<HubInferenceStatus | null> {
  await mcpReady;

  let inferenceStatus: HubInferenceStatus | null = null;

  if (mcpClient.isConnected()) {
    try {
      // callTool returns the MCP content envelope; unwrap it to the raw HubInferenceStatus.
      // A null result (error/unparseable) falls through to the REST fallback below.
      inferenceStatus = unwrapToolResult<HubInferenceStatus>(await mcpClient.callTool('hub_get_inference_status', {}));
    } catch {
      api.log.debug('hub_get_inference_status not yet available — trying REST fallback');
    }
  }

  if (!inferenceStatus) {
    try {
      const response = await fetchWithTimeout(`${hubUrl.replace(/\/$/, '')}/api/inference/status`, {});
      if (response.ok) {
        inferenceStatus = (await response.json()) as HubInferenceStatus;
      }
    } catch {
      api.log.debug('Inference REST endpoint not available');
    }
  }

  if (!inferenceStatus) {
    api.log.info('Hub inference not available — skipping auto-configuration');
    return null;
  }

  api.log.info(`Hub inference detected: tier=${inferenceStatus.hardwareTier}, models=${inferenceStatus.models.length}`);

  // S-OC-2.1: If insufficient hardware, recommend cloud providers
  if (inferenceStatus.hardwareTier === 'insufficient') {
    api.log.warn(
      'Hub hardware does not support local inference. ' +
        'Configure a cloud provider in Hub Settings → AI → Cloud Providers. ' +
        'GitHub Copilot is recommended (includes Claude, GPT, and Gemini under one subscription).',
    );
  }

  // S-OC-2.2: If cloud credentials exist in Hub, log availability
  const configuredCloud = inferenceStatus.cloudProviders.filter((p) => p.configured);
  if (configuredCloud.length > 0) {
    api.log.info(`Hub has ${configuredCloud.length} cloud provider(s) configured as fallback`);
  }

  return inferenceStatus;
}

/**
 * Prefer direct Ollama discovery so OpenClaw always receives the native model IDs it
 * must pass to the native Ollama API surface; fall back to the Hub's inference status.
 */
async function discoverLocalModels(
  api: OpenClawPluginApi,
  ollamaNativeUrl: string,
  getInferenceStatus: () => Promise<HubInferenceStatus | null>,
): Promise<OpenClawModelEntry[]> {
  const isEmbeddingModel = (id: string) => /embed/i.test(id);
  let localModels = [] as Array<{ id: string; context_window?: number; max_tokens?: number }>;

  try {
    const response = await fetchWithTimeout(`${ollamaNativeUrl}/api/tags`, {});
    if (response.ok) {
      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      localModels = (payload.models ?? [])
        .filter((model): model is { name: string } => typeof model.name === 'string' && model.name.length > 0 && !isEmbeddingModel(model.name))
        .map((model) => ({
          id: model.name,
        }));
    }
  } catch {
    api.log.debug('Direct Ollama model discovery unavailable — falling back to Hub inference status');
  }

  if (localModels.length === 0) {
    const inferenceStatus = await getInferenceStatus();
    localModels = (inferenceStatus?.models ?? [])
      .filter((m) => m.local && m.modality.includes('text') && (m.state === 'pulled' || m.state === 'loaded' || m.state === 'pinned'))
      .map((m) => ({
        id: m.id,
        context_window: m.context_window,
        max_tokens: m.max_tokens,
      }))
      .filter((m) => m.id.includes(':'));
  }

  // Hardware-aware context window injected by the Hub (CI_LLM_NUM_CTX). Caps both the
  // agent's token budget and the native Ollama `num_ctx`, so OpenClaw doesn't pack to
  // Ollama's oversized memory-based default (e.g. 262144 on unified-memory APUs).
  const hubNumCtx = Number.parseInt(process.env.CI_LLM_NUM_CTX ?? '', 10);
  const numCtx = Number.isFinite(hubNumCtx) && hubNumCtx > 0 ? hubNumCtx : undefined;

  const models = localModels.map((m) => {
    // Never advertise / request more context than the model supports. CI_LLM_NUM_CTX is
    // computed for the Hub's default chat model and may exceed a smaller model's window
    // (which Ollama would reject). When the window is unknown (e.g. /api/tags discovery
    // only gives the id), stay conservative at the prior 32768 default rather than the
    // possibly-larger numCtx.
    const DEFAULT_CTX = 32768;
    const effCtx = numCtx ? Math.min(numCtx, m.context_window ?? DEFAULT_CTX) : undefined;
    // Without an explicit num_ctx, advertise the historical default but never more than
    // what Ollama will actually allocate for the model.
    const contextWindow = effCtx ?? Math.min(DEFAULT_CTX, m.context_window ?? DEFAULT_CTX);
    return {
      id: m.id,
      name: m.id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      // Output budget can't exceed the total context window.
      maxTokens: Math.min(m.max_tokens ?? 8192, contextWindow),
      ...(effCtx ? { params: { num_ctx: effCtx } } : {}),
    };
  });

  api.log.info(`CI Hub provider catalog resolved ${models.length} local model(s)`);
  return models;
}

/** S-OC-3.1: mark TTS usable once Lemonade reports a loaded/pinned TTS model. */
async function probeTtsAvailability(
  api: OpenClawPluginApi,
  getInferenceStatus: () => Promise<HubInferenceStatus | null>,
  tts: TtsState,
): Promise<void> {
  try {
    const inferenceStatus = await getInferenceStatus();
    if (!inferenceStatus) return;

    const ttsModels = inferenceStatus.models.filter((m) => m.local && m.modality.includes('tts') && (m.state === 'loaded' || m.state === 'pinned'));
    const lemonadeBackend = inferenceStatus.backends.find((b) => b.type === 'lemonade');

    if (ttsModels.length > 0 && lemonadeBackend?.running) {
      tts.modelId = ttsModels[0]?.id ?? tts.modelId;
      tts.ready = true;
      api.log.info('CI Hub TTS available via OpenClaw speech provider');
    }
  } catch (error) {
    api.log.warn(`TTS availability probe failed: ${describeError(error)}`);
  }
}
