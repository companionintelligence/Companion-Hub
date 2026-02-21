import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { ToolDefinition } from '../providers/llm-provider.interface';

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/**
 * Registry of tools that the companion agent can invoke via function calling.
 * Tools self-register at startup.
 */
@Injectable()
export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  constructor(private readonly logger: LoggerService) {}

  register(handler: ToolHandler) {
    this.tools.set(handler.name, handler);
    this.logger.info(`Companion tool registered: ${handler.name}`);
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async execute(name: string, argsJson: string): Promise<string> {
    const handler = this.tools.get(name);
    if (!handler) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    try {
      const args = JSON.parse(argsJson);
      return await handler.execute(args);
    } catch (error) {
      this.logger.error(`Tool ${name} failed: ${error}`);
      return JSON.stringify({ error: `Tool ${name} failed: ${error}` });
    }
  }

  listTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }
}
