import type { Request } from 'express';
import { HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { McpAdminController } from '../mcp-admin.controller';
import { McpAdminService } from '../mcp-admin.service';

/*
 * R2-HUBDOMAINS-1 on the operator tool runner. `confirmDestructive` is the
 * caller saying they mean it, not a role, so a form that changes an app's
 * custom domain takes an organization owner or admin here as on the app routes.
 */
describe('McpAdminController — custom-domain changes take an owner or admin', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'filebrowser:ci-marketplace';
  const form = { customDomain: 'shop.acme.com', customDomainTakeover: true };

  let admin: MockProxy<McpAdminService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let lifecycle: MockProxy<AppLifecycleService>;
  let controller: McpAdminController;

  beforeEach(() => {
    admin = mock<McpAdminService>();
    whois = mock<MarketplaceWhoIsService>();
    lifecycle = mock<AppLifecycleService>();
    admin.callTool.mockResolvedValue({ ok: true, result: { requestId: 'r' } });
    // The service found a change: run the check the runner handed it.
    lifecycle.authorizeCustomDomainChange.mockImplementation(async (_urn, _form, authorize) => authorize());
    controller = new McpAdminController(admin, whois, lifecycle);
  });

  it.each([
    ['hub_install_app', 'install'],
    ['hub_update_app_config', 'configure'],
  ])('%s asks for the role as the %s verb before it runs', async (tool, verb) => {
    await controller.callTool(tool, { arguments: { appUrn, form }, confirmDestructive: true }, req);

    expect(lifecycle.authorizeCustomDomainChange).toHaveBeenCalledWith(appUrn, form, expect.any(Function));
    expect(whois.assertCustomDomainAuthority).toHaveBeenCalledWith(req, appUrn, verb);
    expect(admin.callTool).toHaveBeenCalledWith(tool, { appUrn, form }, true);
  });

  it('refuses a member inline and never runs the tool, confirmDestructive or not', async () => {
    whois.assertCustomDomainAuthority.mockRejectedValue(new TranslatableError('CUSTOM_DOMAIN_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN));

    await expect(controller.callTool('hub_update_app_config', { arguments: { appUrn, form }, confirmDestructive: true }, req)).resolves.toEqual({
      ok: false,
      error: 'CUSTOM_DOMAIN_ROLE_REQUIRED',
    });
    expect(admin.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ['a tool that takes no form', 'hub_restart_app', { appUrn }],
    ['a form tool called without a form', 'hub_update_app_config', { appUrn }],
    ['a urn the tool itself refuses', 'hub_update_app_config', { appUrn: 'not-a-urn', form }],
  ])('leaves %s to the tool', async (_label, tool, args) => {
    await controller.callTool(tool, { arguments: args, confirmDestructive: false }, req);

    expect(lifecycle.authorizeCustomDomainChange).not.toHaveBeenCalled();
    expect(admin.callTool).toHaveBeenCalledWith(tool, args, false);
  });
});
