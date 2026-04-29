import { Injectable } from '@nestjs/common';
import { McpToolRegistry } from './mcp-tool-registry.service';

/**
 * Core MCP server service.
 * Handles MCP protocol (JSON-RPC 2.0) over HTTP+SSE transport.
 * Manages SSE connections, message routing, and tool dispatch.
 */
@Injectable()
export class McpService {
  constructor(private readonly toolRegistry: McpToolRegistry) {}
}
