import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { CloudflareHostnameService } from '../cloudflare-hostname.service';

describe('CloudflareHostnameService', () => {
  let service: CloudflareHostnameService;
  let appsRepository: MockProxy<AppsRepository>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let configurationService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CloudflareHostnameService,
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: DeviceRegistrationRepository, useValue: mock<DeviceRegistrationRepository>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
      ],
    }).compile();

    service = moduleRef.get(CloudflareHostnameService);
    appsRepository = moduleRef.get(AppsRepository);
    deviceRegistrationRepository = moduleRef.get(DeviceRegistrationRepository);
    configurationService = moduleRef.get(ConfigurationService);
    configurationService.getConfig.mockReturnValue({ domain: 'companionintelligence.com' } as ReturnType<ConfigurationService['getConfig']>);
  });

  it('returns true when the requested hostname matches the current app hostname', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      appName: 'dropgate',
      appStoreSlug: 'store',
      exposureMode: 'cloudflare',
      localSubdomain: 'dropgate',
      publicDomain: 'companionintelligence.com',
    } as never);
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
      slug: 'devben',
      hubSubdomain: 'hub-nvda-devben',
    } as never);

    await expect(service.resolvesToExistingAppHostname('dropgate', 'companionintelligence.com', 'dropgate:store')).resolves.toBe(true);
  });

  it('returns false when the requested hostname changes', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      appName: 'dropgate',
      appStoreSlug: 'store',
      exposureMode: 'cloudflare',
      localSubdomain: 'dropgate',
      publicDomain: 'companionintelligence.com',
    } as never);
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
      slug: 'devben',
      hubSubdomain: 'hub-nvda-devben',
    } as never);

    await expect(service.resolvesToExistingAppHostname('changed', 'companionintelligence.com', 'dropgate:store')).resolves.toBe(false);
  });

  it('returns false for non-cloudflare apps or missing edits', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      appName: 'dropgate',
      appStoreSlug: 'store',
      exposureMode: 'local',
    } as never);

    await expect(service.resolvesToExistingAppHostname('dropgate', 'companionintelligence.com', 'dropgate:store')).resolves.toBe(false);
    await expect(service.resolvesToExistingAppHostname('dropgate', 'companionintelligence.com')).resolves.toBe(false);
  });

  it('treats legacy exposedLocal apps as cloudflare when matching the current hostname', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      appName: 'dropgate',
      appStoreSlug: 'store',
      exposedLocal: true,
      localSubdomain: 'dropgate',
      publicDomain: 'companionintelligence.com',
    } as never);
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
      slug: 'devben',
      hubSubdomain: 'hub-nvda-devben',
    } as never);

    await expect(service.resolvesToExistingAppHostname('dropgate', 'companionintelligence.com', 'dropgate:store')).resolves.toBe(true);
  });
});
