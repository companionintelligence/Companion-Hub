import { Injectable, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';
import { formatToolError, formatToolSuccess } from './mcp-error.handler';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';

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

@Injectable()
export class McpService implements OnApplicationBootstrap {
  constructor(
    private readonly toolRegistry: McpToolRegistry,
    private readonly logger: LoggerService,
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
