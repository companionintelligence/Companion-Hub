import type { OpenClawPluginApi, PluginConfig } from './types';
import { McpClient } from './mcp-client';
import { createWakeEndpointHandler } from './wake-endpoint';
import { SseListenerService } from './sse-listener';

/**
 * OpenClaw plugin entry point.
 * Registers Hub MCP tools, wake webhook endpoint, and optional SSE listener.
 */
export async function register(api: OpenClawPluginApi, config: PluginConfig): Promise<void> {
  // Fall back to env vars for zero-config when running inside CI-Hub (R-PLG-1)
  const hubUrl = config.hubUrl || process.env.HUB_URL;
  const hubApiKey = config.hubApiKey || process.env.HUB_API_KEY;
  const wakeSecret = config.wakeSecret || process.env.HUB_WAKE_SECRET;

  if (!hubUrl || !hubApiKey) {
    api.log.error('CI-Hub plugin requires hubUrl and hubApiKey (via config or HUB_URL/HUB_API_KEY env vars)');
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
  const mcpClient = new McpClient(hubUrl, hubApiKey, api.log);
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
    const sseListener = new SseListenerService(hubUrl, hubApiKey, api, config.wakeFilter);
    await sseListener.start();
  }
}
