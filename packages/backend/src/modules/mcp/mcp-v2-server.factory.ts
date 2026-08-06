import { Injectable } from '@nestjs/common';
import { McpServer, type McpRequestContext, type ServerCapabilities } from '@modelcontextprotocol/server';
import { LoggerService } from '@/core/logger/logger.service';
import { McpService } from './mcp.service';
import { jsonSchemaAsStandard } from './mcp-json-schema';
import { invokeRegistryTool, mcpCallerCapability } from './mcp-tool-call';
import { McpToolRegistry, toToolDescriptor } from './mcp-tool-registry.service';

/**
 * Builds a per-request {@link McpServer} for the 2026-07-28 stateless handler
 * ({@link McpModernHandlerService}). One instance is constructed per HTTP exchange.
 */
@Injectable()
export class McpV2ServerFactory {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly mcpService: McpService,
    private readonly logger: LoggerService,
  ) {}

  create(_ctx: McpRequestContext): McpServer {
    const server = new McpServer(this.mcpService.getServerInfo(), {
      capabilities: this.mcpService.getCapabilities() as ServerCapabilities,
    });
    const capability = mcpCallerCapability();

    for (const tool of this.registry.listToolsForCapability(capability)) {
      const descriptor = toToolDescriptor(tool);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: jsonSchemaAsStandard(tool.inputSchema),
          annotations: descriptor.annotations,
        },
        async (args) => invokeRegistryTool(this.registry, this.logger, tool.name, args as Record<string, unknown>),
      );
    }

    return server;
  }
}
