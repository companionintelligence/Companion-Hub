import { Injectable } from '@nestjs/common';
import { McpServer, type McpRequestContext, type ServerCapabilities } from '@modelcontextprotocol/server';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { McpService } from './mcp.service';
import { jsonSchemaAsStandard } from './mcp-json-schema';
import { invokeRegistryTool, mcpCallerCapability, mcpKeyMayListHubWide } from './mcp-tool-call';
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
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  /**
   * The tools registered here are the ones this request's key may list, so a tool left out of
   * `tools/list` is also unknown to `tools/call`, as one its capability doesn't reach.
   */
  async create(_ctx: McpRequestContext): Promise<McpServer> {
    const server = new McpServer(this.mcpService.getServerInfo(), {
      capabilities: this.mcpService.getCapabilities() as ServerCapabilities,
    });
    const capability = mcpCallerCapability();
    const mayManageHub = await mcpKeyMayListHubWide(this.whois);

    for (const tool of this.registry.listToolsForCapability(capability, { mayManageHub })) {
      const descriptor = toToolDescriptor(tool);
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: jsonSchemaAsStandard(tool.inputSchema),
          annotations: descriptor.annotations,
        },
        async (args) => invokeRegistryTool(this.registry, this.logger, this.whois, tool.name, args as Record<string, unknown>),
      );
    }

    return server;
  }
}
