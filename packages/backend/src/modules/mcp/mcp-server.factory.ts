import { Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type CallToolResult, CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LoggerService } from '@/core/logger/logger.service';
import { McpService } from './mcp.service';
import { McpToolRegistry, toToolDescriptor } from './mcp-tool-registry.service';
import { invokeRegistryTool, mcpCallerCapability } from './mcp-tool-call';

/**
 * BUG-MCP-1: builds a spec-compliant MCP {@link Server} (official SDK) bound to the Hub's shared
 * {@link McpToolRegistry}. We use the SDK's low-level `Server` + `setRequestHandler` — rather than
 * the high-level `McpServer.registerTool`, which expects Zod input shapes — so the ~73 existing
 * tool definitions (raw JSON Schema + handler) are reused unchanged. One `Server` instance is built
 * per Streamable HTTP session by the controller and connected to a transport.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly mcpService: McpService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Create a fresh SDK server wired to the registry. The server is stateless w.r.t. tools (it reads
   * the shared registry on every request), so building one per session is cheap.
   */
  create(): Server {
    const server = new Server(this.mcpService.getServerInfo(), { capabilities: this.mcpService.getCapabilities() });

    // tools/list — project the registry into the MCP tool descriptor shape (shared with the admin
    // catalog), filtered to what the calling key can actually run. An agent is shown a coherent
    // surface rather than tools it was always going to be refused; the annotations on each descriptor
    // then say which of the visible ones mutate.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.listToolsForCapability(mcpCallerCapability()).map(toToolDescriptor),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      return invokeRegistryTool(this.registry, this.logger, toolName, toolArgs);
    });

    return server;
  }
}
