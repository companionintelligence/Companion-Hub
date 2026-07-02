import { Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type CallToolResult, CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { LoggerService } from '@/core/logger/logger.service';
import { McpService } from './mcp.service';
import { McpToolNotFoundError, McpToolRegistry, toToolDescriptor } from './mcp-tool-registry.service';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';

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

    // tools/list — project the registry into the MCP tool descriptor shape (shared with the admin catalog).
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.listTools().map(toToolDescriptor),
    }));

    // tools/call — route to the registry, format success/errors into MCP content, and audit.
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
      const start = Date.now();

      try {
        const result = await this.registry.callTool(toolName, toolArgs);
        // ISSUE-MCP-2: audit every successful tool call at info (name + duration only — never args).
        this.logger.info('MCP tool call', toolName, `${Date.now() - start}ms`, 'ok');
        // Cast: our {type:'text'} content is structurally a CallToolResult; the SDK's content union
        // is wider than we produce, so TS can't infer the narrowing without help.
        return formatToolSuccess(result) as CallToolResult;
      } catch (error) {
        const durationMs = Date.now() - start;
        // Unknown tool → a real JSON-RPC error (-32602), preserving the pre-migration contract.
        if (error instanceof McpToolNotFoundError) {
          this.logger.warn('MCP tool call rejected (unknown tool)', toolName, `${durationMs}ms`);
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        // Everything else (including a blocked destructive tool) → an isError tool result so the
        // agent can read the message rather than seeing the session crash.
        this.logger.warn('MCP tool call failed', toolName, `${durationMs}ms`);
        const appUrn = toolArgs.appUrn as string | undefined;
        return formatToolError(error, appUrn) as CallToolResult;
      }
    });

    return server;
  }
}
