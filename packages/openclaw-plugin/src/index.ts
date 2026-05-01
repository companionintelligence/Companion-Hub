import type { OpenClawPluginApi, PluginConfig, HubInferenceStatus } from './types';
import { McpClient } from './mcp-client';
import { createWakeEndpointHandler } from './wake-endpoint';
import { SseListenerService } from './sse-listener';

/**
 * OpenClaw plugin entry point.
 * Registers Hub MCP tools, wake webhook endpoint, optional SSE listener,
 * and auto-discovers local inference capabilities (OC-1).
 */
export async function register(api: OpenClawPluginApi, config: PluginConfig): Promise<void> {
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

  // Validate Hub is reachable
  try {
    const healthResponse = await fetch(`${hubUrl.replace(/\/$/, '')}/api/health`);
    if (!healthResponse.ok) {
      api.log.warn(`Hub health check failed: ${healthResponse.status}`);
    }
  } catch (error) {
    api.log.warn(`Hub unreachable at ${hubUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Connect to Hub MCP server and register tools
  const mcpClient = new McpClient(hubUrl, mcpApiKey, api.log);
  await mcpClient.connect();

  if (mcpClient.isConnected()) {
    try {
      const tools = await mcpClient.listTools();
      for (const tool of tools) {
        api.registerTool({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          handler: async (args) => mcpClient.callTool(tool.name, args),
        });
      }
      api.log.info(`Registered ${tools.length} Hub MCP tools`);
    } catch (error) {
      api.log.error(`Failed to register Hub tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Register wake webhook endpoint
  const wakeHandler = createWakeEndpointHandler(api, wakeSecret, config.wakeFilter);
  api.registerHttpRoute({
    method: 'POST',
    path: '/hooks/hub-wake',
    handler: wakeHandler,
  });
  api.log.info('Registered wake endpoint: POST /hooks/hub-wake');

  // Start SSE listener if enabled
  if (config.sseEnabled) {
    const sseListener = new SseListenerService(hubUrl, mcpApiKey, api, config.wakeFilter);
    await sseListener.start();
  }

  // ─── Auto-Discover Inference Capabilities (OC-1) ─────────────────────
  await autoConfigureInference(api, hubUrl, mcpApiKey, mcpClient);
}

/**
 * Auto-configure OpenClaw to use the Hub's inference capabilities.
 * S-OC-1.1: On plugin startup, calls hub_get_inference_status to discover models.
 * S-OC-1.2: Discovered local models are registered as an OpenClaw provider ("ci-hub").
 * S-OC-1.3: Local models have cost { input: 0, output: 0 }.
 * S-OC-2.1: If hardware tier is insufficient, surfaces a message recommending cloud.
 */
async function autoConfigureInference(api: OpenClawPluginApi, hubUrl: string, apiKey: string, mcpClient: McpClient): Promise<void> {
  try {
    // S-OC-1.1: Discover inference capabilities via MCP
    let inferenceStatus: HubInferenceStatus | null = null;

    if (mcpClient.isConnected()) {
      try {
        const result = await mcpClient.callTool('hub_get_inference_status', {});
        inferenceStatus = result as HubInferenceStatus;
      } catch {
        api.log.debug('hub_get_inference_status not yet available — trying REST fallback');
      }
    }

    // REST fallback
    if (!inferenceStatus) {
      try {
        const response = await fetch(`${hubUrl.replace(/\/$/, '')}/api/inference/status`);
        if (response.ok) {
          inferenceStatus = (await response.json()) as HubInferenceStatus;
        }
      } catch {
        api.log.debug('Inference REST endpoint not available');
      }
    }

    if (!inferenceStatus) {
      api.log.info('Hub inference not available — skipping auto-configuration');
      return;
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

    // S-OC-1.2: Register local models as an OpenClaw provider
    const localModels = inferenceStatus.models.filter(
      (m) => m.local && m.modality.includes('text') && (m.state === 'loaded' || m.state === 'pinned'),
    );

    if (localModels.length > 0 && api.registerProvider) {
      const inferenceBaseUrl = `${hubUrl.replace(/\/$/, '')}/api/inference/v1`;

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
              baseUrl: inferenceBaseUrl,
              apiKey,
              api: 'openai-completions',
              models: localModels.map((m) => ({
                id: m.id,
                name: m.id,
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: m.context_window ?? 32768,
                maxTokens: m.max_tokens ?? 8192,
              })),
            },
          }),
        },
      });
      api.log.info(`Registered CI Hub as OpenClaw provider with ${localModels.length} local model(s)`);
    }

    // S-OC-3.1: Register TTS if Lemonade is running with TTS models
    const ttsModels = inferenceStatus.models.filter((m) => m.local && m.modality.includes('tts') && (m.state === 'loaded' || m.state === 'pinned'));
    const lemonadeBackend = inferenceStatus.backends.find((b) => b.type === 'lemonade');

    if (ttsModels.length > 0 && lemonadeBackend?.running && api.registerSpeechProvider) {
      const inferenceBaseUrl = `${hubUrl.replace(/\/$/, '')}/api/inference/v1`;

      api.registerSpeechProvider({
        id: 'ci-hub',
        label: 'CI Hub TTS (Local)',
        isConfigured: () => true,
        synthesize: async (req) => {
          const response = await fetch(`${inferenceBaseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: ttsModels[0]?.id ?? 'kokoro-v1',
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
      api.log.info('Registered CI Hub TTS as OpenClaw speech provider');
    }

    // S-OC-2.2: If cloud credentials exist in Hub, log availability
    const configuredCloud = inferenceStatus.cloudProviders.filter((p) => p.configured);
    if (configuredCloud.length > 0) {
      api.log.info(`Hub has ${configuredCloud.length} cloud provider(s) configured as fallback`);
    }
  } catch (error) {
    api.log.warn(`Auto-configuration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
