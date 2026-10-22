import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { FederatedIdentityRepository } from '@/modules/auth/federated-identity.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import { MemoryConnectController } from '../memory-connect.controller';

/**
 * Connecting and disconnecting Memory both restart the app, so both take the app's `restart` grant,
 * asked of the Portal the way the restart route asks it. The real WhoIs service runs here; only the
 * Portal's answer is a stand-in.
 */
describe('MemoryConnectController per-app grants', () => {
  const APP = 'ci-openclaw:ci-marketplace';
  // Person 7 holds OpenClaw's restart grant; person 8 may only look at it.
  const GRANTS: Record<string, string[]> = { 'portal-7': ['view', 'start', 'stop', 'restart'], 'portal-8': ['view'] };

  let service: { startConnect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  let controller: MemoryConnectController;

  const session = (userId: number) => ({ hubPrincipal: 'session', user: { id: userId }, headers: { host: 'hub.example.com' } }) as unknown as Request;
  const response = () => ({ redirect: vi.fn() }) as unknown as Response & { redirect: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const portal = mock<PortalClientService>();
    portal.whoisApps.mockImplementation(async ({ subject, appIds }) => ({
      status: 200,
      body: {
        organizations: [
          { organizationId: 'org-hub', version: 1, user: { role: 'member' }, apps: appIds.map((appId) => ({ appId, can: GRANTS[subject] ?? [] })) },
        ],
      },
    }));
    const federatedIdentities = mock<FederatedIdentityRepository>();
    federatedIdentities.findByUserId.mockImplementation(async (userId) => [{ subject: `portal-${userId}` }] as never);
    const registration = mock<RegistrationService>();
    registration.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-hub' } as never);
    // An empty WhoIs cache, so every answer comes from the Portal stand-in above.
    const database = mock<DatabaseService>();
    database.db = {
      select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    } as unknown as DatabaseService['db'];
    const whois = new MarketplaceWhoIsService(portal, database, mock<LoggerService>(), federatedIdentities, registration, mock<UserRepository>());

    service = {
      startConnect: vi.fn().mockResolvedValue('https://memory.example.org/api/connect?app=ci-openclaw%3Aci-marketplace&state=s'),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    controller = new MemoryConnectController(
      service as never,
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
      mock<UserRepository>() as never,
      { getAppEnv: vi.fn() } as never,
      new EnvUtils(),
      whois,
    );
  });

  it('sends a person without the restart grant back to the Hub instead of to CI Memory', async () => {
    const res = response();

    await controller.start(APP, undefined, session(8), res);

    expect(service.startConnect).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/?memoryConnect=denied');
  });

  it('starts the connect for a person with the restart grant', async () => {
    const res = response();

    await controller.start(APP, undefined, session(7), res);

    expect(service.startConnect).toHaveBeenCalledWith(APP, undefined, '7', { host: 'hub.example.com' });
    expect(res.redirect).toHaveBeenCalledWith('https://memory.example.org/api/connect?app=ci-openclaw%3Aci-marketplace&state=s');
  });

  it('refuses Disconnect with APP_ACTION_GRANT_DENIED to a person without the restart grant', async () => {
    await expect(controller.disconnect(APP, session(8), {})).rejects.toMatchObject({ status: 403, message: 'APP_ACTION_GRANT_DENIED' });

    expect(service.disconnect).not.toHaveBeenCalled();
  });

  it('lets a person with the restart grant disconnect, leaving whose connection it is to the service', async () => {
    await expect(controller.disconnect(APP, session(7), {})).resolves.toEqual({ ok: true });

    expect(service.disconnect).toHaveBeenCalledWith(APP, '7');
  });
});
