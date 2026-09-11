import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpAdminService } from './mcp-admin.service';
import { McpToolCallBody } from './mcp-admin.dto';

/**
 * ENH-MCP-4: operator-facing MCP admin surface, powering the "MCP" Settings screen. Distinct from the
 * agent-facing `/api/mcp` endpoint (Bearer key from the hashed store): this is session-authed
 * ({@link AuthGuard}) so the browser never handles an agent key, and the tool runner proxies calls
 * server-side.
 */
@Controller('mcp-admin')
@UseGuards(AuthGuard)
export class McpAdminController {
  constructor(
    private readonly adminService: McpAdminService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  /** Overall status: enabled, server info, negotiated protocol, tool count, live sessions, key count. */
  @Get('status')
  getStatus() {
    return this.adminService.getStatus();
  }

  /** Full tool catalog (name, description, input schema, destructive + read/write flags). */
  @Get('tools')
  listTools() {
    return { tools: this.adminService.listTools() };
  }

  /**
   * Run a tool server-side (the in-UI "try it" runner). Destructive tools require confirmDestructive.
   *
   * The lifecycle tools act as the signed-in person: `lifecycleActor` names them for each verb, or
   * refuses a request that names no principal, so the grants the app routes check apply here too.
   */
  @Post('tools/:name/call')
  callTool(@Param('name') name: string, @Body() body: McpToolCallBody, @Req() req: Request) {
    return this.adminService.callTool(name, body.arguments, body.confirmDestructive ?? false, (action) => this.whois.lifecycleActor(req, action));
  }
}
