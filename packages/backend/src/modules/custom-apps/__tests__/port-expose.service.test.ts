import { Test, TestingModule } from '@nestjs/testing';
import { PortExposeService } from '../port-expose.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { ExposureSyncService } from '@/modules/app-lifecycle/exposure-sync.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { PORT_EXPOSE_KIND } from '@ci-hub/common/schemas';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('PortExposeService', () => {
  let service: PortExposeService;
  let filesystem: MockProxy<FilesystemService>;
  let configService: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let traefikConfigService: MockProxy<TraefikConfigService>;
  let exposureSyncService: MockProxy<ExposureSyncService>;
  let portalClient: MockProxy<PortalClientService>;
  let deviceRegistrationRepository: MockProxy<DeviceRegistrationRepository>;
  let logger: MockProxy<LoggerService>;

  beforeEach(async () => {
    filesystem = mock<FilesystemService>();
    configService = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    appFilesManager = mock<AppFilesManager>();
    traefikConfigService = mock<TraefikConfigService>();
    exposureSyncService = mock<ExposureSyncService>();
    portalClient = mock<PortalClientService>();
    deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
    logger = mock<LoggerService>();

    configService.get.mockImplementation((key) => {
      if (key === 'directories') return { dataDir: '/data' } as any;
      if (key === 'demoMode') return false;
      return null;
    });
    configService.getConfig.mockReturnValue({
      userSettings: { localDomain: 'local.test' },
      localDomain: 'local.test',
    } as any);

    filesystem.createDirectory.mockResolvedValue(true);
    filesystem.createDirectories.mockResolvedValue(true);
    filesystem.writeJsonFile.mockResolvedValue(true);
    filesystem.writeTextFile.mockResolvedValue(true);
    appsRepository.getAppByUrn.mockResolvedValue(null as any);
    appsRepository.getAppsByPort.mockResolvedValue([]);
    appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
    appsRepository.getApps.mockResolvedValue([]);
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null as any);
    traefikConfigService.syncPortExposeRoutes.mockResolvedValue(undefined);
    exposureSyncService.syncExposurePublic.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortExposeService,
        { provide: FilesystemService, useValue: filesystem },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: TraefikConfigService, useValue: traefikConfigService },
        { provide: ExposureSyncService, useValue: exposureSyncService },
        { provide: PortalClientService, useValue: portalClient },
        { provide: DeviceRegistrationRepository, useValue: deviceRegistrationRepository },
        { provide: LoggerService, useValue: logger },
      ],
    }).compile();

    service = module.get<PortExposeService>(PortExposeService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createPortExposeApp', () => {
    it('creates a local port-expose workload with kind in persisted config', async () => {
      const result = await service.createPortExposeApp({
        name: 'my-workload',
        port: 8080,
        exposureMode: 'local',
      });

      expect(result.appUrn).toBe('my-workload:_user');
      expect(appsRepository.createApp).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            kind: PORT_EXPOSE_KIND,
            port: 8080,
            exposureMode: 'local',
          }),
        }),
      );
      expect(traefikConfigService.syncPortExposeRoutes).toHaveBeenCalled();
    });

    it('derives a URL-safe slug from a free-form display name', async () => {
      const result = await service.createPortExposeApp({
        name: 'Adguard Home Sync',
        port: 8080,
        exposureMode: 'local',
      });

      expect(result.appUrn).toBe('adguard-home-sync:_user');
      expect(result.appName).toBe('adguard-home-sync');
      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ appName: 'adguard-home-sync' }));
    });

    it('throws when the display name has no slug-able characters', async () => {
      await expect(
        service.createPortExposeApp({
          name: '///',
          port: 8080,
          exposureMode: 'local',
        }),
      ).rejects.toThrow('CUSTOM_APP_NAME_NO_SLUG');
    });

    it('throws when the derived slug is reserved', async () => {
      await expect(
        service.createPortExposeApp({
          name: 'Create',
          port: 8080,
          exposureMode: 'local',
        }),
      ).rejects.toThrow('CUSTOM_APP_NAME_RESERVED');
    });

    it('throws when cloudflare mode is missing a subdomain', async () => {
      await expect(
        service.createPortExposeApp({
          name: 'my-workload',
          port: 8080,
          exposureMode: 'cloudflare',
        }),
      ).rejects.toThrow('PORT_EXPOSE_SUBDOMAIN_REQUIRED');
    });

    it('throws when app name already exists', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await expect(
        service.createPortExposeApp({
          name: 'my-workload',
          port: 8080,
          exposureMode: 'local',
        }),
      ).rejects.toThrow('CUSTOM_APP_ERROR_DUPLICATE_NAME');
    });
  });

  describe('updatePortExposeApp', () => {
    const existingApp = {
      id: 7,
      appName: 'my-workload',
      appStoreSlug: '_user',
      exposureMode: 'local',
      port: 8080,
      localSubdomain: 'my-workload',
      config: { kind: PORT_EXPOSE_KIND, port: 8080, exposureMode: 'local' },
    };

    beforeEach(() => {
      appsRepository.getAppByUrn.mockResolvedValue(existingApp as any);
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ kind: PORT_EXPOSE_KIND, port: 8080, upstreamPort: 8080 } as any);
      filesystem.readJsonFile.mockResolvedValue({ kind: PORT_EXPOSE_KIND, port: 8080, upstreamPort: 8080 } as any);
      appsRepository.updateAppById.mockResolvedValue(existingApp as any);
    });

    it('updates port and exposure settings for an existing workload', async () => {
      await service.updatePortExposeApp('my-workload:_user', {
        port: 9090,
        exposureMode: 'local',
      });

      expect(filesystem.writeJsonFile).toHaveBeenCalledWith(
        expect.stringContaining('config.json'),
        expect.objectContaining({ port: 9090, upstreamPort: 9090 }),
      );
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          port: 9090,
          exposureMode: 'local',
          status: 'running',
        }),
      );
      expect(traefikConfigService.syncPortExposeRoutes).toHaveBeenCalled();
      expect(exposureSyncService.syncExposurePublic).toHaveBeenCalled();
    });

    it('throws when cloudflare mode is missing a subdomain', async () => {
      await expect(
        service.updatePortExposeApp('my-workload:_user', {
          port: 8080,
          exposureMode: 'cloudflare',
        }),
      ).rejects.toThrow('PORT_EXPOSE_SUBDOMAIN_REQUIRED');
    });

    it('throws when another app already uses the port', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'other-app' }] as any);

      await expect(
        service.updatePortExposeApp('my-workload:_user', {
          port: 9090,
          exposureMode: 'local',
        }),
      ).rejects.toThrow('APP_ERROR_PORT_ALREADY_IN_USE');
    });

    it('removes portal registry entry when switching from local to cloudflare', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);

      await service.updatePortExposeApp('my-workload:_user', {
        port: 8080,
        exposureMode: 'cloudflare',
        localSubdomain: 'my-workload',
        publicDomain: 'example.com',
      });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          apps: [expect.objectContaining({ remove: true })],
        }),
      );
    });
  });

  describe('beforePortExposeUninstall', () => {
    it('syncs portal registry removal for local workloads identified by config kind', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        exposureMode: 'local',
        config: { kind: PORT_EXPOSE_KIND },
      } as any);
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null as any);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);

      await service.beforePortExposeUninstall('my-workload:_user');

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          apps: [expect.objectContaining({ remove: true })],
        }),
      );
    });
  });
});
