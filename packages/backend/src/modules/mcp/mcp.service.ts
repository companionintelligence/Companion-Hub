import { Injectable } from '@nestjs/common';
import { McpToolNotFoundError, McpToolRegistry } from './mcp-tool-registry.service';

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
export class McpService {
  constructor(private readonly toolRegistry: McpToolRegistry) {}

  getServerInfo() {
    return {
      name: 'ci-hub',
      version: '1.0.0',
    };
  }

  getCapabilities() {
    return {
      tools: {},
    };
  }

  async handleMessage(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: this.getServerInfo(),
            capabilities: this.getCapabilities(),
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: this.toolRegistry.listTools().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case 'tools/call': {
        const toolName = request.params?.name as string;
        const toolArgs = (request.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await this.toolRegistry.callTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
          };
        } catch (error) {
          if (error instanceof McpToolNotFoundError) {
            return {
              jsonrpc: '2.0',
              id: request.id,
              error: { code: error.code, message: error.message },
            };
          }
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  }
}
