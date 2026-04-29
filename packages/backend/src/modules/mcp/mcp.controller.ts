import { Controller } from '@nestjs/common';
import { McpService } from './mcp.service';

/**
 * MCP HTTP+SSE transport controller.
 * Exposes:
 *   GET  /api/mcp/sse      — SSE channel (emits endpoint event)
 *   POST /api/mcp/messages  — JSON-RPC message endpoint
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly mcpService: McpService) {}
}
