import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@/modules/auth/auth.guard';

/**
 * Answers the Settings > MCP screen when MCP_ENABLED=false. `McpModule` (and its admin controller)
 * is not imported then, so without this `/api/mcp-admin/status` was a 404 and the screen could only
 * show its load error, never "Disabled". Imported instead of `McpModule`, never beside it.
 */
@Controller('mcp-admin')
@UseGuards(AuthGuard)
export class McpDisabledController {
  @Get('status')
  getStatus() {
    return { enabled: false, endpoint: '/api/mcp', toolCount: 0, activeSessions: 0, activeKeyCount: 0 };
  }

  @Get('tools')
  listTools() {
    return { tools: [] };
  }
}
