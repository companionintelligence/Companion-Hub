import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { readPairingAppCheck, readRehydrationState } from '@/modules/app-lifecycle/registration-recovery-state';
import { CloudflareHostnameService } from '../cloudflare-hostname.service';

vi.mock('@/modules/app-lifecycle/registration-recovery-state', () => ({
  readPairingAppCheck: vi.fn(),
  readRehydrationState: vi.fn(),
}));

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

  /*
   * After a re-pair the Hub holds its sync until the restored apps settle, so the Portal still holds the
   * names it had before the reinstall. One of those that did not come back may be taken again (#2133).
   */
  describe('isOwnNameFromBeforePairing', () => {
    const pairedAt = '2026-10-25T05:00:00.000Z';
    const restoreRan = { completedAt: '2026-10-25T05:01:00.000Z', queuedUrns: [], startedUrns: [], skipped: [] };
    const row = (appName: string, localSubdomain: string | null, appStoreSlug = 'ci-marketplace') =>
      ({ appName, appStoreSlug, localSubdomain }) as never;

    beforeEach(() => {
      vi.mocked(readPairingAppCheck).mockResolvedValue({
        markedAt: pairedAt,
        restore: { startedAt: pairedAt, portalAppNames: ['wordpress', 'mynginx'] },
      });
      vi.mocked(readRehydrationState).mockResolvedValue(restoreRan);
      appsRepository.getApps.mockResolvedValue([row('wordpress', 'wordpress'), row('wiki', null)]);
    });

    it('is true for a name no app here routes on, once this pairing has restored its apps', async () => {
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(true);
    });

    it('is false for a name an app here routes on, by its subdomain or by its default one', async () => {
      await expect(service.isOwnNameFromBeforePairing('wordpress')).resolves.toBe(false);
      await expect(service.isOwnNameFromBeforePairing('WordPress')).resolves.toBe(false);
      await expect(service.isOwnNameFromBeforePairing('wiki-ci-marketplace')).resolves.toBe(false);
    });

    // A restore puts an app back as local when the Portal kept no domain for it. Exposed again, it takes its own name back.
    it('does not count the app being set up against its own name', async () => {
      await expect(service.isOwnNameFromBeforePairing('wordpress', 'wordpress:ci-marketplace' as never)).resolves.toBe(true);
      await expect(service.isOwnNameFromBeforePairing('wordpress', 'wiki:ci-marketplace' as never)).resolves.toBe(false);
    });

    it('counts a restore that finished the moment the pairing was marked', async () => {
      vi.mocked(readRehydrationState).mockResolvedValueOnce({ ...restoreRan, completedAt: pairedAt });
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(true);
    });

    it('is false outside the wait after a pairing, or before it decided to restore', async () => {
      vi.mocked(readPairingAppCheck).mockResolvedValueOnce(null);
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(false);

      vi.mocked(readPairingAppCheck).mockResolvedValueOnce({ markedAt: pairedAt });
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(false);
    });

    // Before the run, an app the restore is about to bring back has no row yet, and its name looks free.
    it("is false until this pairing's restore has run", async () => {
      vi.mocked(readRehydrationState).mockResolvedValueOnce(null);
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(false);

      vi.mocked(readRehydrationState).mockResolvedValueOnce({ ...restoreRan, completedAt: '2026-10-24T05:00:00.000Z' });
      await expect(service.isOwnNameFromBeforePairing('mynginx')).resolves.toBe(false);
    });

    it('is false for a name with nothing a subdomain can hold', async () => {
      await expect(service.isOwnNameFromBeforePairing('...')).resolves.toBe(false);
    });
  });
});
