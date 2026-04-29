import { Injectable } from '@nestjs/common';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

@Injectable()
export class McpToolRegistry {
  private tools = new Map<string, McpToolDefinition>();

  register(tool: McpToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  listTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getTool(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new McpToolNotFoundError(name);
    }
    return tool.handler(params);
  }
}

export class McpToolNotFoundError extends Error {
  public readonly code = -32601;
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'McpToolNotFoundError';
  }
}
