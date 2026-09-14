import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { BackupsController } from '../backups.controller';
import { BackupsService } from '../backups.service';

/*
 * `BackupsService` decides from the actor it is handed (CI-Hub#1397), so what matters here is that
 * each route hands over the actor WhoIs names for THIS request and THIS action — beside the session
 * check it already made, not instead of it.
 */
describe('BackupsController — names the actor for every backup call', () => {
  const actor: LifecycleActor = { kind: 'operator', userId: 7 };
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'immich:ci-marketplace';

  let backups: MockProxy<BackupsService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: BackupsController;

  beforeEach(() => {
    backups = mock<BackupsService>();
    whois = mock<MarketplaceWhoIsService>();
    whois.lifecycleActor.mockReturnValue(actor);
    backups.backupApp.mockResolvedValue({ requestId: 'r' });
    backups.restoreApp.mockResolvedValue({ requestId: 'r' });
    backups.getAppBackups.mockResolvedValue({ data: [], total: 0, currentPage: 1, lastPage: 0 });
    controller = new BackupsController(backups, whois);
  });

  it.each([
    ['backupApp', 'backup', (c: BackupsController) => c.backupApp(appUrn, req)],
    ['restoreApp', 'restore', (c: BackupsController) => c.restoreAppBackup(appUrn, { filename: 'immich.tar.gz' } as never, req)],
    ['getAppBackups', 'view', (c: BackupsController) => c.getAppBackups(appUrn, {} as never, req)],
    ['deleteAppBackup', 'backup', (c: BackupsController) => c.deleteAppBackup(appUrn, { filename: 'immich.tar.gz' } as never, req)],
  ] as const)('%s asserts the session and hands the service the actor, both for %s', async (method, action, route) => {
    await route(controller);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, appUrn, action);
    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, action);
    expect(backups[method]).toHaveBeenCalledWith(expect.objectContaining({ appUrn, actor }));
  });
});
