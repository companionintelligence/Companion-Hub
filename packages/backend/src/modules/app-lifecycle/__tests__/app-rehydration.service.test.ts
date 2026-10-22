import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { UserRepository } from '@/modules/user/user.repository';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from '../app-lifecycle.service';
import { buildRehydrationPlan, type RehydrationPlan, type RehydrationStateFile } from '../app-rehydration';
import { AppRehydrationService } from '../app-rehydration.service';
import * as recovery from '../registration-recovery-state';

vi.mock('../registration-recovery-state', () => ({
  readRehydrationState: vi.fn(),
  writeRehydrationState: vi.fn(),
  hasRestoreIntent: vi.fn(),
  clearRestoreIntent: vi.fn(),
  readPairingAppCheck: vi.fn(),
  readRestoreNotice: vi.fn(),
  acknowledgeRestoreNotice: vi.fn(),
}));

// The plan is built by `buildRehydrationPlan`; here it is an input.
vi.mock('../app-rehydration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-rehydration')>()),
  scanLocalAppData: vi.fn(() => []),
  resolvePortalAppToUrn: vi.fn(() => 'immich:ci-marketplace'),
  buildRehydrationPlan: vi.fn(),
}));

/*
 * Rehydrate reinstalls every app the Portal lists for this device. It used to call `installApp` with no
 * gate at all — the org-role check lived only in the HTTP install route (CI-Hub#1397). It now installs
 * AS the person who asked, so an app they may not install is skipped and reported; and because that
 * refusal is about who asked, not about the app, the run is not recorded as done.
 */
describe('AppRehydrationService.executeRehydrate', () => {
  const appUrn = 'immich:ci-marketplace' as AppUrn;
  const OPERATOR: LifecycleActor = { kind: 'operator', userId: 7 };
  const installPlan = {
    portalAppCount: 1,
    localAppDataCount: 0,
    items: [{ action: 'install', appUrn, form: { port: 8080 }, portalApp: { name: 'Immich', slug: 'immich' }, hasExistingData: false }],
  } as unknown as RehydrationPlan;
  const refusal = () => new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'install', app: 'immich' }, HttpStatus.FORBIDDEN);

  let lifecycle: MockProxy<AppLifecycleService>;
  let users: MockProxy<UserRepository>;
  let cloudflare: MockProxy<CloudflareClientService>;
  let marketplace: MockProxy<MarketplaceService>;
  let service: AppRehydrationService;

  beforeEach(async () => {
    vi.clearAllMocks();

    // The state file, in memory: a run recorded as done must read back as done.
    let stateFile: RehydrationStateFile | null = null;
    vi.mocked(recovery.writeRehydrationState).mockImplementation(async (state) => {
      stateFile = state;
    });
    vi.mocked(recovery.readRehydrationState).mockImplementation(async () => stateFile);
    vi.mocked(recovery.hasRestoreIntent).mockResolvedValue(true);
    vi.mocked(recovery.clearRestoreIntent).mockResolvedValue(undefined);
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue(null);
    vi.mocked(buildRehydrationPlan).mockReturnValue(installPlan);

    lifecycle = mock<AppLifecycleService>();
    users = mock<UserRepository>();
    const registration = mock<RegistrationService>();
    registration.getLiveRegistrationStatus.mockResolvedValue({ phase: 'publicly_ready' } as never);
    cloudflare = mock<CloudflareClientService>();
    cloudflare.getDeviceApplications.mockResolvedValue([{ name: 'immich' }] as never);
    marketplace = mock<MarketplaceService>();
    marketplace.getAvailableAppUrns.mockResolvedValue([appUrn] as never);
    const appStores = mock<AppStoreService>();
    appStores.getEnabledAppStores.mockResolvedValue([{ slug: 'ci-marketplace' }] as never);
    const apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([]);
    const files = mock<AppFilesManager>();
    files.getAppPaths.mockReturnValue({ appInstalledDir: '/nonexistent/immich' } as never);

    const module = await Test.createTestingModule({
      providers: [
        AppRehydrationService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ConfigurationService, useValue: { getConfig: () => ({ ciHubApiKey: 'device-key' }) } },
        { provide: RegistrationService, useValue: registration },
        { provide: CloudflareClientService, useValue: cloudflare },
        { provide: AppStoreService, useValue: appStores },
        { provide: MarketplaceService, useValue: marketplace },
        { provide: AppsRepository, useValue: apps },
        { provide: AppFilesManager, useValue: files },
        { provide: AppLifecycleService, useValue: lifecycle },
        { provide: UserRepository, useValue: users },
      ],
    }).compile();
    service = module.get(AppRehydrationService);
  });

  it('installs as the person who asked, and records a clean run as done', async () => {
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(lifecycle.installApp).toHaveBeenCalledWith({ appUrn, form: { port: 8080 }, actor: OPERATOR });
    expect(result).toMatchObject({ success: true, incomplete: false, queued: [appUrn], skipped: [] });
    expect(recovery.writeRehydrationState).toHaveBeenCalledWith(expect.objectContaining({ completedAt: expect.any(String), queuedUrns: [appUrn] }));
    expect(recovery.clearRestoreIntent).toHaveBeenCalled();
  });

  // Dropped before the plan, such an app was missing from the record and so from the summary the next sign-in shows.
  it('records an app the Portal lists that no store here does as not restored', async () => {
    cloudflare.getDeviceApplications.mockResolvedValue([{ name: 'immich' }, { name: 'my-wiki' }] as never);
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    const unlisted = { name: 'my-wiki', reason: 'No matching marketplace app found for Portal application', code: 'unlisted' };
    expect(result).toMatchObject({ queued: [appUrn], skipped: [unlisted] });
    expect(recovery.writeRehydrationState).toHaveBeenCalledWith(expect.objectContaining({ queuedUrns: [appUrn], skipped: [unlisted] }));
  });

  it('reports an install refused for this person, and does not record the run as done', async () => {
    lifecycle.installApp.mockRejectedValue(refusal());

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result).toMatchObject({ success: true, incomplete: true, queued: [], started: [] });
    expect(result.skipped).toEqual([
      { name: 'Immich', reason: 'APP_ACTION_GRANT_DENIED', appUrn, code: 'refused', params: { action: 'install', app: 'immich' } },
    ]);
    // Recorded as done, the refusal was final: nothing retried it without `force`.
    expect(recovery.writeRehydrationState).not.toHaveBeenCalled();
    // The intent is cleared all the same — left standing, it holds Cloudflare sync for the whole Hub.
    expect(recovery.clearRestoreIntent).toHaveBeenCalled();
    expect(users.updateUser).toHaveBeenCalledWith(7, { hasCompletedOnboarding: true });
  });

  it('retries a refused install on the next rehydrate, without force', async () => {
    const owner: LifecycleActor = { kind: 'operator', userId: 1 };
    lifecycle.installApp.mockRejectedValueOnce(refusal()).mockResolvedValueOnce({ requestId: 'r' } as never);

    await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });
    const again = await service.executeRehydrate({ operatorUserId: 1, actor: owner });

    expect(again.alreadyCompleted).toBeUndefined();
    expect(lifecycle.installApp).toHaveBeenLastCalledWith({ appUrn, form: { port: 8080 }, actor: owner });
    expect(again).toMatchObject({ incomplete: false, queued: [appUrn] });
  });

  it('still records the run as done when an install fails for any other reason', async () => {
    lifecycle.installApp.mockRejectedValue(new Error('APP_ERROR_PORT_ALREADY_IN_USE'));

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result).toMatchObject({ incomplete: false, skipped: [{ name: 'Immich', reason: 'APP_ERROR_PORT_ALREADY_IN_USE' }] });
    expect(recovery.writeRehydrationState).toHaveBeenCalled();
  });

  /*
   * The restore sends only what the Portal keeps for an app, its address and port. Kimai's admin
   * password has no default, so its install form is refused on every restore. The log said
   * `APP_INSTALL_FORM_ERROR_INVALID` and nothing told the person which settings were missing.
   */
  it('keeps the form fields an install was refused for, so the restore can say what is missing', async () => {
    lifecycle.installApp.mockRejectedValue(
      new TranslatableError('APP_INSTALL_FORM_ERROR_INVALID', { fields: 'Admin Password' }, HttpStatus.BAD_REQUEST),
    );

    const result = await service.executeRehydrate({ actor: { kind: 'system', reason: 'restore-after-pairing' } });

    const expected = { name: 'Immich', reason: 'APP_INSTALL_FORM_ERROR_INVALID', appUrn, code: 'failed', params: { fields: 'Admin Password' } };
    expect(result.skipped).toEqual([expected]);
    expect(recovery.writeRehydrationState).toHaveBeenCalledWith(expect.objectContaining({ skipped: [expected] }));
  });

  it('starts an installed app as the person who asked, and keeps a refused start open for retry', async () => {
    const startPlan = {
      portalAppCount: 1,
      localAppDataCount: 1,
      items: [{ action: 'start', appUrn, form: { port: 8080 }, portalApp: { name: 'Immich', slug: 'immich' }, hasExistingData: true }],
    } as unknown as RehydrationPlan;
    vi.mocked(buildRehydrationPlan).mockReturnValue(startPlan);
    lifecycle.startApp.mockRejectedValue(new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'start', app: 'immich' }, HttpStatus.FORBIDDEN));

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(lifecycle.startApp).toHaveBeenCalledWith({ appUrn, skipPull: true, actor: OPERATOR });
    expect(result).toMatchObject({ incomplete: true, started: [], skipped: [{ name: 'Immich', reason: 'APP_ACTION_GRANT_DENIED' }] });
    // Reported as a refused start, not an install: the app is installed and only needed starting.
    expect(result.message).toBe('Queued 0 install(s) and 0 start(s) from Portal; 1 start(s) were refused for this account');
    expect(recovery.writeRehydrationState).not.toHaveBeenCalled();
  });

  it('leaves an app the last run is still working on to that operation', async () => {
    // What a Retry plans for an app the first run queued: installing it again would start it mid-install.
    const busyPlan = {
      portalAppCount: 1,
      localAppDataCount: 0,
      items: [
        {
          action: 'skip_busy',
          appUrn,
          reason: 'An operation is already in progress for this app (installing)',
          form: { port: 8080 },
          portalApp: { name: 'Immich', slug: 'immich' },
          hasExistingData: false,
        },
      ],
    } as unknown as RehydrationPlan;
    vi.mocked(buildRehydrationPlan).mockReturnValue(busyPlan);

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(lifecycle.installApp).not.toHaveBeenCalled();
    expect(lifecycle.startApp).not.toHaveBeenCalled();
    expect(result).toMatchObject({ incomplete: false, skipped: [{ name: 'Immich', reason: expect.stringContaining('in progress'), code: 'busy' }] });
  });
  /*
   * After a pairing the Hub restores on its own, and the restore page asks too. Both used to plan from
   * rows the other had not written, and queue the same installs twice.
   */
  it('joins a run already under way instead of queueing its installs again', async () => {
    let finishInstall: () => void = () => {};
    lifecycle.installApp.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInstall = () => resolve({ requestId: 'r' } as never);
        }),
    );

    const byHub = service.executeRehydrate({ actor: { kind: 'system', reason: 'restore-after-pairing' } });
    await vi.waitFor(() => expect(lifecycle.installApp).toHaveBeenCalled());
    const byPage = service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });
    finishInstall();

    const [hubResult, pageResult] = await Promise.all([byHub, byPage]);

    expect(lifecycle.installApp).toHaveBeenCalledTimes(1);
    expect(pageResult).toBe(hubResult);
    // The person on the page still finishes the restore flow.
    expect(users.updateUser).toHaveBeenCalledWith(7, { hasCompletedOnboarding: true });
  });

  it('finishes the restore flow for a person who arrives after the Hub restored on its own', async () => {
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    await service.executeRehydrate({ actor: { kind: 'system', reason: 'restore-after-pairing' } });
    expect(users.updateUser).not.toHaveBeenCalled();

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result.alreadyCompleted).toBe(true);
    expect(lifecycle.installApp).toHaveBeenCalledTimes(1);
    expect(users.updateUser).toHaveBeenCalledWith(7, { hasCompletedOnboarding: true });
    expect(recovery.clearRestoreIntent).toHaveBeenCalled();
  });

  // `cihub register` re-pairs without a registration reset, so the last pairing's record is still there.
  it("restores again for this pairing when the only finished record is an earlier pairing's", async () => {
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    await service.executeRehydrate({ actor: { kind: 'system', reason: 'restore-after-pairing' } });
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue({ startedAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result.alreadyCompleted).toBeUndefined();
    expect(lifecycle.installApp).toHaveBeenCalledTimes(2);
  });

  it('reports a finished run even when the Portal cannot be asked for its plan', async () => {
    lifecycle.installApp.mockResolvedValue({ requestId: 'r' } as never);
    await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });
    cloudflare.getDeviceApplications.mockRejectedValue(new Error('socket hang up'));

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result).toMatchObject({ success: true, alreadyCompleted: true, plan: { items: [], portalAppCount: 0 } });
  });

  // An unanswered read and an empty catalog both used to finish with nothing installed; the next sync then released every app.
  it('does not record a run when the Portal cannot be asked for the apps', async () => {
    cloudflare.getDeviceApplications.mockRejectedValue(new Error("Could not read this device's apps from CI Portal: 503"));

    await expect(service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR })).rejects.toThrow('503');

    expect(recovery.writeRehydrationState).not.toHaveBeenCalled();
    expect(lifecycle.installApp).not.toHaveBeenCalled();
  });

  it('does not record a run when the app catalog has not been downloaded', async () => {
    marketplace.getAvailableAppUrns.mockResolvedValue([]);

    await expect(service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR })).rejects.toThrow('app catalog');

    expect(recovery.writeRehydrationState).not.toHaveBeenCalled();
    expect(lifecycle.installApp).not.toHaveBeenCalled();
  });
});

/*
 * After a pairing the Hub restores the device's apps with nobody signed in. Whether the next sign-in
 * showed the restore used to depend on a choice one browser kept, so any other browser, the CLI or
 * the desktop app got the setup wizard on a Hub that had its apps back. A failed app went unsaid.
 */
describe('AppRehydrationService restore status', () => {
  const kimai = 'kimai:ci-marketplace';
  const excalidraw = 'excalidraw:ci-marketplace';
  const openclaw = 'ci-openclaw:ci-marketplace';
  const finishedRun: RehydrationStateFile = {
    completedAt: new Date().toISOString(),
    queuedUrns: [excalidraw, openclaw],
    startedUrns: [],
    skipped: [
      { name: 'kimai', reason: 'APP_INSTALL_FORM_ERROR_INVALID', appUrn: kimai, code: 'failed', params: { fields: 'Admin Password' } },
      { name: 'cyberchef', reason: 'App is already running locally', appUrn: 'cyberchef:ci-marketplace', code: 'already_running' },
      { name: 'my-wiki', reason: 'No matching marketplace app found for Portal application', code: 'unlisted' },
    ],
  };
  const listings: Record<string, { name: string; categories?: string[] }> = {
    [kimai]: { name: 'Kimai' },
    [excalidraw]: { name: 'Excalidraw' },
    // As CI-Marketplace lists it: no `ai` category and no inference mapping, yet an agent the Hub hands a model.
    [openclaw]: { name: 'OpenClaw', categories: ['development'] },
    'cyberchef:ci-marketplace': { name: 'CyberChef' },
  };

  let users: MockProxy<UserRepository>;
  let preferredModel: string | null;
  let service: AppRehydrationService;

  beforeEach(async () => {
    vi.clearAllMocks();
    preferredModel = null;
    vi.mocked(recovery.readRehydrationState).mockResolvedValue(finishedRun);
    vi.mocked(recovery.hasRestoreIntent).mockResolvedValue(false);
    vi.mocked(recovery.readPairingAppCheck).mockResolvedValue({
      markedAt: finishedRun.completedAt,
      restore: { startedAt: finishedRun.completedAt, portalAppNames: [] },
    });
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue({ startedAt: finishedRun.completedAt });

    users = mock<UserRepository>();
    const marketplace = mock<MarketplaceService>();
    marketplace.getAppInfoFromAppStoreOrInstalled.mockImplementation(async (urn) => listings[urn] as never);
    const apps = mock<AppsRepository>();
    apps.getApps.mockResolvedValue([
      { appName: 'excalidraw', appStoreSlug: 'ci-marketplace', status: 'running' },
      { appName: 'ci-openclaw', appStoreSlug: 'ci-marketplace', status: 'installing' },
      { appName: 'cyberchef', appStoreSlug: 'ci-marketplace', status: 'running' },
    ] as never);

    const module = await Test.createTestingModule({
      providers: [
        AppRehydrationService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        {
          provide: ConfigurationService,
          useValue: { getConfig: () => ({ ciHubApiKey: 'device-key' }), getInferencePreferences: () => ({ preferredModel }) },
        },
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
        { provide: AppStoreService, useValue: mock<AppStoreService>() },
        { provide: MarketplaceService, useValue: marketplace },
        { provide: AppsRepository, useValue: apps },
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: AppLifecycleService, useValue: mock<AppLifecycleService>() },
        { provide: UserRepository, useValue: users },
      ],
    }).compile();
    service = module.get(AppRehydrationService);
  });

  it('shows someone who may manage the Hub what the restore brought back and what it could not, until they have seen it', async () => {
    const status = await service.getRestoreStatus(async () => true);

    expect(status).toMatchObject({ completed: true, checking: false, noticePending: true });
    expect(status.summary).toEqual({
      completedAt: finishedRun.completedAt,
      restored: [
        { name: 'Excalidraw', urn: excalidraw, status: 'running', usesAi: false },
        { name: 'OpenClaw', urn: openclaw, status: 'installing', usesAi: true },
        { name: 'CyberChef', urn: 'cyberchef:ci-marketplace', status: 'running', usesAi: false },
      ],
      notRestored: [
        { name: 'Kimai', urn: kimai, reason: 'APP_INSTALL_FORM_ERROR_INVALID', code: 'failed', params: { fields: 'Admin Password' } },
        { name: 'my-wiki', reason: 'No matching marketplace app found for Portal application', code: 'unlisted' },
      ],
      aiModelChosen: false,
    });
  });

  it('says whether a chat model has been chosen, since restored AI apps use the recommended one until then', async () => {
    preferredModel = 'gemma3-270m';

    const status = await service.getRestoreStatus(async () => true);

    expect(status.summary?.aiModelChosen).toBe(true);
  });

  it('keeps the notice from a member, who is not offered the setup wizard either', async () => {
    const status = await service.getRestoreStatus(async () => false);

    expect(status.noticePending).toBe(false);
    expect(status.summary).toBeUndefined();
  });

  it('does not ask about the person, or show anything, once the restore has been seen', async () => {
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue({ startedAt: finishedRun.completedAt, acknowledgedAt: new Date().toISOString() });
    const mayManage = vi.fn(async () => true);

    const status = await service.getRestoreStatus(mayManage);

    expect(status).toMatchObject({ noticePending: false });
    expect(status.summary).toBeUndefined();
    expect(mayManage).not.toHaveBeenCalled();
  });

  it('reports a restore under way, with no summary until it has finished', async () => {
    vi.mocked(recovery.readRehydrationState).mockResolvedValue(null);

    const status = await service.getRestoreStatus(async () => true);

    expect(status).toMatchObject({ completed: false, noticePending: true, checking: false });
    expect(status.summary).toBeUndefined();
  });

  it("does not show an earlier pairing's restore while this pairing's is still running", async () => {
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue({ startedAt: new Date(Date.parse(finishedRun.completedAt) + 60_000).toISOString() });

    const status = await service.getRestoreStatus(async () => true);

    expect(status).toMatchObject({ noticePending: true });
    expect(status.summary).toBeUndefined();
  });

  // Restore was chosen for a device the Portal lists no apps for. "Your apps could not be restored" said otherwise.
  it('opens setup instead of a summary when the restore found no app to bring back', async () => {
    vi.mocked(recovery.readRehydrationState).mockResolvedValue({ ...finishedRun, queuedUrns: [], startedUrns: [], skipped: [] });
    const mayManage = vi.fn(async () => true);

    const status = await service.getRestoreStatus(mayManage);

    expect(status).toMatchObject({ completed: true, noticePending: false });
    expect(status.summary).toBeUndefined();
    expect(mayManage).not.toHaveBeenCalled();
  });

  it('reports a pairing whose apps check has not decided yet', async () => {
    vi.mocked(recovery.readRehydrationState).mockResolvedValue(null);
    vi.mocked(recovery.readRestoreNotice).mockResolvedValue(null);
    vi.mocked(recovery.readPairingAppCheck).mockResolvedValue({ markedAt: new Date().toISOString() });

    await expect(service.getRestoreStatus(async () => true)).resolves.toMatchObject({ checking: true, noticePending: false });
  });

  it('skips the setup wizard for every operator once a finished restore has been seen', async () => {
    await service.acknowledgeRestore();

    expect(recovery.acknowledgeRestoreNotice).toHaveBeenCalled();
    expect(users.markApplianceOnboardingComplete).toHaveBeenCalled();
  });

  it('leaves the setup wizard when the restore found no app to bring back', async () => {
    vi.mocked(recovery.readRehydrationState).mockResolvedValue({ ...finishedRun, queuedUrns: [], startedUrns: [], skipped: [] });

    await service.acknowledgeRestore();

    expect(recovery.acknowledgeRestoreNotice).toHaveBeenCalled();
    expect(users.markApplianceOnboardingComplete).not.toHaveBeenCalled();
  });

  it('leaves the setup wizard when the restore never finished', async () => {
    vi.mocked(recovery.readRehydrationState).mockResolvedValue(null);

    await service.acknowledgeRestore();

    expect(recovery.acknowledgeRestoreNotice).toHaveBeenCalled();
    expect(users.markApplianceOnboardingComplete).not.toHaveBeenCalled();
  });
});
