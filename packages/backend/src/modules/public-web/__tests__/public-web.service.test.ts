import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Test } from '@nestjs/testing';
import type { AppUrn } from '@ci-hub/common/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PublicWebService } from '../public-web.service';

describe('PublicWebService', () => {
  let service: PublicWebService;
  const appsRepository = mock<AppsRepository>();
  const appFilesManager = mock<AppFilesManager>();
  const appHelpers = mock<AppHelpers>();
  const appLifecycleService = mock<AppLifecycleService>();
  const registrationService = mock<RegistrationService>();
  const config = mock<ConfigurationService>();
  const envUtils = mock<EnvUtils>();
  const logger = mock<LoggerService>();

  const appUrn = createAppUrn('nextcloud', 'store') as AppUrn;

  beforeEach(async () => {
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PublicWebService,
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppHelpers, useValue: appHelpers },
        { provide: AppLifecycleService, useValue: appLifecycleService },
        { provide: RegistrationService, useValue: registrationService },
        { provide: ConfigurationService, useValue: config },
        { provide: EnvUtils, useValue: envUtils },
        { provide: LoggerService, useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(PublicWebService);

    config.getConfig.mockReturnValue({
      domain: 'example.com',
      userSettings: { domain: 'example.com' },
    } as any);

    registrationService.getDeviceRegistrationInfo.mockResolvedValue({
      slug: 'myorg',
      hubSubdomain: 'hub-dev1-myorg',
    } as any);
  });

  it('reports env mismatch in diagnostics', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: 'example.com',
      },
    ] as any);

    appFilesManager.getAppEnv.mockResolvedValue({
      path: '/tmp/env',
      content: 'APP_PUBLIC_HOSTNAME=nextcloud-wrong.example.com\nAPP_PUBLIC_DOMAIN=example.com\n',
    });
    envUtils.envStringToMap.mockReturnValue(
      new Map([
        ['APP_PUBLIC_HOSTNAME', 'nextcloud-wrong.example.com'],
        ['APP_PUBLIC_DOMAIN', 'example.com'],
      ]),
    );

    const result = await service.getDiagnostics();

    expect(result.mismatchCount).toBe(1);
    expect(result.apps[0]).toMatchObject({
      appUrn,
      computedHostname: 'nextcloud-dev1-myorg.example.com',
      envHostname: 'nextcloud-wrong.example.com',
      envMismatch: true,
      action: 'repair',
    });
  });

  it('does not report mismatch when env domain collapses to config root', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: null,
      },
    ] as any);

    appFilesManager.getAppEnv.mockResolvedValue({
      path: '/tmp/env',
      content: 'APP_PUBLIC_HOSTNAME=nextcloud-dev1-myorg.example.com\nAPP_PUBLIC_DOMAIN=dev-acme.example.com\n',
    });
    envUtils.envStringToMap.mockReturnValue(
      new Map([
        ['APP_PUBLIC_HOSTNAME', 'nextcloud-dev1-myorg.example.com'],
        ['APP_PUBLIC_DOMAIN', 'dev-acme.example.com'],
      ]),
    );

    const result = await service.getDiagnostics();

    expect(result.mismatchCount).toBe(0);
    expect(result.apps[0]).toMatchObject({
      computedHostname: 'nextcloud-dev1-myorg.example.com',
      envHostname: 'nextcloud-dev1-myorg.example.com',
      envMismatch: false,
      action: 'ok',
    });
  });

  it('treats a bound custom domain as the correct hostname', async () => {
    // Comparing against the platform hostname instead would report every app on
    // a custom domain as permanently broken, and repair would rewrite the value
    // the sync just set — the two would fight on every pass.
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: 'example.com',
        customDomain: 'cloud.acme.com',
      },
    ] as any);

    appFilesManager.getAppEnv.mockResolvedValue({ path: '/tmp/env', content: 'APP_PUBLIC_HOSTNAME=cloud.acme.com\n' });
    envUtils.envStringToMap.mockReturnValue(new Map([['APP_PUBLIC_HOSTNAME', 'cloud.acme.com']]));

    const result = await service.getDiagnostics();

    expect(result.mismatchCount).toBe(0);
    expect(result.apps[0]).toMatchObject({
      computedHostname: 'cloud.acme.com',
      computedPublicUrl: 'https://cloud.acme.com',
      customDomain: 'cloud.acme.com',
      envMismatch: false,
      action: 'ok',
    });
  });

  it('flags an app still on the platform hostname after a domain was bound', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: 'example.com',
        customDomain: 'cloud.acme.com',
      },
    ] as any);

    appFilesManager.getAppEnv.mockResolvedValue({ path: '/tmp/env', content: 'APP_PUBLIC_HOSTNAME=nextcloud-dev1-myorg.example.com\n' });
    envUtils.envStringToMap.mockReturnValue(new Map([['APP_PUBLIC_HOSTNAME', 'nextcloud-dev1-myorg.example.com']]));

    const result = await service.getDiagnostics();

    expect(result.mismatchCount).toBe(1);
    expect(result.apps[0]).toMatchObject({ computedHostname: 'cloud.acme.com', envMismatch: true, action: 'repair' });
  });

  it('does not call a scheduled restart "repair"', async () => {
    // The sync deliberately does not recreate a running container: it binds the
    // row and raises pendingRestart. Reporting that designed window as a fault
    // would have `repair` with no appUrns restart apps the operator never chose.
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: 'example.com',
        customDomain: 'cloud.acme.com',
        pendingRestart: true,
      },
    ] as any);

    appFilesManager.getAppEnv.mockResolvedValue({ path: '/tmp/env', content: 'APP_PUBLIC_HOSTNAME=nextcloud-dev1-myorg.example.com\n' });
    envUtils.envStringToMap.mockReturnValue(new Map([['APP_PUBLIC_HOSTNAME', 'nextcloud-dev1-myorg.example.com']]));

    const result = await service.getDiagnostics();

    expect(result.mismatchCount).toBe(0);
    // The drift is still reported — it is what the badge is about — only the
    // verdict waits for the restart the user was already asked for.
    expect(result.apps[0]).toMatchObject({ envMismatch: true, pendingRestart: true, action: 'ok' });
  });

  it('repairs mismatched apps and triggers cloudflare sync', async () => {
    appsRepository.getApps.mockResolvedValue([
      {
        appName: 'nextcloud',
        appStoreSlug: 'store',
        status: 'running',
        exposureMode: 'cloudflare',
        exposedLocal: true,
        openPort: false,
        localSubdomain: 'nextcloud',
        publicDomain: 'example.com',
        config: { exposureMode: 'cloudflare', exposedLocal: true },
        enableAuth: true,
      },
    ] as any);

    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      appName: 'nextcloud',
      appStoreSlug: 'store',
      status: 'running',
      exposureMode: 'cloudflare',
      exposedLocal: true,
      openPort: false,
      localSubdomain: 'nextcloud',
      publicDomain: 'example.com',
      config: { exposureMode: 'cloudflare', exposedLocal: true },
      enableAuth: true,
    } as any);

    appFilesManager.getAppEnv.mockResolvedValue({
      path: '/tmp/env',
      content: 'APP_PUBLIC_HOSTNAME=stale.example.com\n',
    });
    envUtils.envStringToMap.mockReturnValue(new Map([['APP_PUBLIC_HOSTNAME', 'stale.example.com']]));
    envUtils.envMapToString.mockReturnValue('APP_PUBLIC_HOSTNAME=nextcloud-dev1-myorg.example.com\n');

    const result = await service.repair({ appUrns: [appUrn] });

    expect(appHelpers.generateEnvFile).toHaveBeenCalledWith(appUrn, expect.any(Object));
    expect(appFilesManager.writeAppEnv).toHaveBeenCalled();
    expect(appLifecycleService.restartApp).toHaveBeenCalledWith({ appUrn, skipPull: true });
    expect(appLifecycleService.triggerCloudflareSync).toHaveBeenCalled();
    expect(result.synced).toBe(true);
    expect(result.results[0]?.success).toBe(true);
  });
  /**
   * The repair route rewrites an app's env and restarts it, so the controller hands
   * `repair` the caller's grant check. It has to run BEFORE any app is touched:
   * denying halfway would leave part of the fleet repaired behind a 403.
   */
  describe('authorization hook', () => {
    const runningApp = {
      id: 1,
      appName: 'nextcloud',
      appStoreSlug: 'store',
      status: 'running',
      exposureMode: 'cloudflare',
      exposedLocal: true,
      openPort: false,
      localSubdomain: 'nextcloud',
      publicDomain: 'example.com',
      config: { exposureMode: 'cloudflare', exposedLocal: true },
      enableAuth: true,
    };

    beforeEach(() => {
      appsRepository.getApps.mockResolvedValue([runningApp] as any);
      appsRepository.getAppByUrn.mockResolvedValue(runningApp as any);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/tmp/env', content: 'APP_PUBLIC_HOSTNAME=stale.example.com\n' });
      envUtils.envStringToMap.mockReturnValue(new Map([['APP_PUBLIC_HOSTNAME', 'stale.example.com']]));
      envUtils.envMapToString.mockReturnValue('APP_PUBLIC_HOSTNAME=nextcloud-dev1-myorg.example.com\n');
    });

    it('asks the caller for permission on every app it is about to repair', async () => {
      const authorize = vi.fn().mockResolvedValue(undefined);

      const result = await service.repair({ appUrns: [appUrn] }, authorize);

      expect(authorize).toHaveBeenCalledWith(appUrn);
      expect(result.results[0]?.success).toBe(true);
    });

    it('touches nothing when permission is refused for any app in the batch', async () => {
      // Two drifted apps, allowed then denied. Checking permission app-by-app inside
      // the repair loop would already have rewritten and restarted the FIRST one by
      // the time the second is refused, so the assertion that matters is that the
      // allowed app is untouched too.
      const secondUrn = createAppUrn('immich', 'store') as AppUrn;
      appsRepository.getApps.mockResolvedValue([runningApp, { ...runningApp, id: 2, appName: 'immich', localSubdomain: 'immich' }] as any);

      const authorize = vi.fn(async (urn: AppUrn) => {
        if (urn === secondUrn) throw new Error('APP_ACTION_GRANT_DENIED');
      });

      await expect(service.repair({ appUrns: [appUrn, secondUrn] }, authorize)).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(authorize).toHaveBeenCalledWith(appUrn);
      expect(appHelpers.generateEnvFile).not.toHaveBeenCalled();
      expect(appFilesManager.writeAppEnv).not.toHaveBeenCalled();
      expect(appLifecycleService.restartApp).not.toHaveBeenCalled();
      expect(appLifecycleService.triggerCloudflareSync).not.toHaveBeenCalled();
    });

    it('repairs as before when no hook is supplied, so the CLI is unaffected', async () => {
      const result = await service.repair({ appUrns: [appUrn] });

      expect(appLifecycleService.restartApp).toHaveBeenCalledWith({ appUrn, skipPull: true });
      expect(result.results[0]?.success).toBe(true);
    });
  });
});
