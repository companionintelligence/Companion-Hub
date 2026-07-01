import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpAdminService } from './mcp-admin.service';
import { McpAdminSettingsBody, McpToolCallBody } from './mcp-admin.dto';

/**
 * ENH-MCP-4: operator-facing MCP admin surface, powering the "MCP" Settings screen. Distinct from the
 * agent-facing `/api/mcp` endpoint (Bearer `MCP_API_KEY`): this is session-authed ({@link AuthGuard})
 * so the browser never handles the agent key, and the tool runner proxies calls server-side.
 */
@Controller('mcp-admin')
@UseGuards(AuthGuard)
export class McpAdminController {
  constructor(private readonly adminService: McpAdminService) {}

  /** Overall status: enabled, server info, negotiated protocol, tool count, live sessions, gate state. */
  @Get('status')
  getStatus() {
    return this.adminService.getStatus();
  }

  /** Full tool catalog (name, description, input schema, destructive flag). */
  @Get('tools')
  listTools() {
    return { tools: this.adminService.listTools() };
  }

  /** Run a tool server-side (the in-UI "try it" runner). Destructive tools require confirmDestructive. */
  @Post('tools/:name/call')
  callTool(@Param('name') name: string, @Body() body: McpToolCallBody) {
    return this.adminService.callTool(name, body.arguments, body.confirmDestructive ?? false);
  }

  /** Toggle the destructive-tool gate (live + persisted). */
  @Post('settings')
  updateSettings(@Body() body: McpAdminSettingsBody) {
    return this.adminService.setDestructiveAllowed(body.allowDestructive);
  }

  /** Rotate the MCP API key (live + persisted). Returns the new key once so the operator can copy it. */
  @Post('key/rotate')
  rotateKey() {
    return this.adminService.rotateApiKey();
  }
}
