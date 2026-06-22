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
});
