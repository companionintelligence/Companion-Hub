import type { AppUrn } from '@ci-hub/common/types';
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { castAppUrn } from '@/common/helpers/app-helpers';
import type { HubAction } from '@/core/portal/hub-actions';
import type { HubPrincipalFields } from '@/core/portal/hub-session-operator';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import type { CustomDomainForm } from '@/modules/app-lifecycle/custom-domain-authority';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { McpAdminService } from './mcp-admin.service';
import { McpToolCallBody } from './mcp-admin.dto';

/** The tools that take an install / update-config form, and the verb each one is on the app routes. */
const FORM_TOOL_ACTIONS: Partial<Record<string, HubAction>> = {
  hub_install_app: 'install',
  hub_update_app_config: 'configure',
};

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
    private readonly appLifecycleService: AppLifecycleService,
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
  async callTool(@Param('name') name: string, @Body() body: McpToolCallBody, @Req() req: Request) {
    try {
      await this.authorizeCustomDomainChange(name, body.arguments, req);
    } catch (error) {
      // Shown inline, like the refusals the tool registry returns, rather than as a failed request.
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }

    // Only the principal, not the request: the tool's async context can outlive the reply (a sweep
    // keeps running after it), and a closure over `req` would hold the whole request until it ends.
    const principal: HubPrincipalFields = { hubPrincipal: req.hubPrincipal, user: req.user };

    return this.adminService.callTool(name, body.arguments, body.confirmDestructive ?? false, (action) =>
      this.whois.lifecycleActor(principal, action),
    );
  }

  /**
   * R2-HUBDOMAINS-1 on the tool runner.
   *
   * ⚠ `confirmDestructive` IS NOT AN AUTHORITY. A form naming a custom domain is
   * destructive (R2-HUBHOSTESCAPE-6), and here that means it runs once the
   * caller says they mean it — the caller being any signed-in person, saying so
   * in the same request. Left at that, the runner is the settings dialog with
   * the role check taken out. So a form that changes which custom domain an app
   * serves takes an organization owner or admin here too, decided by the same
   * rule as on the `install` / `update-config` routes.
   *
   * The agent-facing `/api/mcp` surface is a key with no person behind it, so
   * there is no role to ask about; it keeps the `full`-capability gate.
   */
  private async authorizeCustomDomainChange(name: string, args: Record<string, unknown> | undefined, req: Request): Promise<void> {
    const action = FORM_TOOL_ACTIONS[name];
    const urn = args?.appUrn;
    const form = args?.form;

    if (!action || typeof urn !== 'string' || typeof form !== 'object' || form === null) {
      return;
    }

    let appUrn: AppUrn;
    try {
      appUrn = castAppUrn(urn);
    } catch {
      // The tool refuses the same urn itself, before it changes anything.
      return;
    }

    await this.appLifecycleService.authorizeCustomDomainChange(appUrn, form as CustomDomainForm, () =>
      this.whois.assertCustomDomainAuthority(req, appUrn, action),
    );
  }
}
