import { Injectable } from '@nestjs/common';

/**
 * Registry for MCP tools.
 * Tools register themselves here; the McpService queries
 * this registry for tools/list and tools/call dispatch.
 */
@Injectable()
export class McpToolRegistry {
  private tools = new Map<string, unknown>();
}
