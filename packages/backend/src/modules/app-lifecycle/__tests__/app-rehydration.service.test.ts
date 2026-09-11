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
    vi.mocked(buildRehydrationPlan).mockReturnValue(installPlan);

    lifecycle = mock<AppLifecycleService>();
    users = mock<UserRepository>();
    const registration = mock<RegistrationService>();
    registration.getLiveRegistrationStatus.mockResolvedValue({ phase: 'publicly_ready' } as never);
    const cloudflare = mock<CloudflareClientService>();
    cloudflare.getDeviceApplications.mockResolvedValue([{ name: 'immich' }] as never);
    const marketplace = mock<MarketplaceService>();
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

  it('reports an install refused for this person, and does not record the run as done', async () => {
    lifecycle.installApp.mockRejectedValue(refusal());

    const result = await service.executeRehydrate({ source: 'restore', operatorUserId: 7, actor: OPERATOR });

    expect(result).toMatchObject({ success: true, incomplete: true, queued: [], started: [] });
    expect(result.skipped).toEqual([{ name: 'Immich', reason: 'APP_ACTION_GRANT_DENIED' }]);
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
    expect(result).toMatchObject({ incomplete: false, skipped: [{ name: 'Immich', reason: expect.stringContaining('in progress') }] });
  });
});
