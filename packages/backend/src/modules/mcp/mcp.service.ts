import { Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import { AppsService } from '@/modules/apps/apps.service';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { AgentConfigService } from './agents/agent-config.service';
import { McpBridgeService } from './agents/mcp-bridge.service';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpRegistryServer {
  appUrn: string;
  name: string;
  transport: 'sse' | 'stdio';
  url: string | null;
  tools: string[];
  status: AppStatus | 'error';
}

export interface McpRegistryResponse {
  servers: McpRegistryServer[];
}

@Injectable()
export class McpService implements OnApplicationBootstrap {
  constructor(
    private readonly toolRegistry: McpToolRegistry,
    private readonly logger: LoggerService,
    private readonly appsService: AppsService,
    private readonly agentConfigService: AgentConfigService,
    private readonly mcpBridgeService: McpBridgeService,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  onApplicationBootstrap() {
    this.logger.info('MCP server ready');
    this.agentNotifyService?.notify('system.mcp_ready', { toolCount: this.toolRegistry.listTools().length }, 'info');
  }

  getServerInfo() {
    return { name: 'ci-hub', version: '1.0.0' };
  }

  getCapabilities() {
    return { tools: {} };
  }

  async getRegistry(): Promise<McpRegistryResponse> {
    const installedApps = await this.appsService.getInstalledApps();
    const servers = await Promise.all(
      installedApps.map(async ({ app, info }) => {
        const appUrn = info.urn as AppUrn;
        const agentConfig = await this.agentConfigService.getAgentConfig(appUrn, info);
        if (!agentConfig?.mcp.enabled || !agentConfig.mcp.config) {
          return null;
        }

        let status: McpRegistryServer['status'] = app?.status ?? 'stopped';
        let tools: string[] = [];

        if (status === 'running') {
          try {
            const remoteTools = await this.mcpBridgeService.listRemoteTools(appUrn, agentConfig);
            tools = remoteTools.map((tool) => tool.name);
          } catch (error) {
            status = 'error';
            this.logger.warn(`Failed to discover MCP tools for ${appUrn}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        return {
          appUrn,
          name: info.name,
          transport: agentConfig.mcp.config.transport,
          url: agentConfig.mcp.config.url ?? null,
          tools,
          status,
        } satisfies McpRegistryServer;
      }),
    );

    return {
      servers: servers.filter((server): server is McpRegistryServer => server !== null),
    };
  }

  async handleMessage(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (request.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request: missing jsonrpc 2.0' } };
    }

    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '2024-11-05', serverInfo: this.getServerInfo(), capabilities: this.getCapabilities() },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: this.toolRegistry.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          },
        };

      case 'tools/call': {
        const toolName = request.params?.name as string;
        const toolArgs = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const start = Date.now();
        try {
          const result = await this.toolRegistry.callTool(toolName, toolArgs);
          this.logger.debug(`MCP tool ${toolName} completed in ${Date.now() - start}ms`);
          return { jsonrpc: '2.0', id: request.id, result: formatToolSuccess(result) };
        } catch (error) {
          this.logger.debug(`MCP tool ${toolName} failed in ${Date.now() - start}ms`);
          if (error instanceof McpToolNotFoundError) {
            return { jsonrpc: '2.0', id: request.id, error: { code: error.code, message: error.message } };
          }
          const appUrn = toolArgs.appUrn as string | undefined;
          return { jsonrpc: '2.0', id: request.id, result: formatToolError(error, appUrn) };
        }
      }

      default:
        return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
  }
}
