import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { McpAdminController } from '../mcp-admin.controller';
import { McpAdminService } from '../mcp-admin.service';

describe('McpAdminController — the tool runner names the signed-in person (CI-Hub#1397)', () => {
  it('asks WhoIs who THIS request is, for the verb the tool runs', async () => {
    const admin = mock<McpAdminService>();
    const whois = mock<MarketplaceWhoIsService>();
    const actor: LifecycleActor = { kind: 'operator', userId: 7 };
    const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
    admin.callTool.mockResolvedValue({ ok: true, result: null });
    whois.lifecycleActor.mockReturnValue(actor);

    await new McpAdminController(admin, whois).callTool('hub_update_app_config', { arguments: { appUrn: 'immich:ci-marketplace' } } as never, req);

    expect(admin.callTool).toHaveBeenCalledWith(
      'hub_update_app_config',
      { appUrn: 'immich:ci-marketplace' },
      false,
      expect.any(Function),
      expect.any(Function),
    );

    const actorFor = admin.callTool.mock.calls[0]?.[3];

    expect(actorFor?.('configure')).toEqual(actor);
    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, 'configure');
  });

  it('asks whether THIS request may manage the Hub before a Hub-wide tool runs', async () => {
    const admin = mock<McpAdminService>();
    const whois = mock<MarketplaceWhoIsService>();
    const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
    admin.callTool.mockResolvedValue({ ok: true, result: null });
    whois.assertSessionMayManageHub.mockResolvedValue(undefined);

    await new McpAdminController(admin, whois).callTool('hub_pull_model', { arguments: { modelId: 'phi-4-mini' } } as never, req);
    await admin.callTool.mock.calls[0]?.[4]?.();

    expect(whois.assertSessionMayManageHub).toHaveBeenCalledWith(req);
  });
});
