import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('asks for the first page when the caller names none', async () => {
    await controller.getAppBackups(appUrn, {} as never, req);

    expect(backups.getAppBackups).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 10 }));
  });
});

/*
 * A custom app's backups are its owner's and admins'. Listing and downloading them takes `backup`,
 * the grant a member does not hold on a custom app; a catalog app keeps `view`.
 */
describe('BackupsController: reading the backups of a custom app', () => {
  const actor: LifecycleActor = { kind: 'operator', userId: 7 };
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const customApp = 'my-compose:_user';

  let backups: MockProxy<BackupsService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: BackupsController;

  beforeEach(() => {
    backups = mock<BackupsService>();
    whois = mock<MarketplaceWhoIsService>();
    whois.lifecycleActor.mockReturnValue(actor);
    backups.getAppBackups.mockResolvedValue({ data: [], total: 0, currentPage: 1, lastPage: 0 });
    backups.getBackupFilePath.mockResolvedValue('/backups/my-compose.tar.gz');
    controller = new BackupsController(backups, whois);
  });

  it('lists them only for someone holding backup', async () => {
    await controller.getAppBackups(customApp, {} as never, req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, customApp, 'backup');
    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, 'backup');
  });

  it('downloads one only for someone holding backup, and never reaches the file when refused', async () => {
    const res = { set: vi.fn(), sendFile: vi.fn() } as unknown as Response;
    whois.assertSessionAction.mockRejectedValue(new Error('APP_ACTION_GRANT_DENIED'));

    await expect(controller.downloadBackup(customApp, 'my-compose.tar.gz', res, req)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, customApp, 'backup');
    expect(backups.getBackupFilePath).not.toHaveBeenCalled();
  });

  it('keeps view for a catalog app', async () => {
    await controller.getAppBackups('immich:ci-marketplace', {} as never, req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'immich:ci-marketplace', 'view');
  });
});
