import type { Request } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppLifecycleController } from '../app-lifecycle.controller';
import { AppLifecycleService } from '../app-lifecycle.service';
import { AppRehydrationService } from '../app-rehydration.service';
import { HubAccessService } from '../hub-access.service';
import { PairingAppRestoreService } from '../pairing-app-restore.service';

/*
 * The service decides from the actor it is handed (CI-Hub#1397), so what matters
 * here is that each route hands over the actor WhoIs names for THIS request and
 * THIS action — not a fixed or borrowed one.
 */
describe('AppLifecycleController — names the actor for every lifecycle call', () => {
  const actor: LifecycleActor = { kind: 'operator', userId: 7 };
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const appUrn = 'immich:ci-marketplace';

  let lifecycle: MockProxy<AppLifecycleService>;
  let rehydration: MockProxy<AppRehydrationService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let pairingRestore: MockProxy<PairingAppRestoreService>;
  let controller: AppLifecycleController;

  beforeEach(() => {
    lifecycle = mock<AppLifecycleService>();
    rehydration = mock<AppRehydrationService>();
    whois = mock<MarketplaceWhoIsService>();
    whois.lifecycleActor.mockReturnValue(actor);
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    lifecycle.updateAppConfig.mockResolvedValue({ requestId: 'r' } as never);
    pairingRestore = mock<PairingAppRestoreService>();
    controller = new AppLifecycleController(lifecycle, rehydration, mock<HubAccessService>(), whois, pairingRestore);
  });

  it('install', async () => {
    await controller.installApp(appUrn, { port: 8080 } as never, req);

    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, 'install');
    expect(lifecycle.installApp).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  // `installApp` asks WhoIs itself before anything else. Asking here too cost a second round trip.
  it('install leaves the grant check to the service, so WhoIs is asked once', async () => {
    await controller.installApp(appUrn, { port: 8080 } as never, req);

    expect(whois.assertSessionAction).not.toHaveBeenCalled();
  });

  it('update-config', async () => {
    await controller.updateAppConfig(appUrn, { port: 8080 } as never, req);

    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, 'configure');
    expect(lifecycle.updateAppConfig).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it('rehydrate installs as the person who asked', async () => {
    await controller.executeRehydrate({} as never, req);

    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, 'install');
    expect(rehydration.executeRehydrate).toHaveBeenCalledWith(expect.objectContaining({ actor }));
  });

  it.each([
    ['startApp', 'start', (c: AppLifecycleController) => c.startApp(appUrn, req)],
    ['stopApp', 'stop', (c: AppLifecycleController) => c.stopApp(appUrn, req)],
    ['restartApp', 'restart', (c: AppLifecycleController) => c.restartApp(appUrn, req)],
    ['uninstallApp', 'uninstall', (c: AppLifecycleController) => c.uninstallApp(appUrn, { deleteAllData: true } as never, req)],
    ['resetApp', 'reset', (c: AppLifecycleController) => c.resetApp(appUrn, {} as never, req)],
    ['updateApp', 'update', (c: AppLifecycleController) => c.updateApp(appUrn, { performBackup: true } as never, req)],
    // Cancelling weighs what stopping does; the route asserts `stop`, and so does the service.
    ['cancelOperation', 'stop', (c: AppLifecycleController) => c.cancelOperation(appUrn, {} as never, req)],
  ] as const)('%s acts as the actor for %s', async (method, action, route) => {
    lifecycle[method].mockResolvedValue({ requestId: 'r', outcome: 'not_found' } as never);

    await route(controller);

    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, action);
    expect(lifecycle[method]).toHaveBeenCalledWith(expect.objectContaining({ appUrn, actor }));
  });

  it.each([
    ['updateAllApps', 'update'],
    ['startAllApps', 'start'],
    ['stopAllApps', 'stop'],
    ['restartAllApps', 'restart'],
  ] as const)('%s sweeps as the actor for %s', async (sweep, action) => {
    await controller[sweep](req);

    expect(whois.lifecycleActor).toHaveBeenCalledWith(req, action);
    expect(lifecycle[sweep]).toHaveBeenCalledWith(actor);
  });
});

describe('AppLifecycleController restore status', () => {
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;
  const base = { completed: false, state: null, restoreIntent: false, checking: false, noticePending: false };

  let rehydration: MockProxy<AppRehydrationService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let pairingRestore: MockProxy<PairingAppRestoreService>;
  let controller: AppLifecycleController;

  beforeEach(() => {
    rehydration = mock<AppRehydrationService>();
    whois = mock<MarketplaceWhoIsService>();
    pairingRestore = mock<PairingAppRestoreService>();
    controller = new AppLifecycleController(mock<AppLifecycleService>(), rehydration, mock<HubAccessService>(), whois, pairingRestore);
  });

  it('asks whether this person may manage the Hub, from the role stored at their sign-in', async () => {
    whois.hubManageHint.mockResolvedValue(true);
    rehydration.getRestoreStatus.mockImplementation(async (mayManage) => ({ ...base, noticePending: await mayManage() }));

    const status = await controller.getRehydrateStatus(req);

    expect(whois.hubManageHint).toHaveBeenCalledWith(req);
    expect(status).toMatchObject({ noticePending: true });
    // `null` is not something the generated client can express.
    expect(status).not.toHaveProperty('state');
  });

  // Someone is signed in and waiting on the answer; the next background pass is up to 15 s away.
  it('asks the apps check to run now while a pairing waits on it', async () => {
    rehydration.getRestoreStatus.mockResolvedValue({ ...base, checking: true });

    await controller.getRehydrateStatus(req);

    expect(pairingRestore.requestCheck).toHaveBeenCalledTimes(1);
  });

  it('leaves the apps check to its own schedule otherwise', async () => {
    rehydration.getRestoreStatus.mockResolvedValue(base);

    await controller.getRehydrateStatus(req);

    expect(pairingRestore.requestCheck).not.toHaveBeenCalled();
  });

  it('records that the restore was seen by someone the status route held on the restore page', async () => {
    whois.hubManageHint.mockResolvedValue(true);

    await expect(controller.acknowledgeRestore(req)).resolves.toEqual({ success: true });

    expect(whois.hubManageHint).toHaveBeenCalledWith(req);
    expect(rehydration.acknowledgeRestore).toHaveBeenCalled();
  });

  it('refuses someone the notice was not for', async () => {
    whois.hubManageHint.mockResolvedValue(false);

    await expect(controller.acknowledgeRestore(req)).rejects.toThrow('HUB_MANAGE_ROLE_REQUIRED');

    expect(rehydration.acknowledgeRestore).not.toHaveBeenCalled();
  });
});
