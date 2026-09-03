import { Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type { Implementation, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { LoggerService } from '@/core/logger/logger.service';
import { McpToolRegistry } from './mcp-tool-registry.service';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';

/**
 * Holds the Hub's MCP server identity/capabilities and announces readiness at boot.
 *
 * BUG-MCP-1: the JSON-RPC protocol handling that used to live here (`handleMessage`) now belongs to
 * the official SDK — see {@link McpServerFactory} (builds the SDK `Server`) and the Streamable HTTP
 * `McpController`. This service is intentionally thin: server info + capabilities + a bootstrap log.
 */
@Injectable()
export class McpService implements OnApplicationBootstrap {
  constructor(
    private readonly toolRegistry: McpToolRegistry,
    private readonly logger: LoggerService,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  onApplicationBootstrap() {
    this.logger.info('MCP server ready', `${this.toolRegistry.listTools().length} tools`);
    this.agentNotifyService?.notify('system.mcp_ready', { toolCount: this.toolRegistry.listTools().length }, 'info');
  }

  /** Server identity advertised in the MCP `initialize` handshake. */
  getServerInfo(): Implementation {
    return { name: 'ci-hub', version: '1.0.0' };
  }

  /** Capabilities advertised at handshake. The Hub exposes tools only (no resources/prompts). */
  getCapabilities(): ServerCapabilities {
    return { tools: {} };
  }
}
