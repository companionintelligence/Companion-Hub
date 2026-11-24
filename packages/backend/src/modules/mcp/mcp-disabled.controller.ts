import { Controller, Get, UseGuards } from '@nestjs/common';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { AuthGuard } from '@/modules/auth/auth.guard';
import type { McpAdminStatus } from './mcp-admin.service';
import { HUB_MCP_PROTOCOL_VERSIONS, HUB_MCP_SERVER_INFO } from './mcp-protocol';

/**
 * Answers the Settings > MCP screen when MCP_ENABLED=false. `McpModule` (and its admin controller)
 * is not imported then, so without this `/api/mcp-admin/status` was a 404 and the screen could only
 * show its load error, never "Disabled". Imported instead of `McpModule`, never beside it.
 */
@Controller('mcp-admin')
@UseGuards(AuthGuard)
export class McpDisabledController {
  /**
   * Every key the real status has. A mobile app ships its own copy of the screen. One built before
   * this stand-in reads `server.name` from any 200, so a smaller body threw instead of showing Disabled.
   */
  @Get('status')
  getStatus(): McpAdminStatus {
    return {
      enabled: false,
      server: { ...HUB_MCP_SERVER_INFO },
      protocolVersion: LATEST_PROTOCOL_VERSION,
      protocolVersions: [...HUB_MCP_PROTOCOL_VERSIONS],
      toolCount: 0,
      activeSessions: 0,
      activeKeyCount: 0,
      endpoint: '/api/mcp',
    };
  }

  @Get('tools')
  listTools() {
    return { tools: [] };
  }
}
