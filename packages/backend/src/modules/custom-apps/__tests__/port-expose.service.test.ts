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
import { TranslatableError } from '@/common/error/translatable-error';

vi.mock('../port-expose-reachability', () => ({
  assertHubCanReachPort: vi.fn().mockResolvedValue(undefined),
}));

import { assertHubCanReachPort } from '../port-expose-reachability';

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
      if (key === 'directories') return { dataDir: '/data', appDataDir: '/app-data' } as any;
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
      expect(filesystem.createDirectories).toHaveBeenCalledWith(['/data/apps/_user/my-workload', '/app-data/_user/my-workload']);
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
      ).rejects.toMatchObject({ message: 'CUSTOM_APP_NAME_NO_SLUG' });
    });

    it('throws when the derived slug is reserved', async () => {
      await expect(
        service.createPortExposeApp({
          name: 'Create',
          port: 8080,
          exposureMode: 'local',
        }),
      ).rejects.toMatchObject({ message: 'CUSTOM_APP_NAME_RESERVED' });
    });

    it('throws when cloudflare mode is missing a subdomain', async () => {
      await expect(
        service.createPortExposeApp({
          name: 'my-workload',
          port: 8080,
          exposureMode: 'cloudflare',
        }),
      ).rejects.toMatchObject({ message: 'PORT_EXPOSE_SUBDOMAIN_REQUIRED' });
    });

    it('throws when app name already exists', async () => {
      appsRepository.getAppByUrn.mockResolvedValue({ id: 1 } as any);

      await expect(
        service.createPortExposeApp({
          name: 'my-workload',
          port: 8080,
          exposureMode: 'local',
        }),
      ).rejects.toMatchObject({ message: 'CUSTOM_APP_ERROR_DUPLICATE_NAME' });
    });

    // `my-workload` here is `my-workload-_user`, the id of app `my` from a store `workload-_user`.
    it('refuses a name whose app id an installed app already has, before anything is written', async () => {
      appsRepository.getApps.mockResolvedValue([{ appName: 'my', appStoreSlug: 'workload-_user' }] as any);

      await expect(service.createPortExposeApp({ name: 'my-workload', port: 8080, exposureMode: 'local' })).rejects.toMatchObject({
        message: 'APP_ERROR_APP_ID_IN_USE',
      });
      expect(filesystem.createDirectories).not.toHaveBeenCalled();
      expect(appsRepository.createApp).not.toHaveBeenCalled();
    });

    it('does not publish a port the Hub cannot open', async () => {
      vi.mocked(assertHubCanReachPort).mockRejectedValueOnce(
        new TranslatableError('PORT_EXPOSE_PORT_UNREACHABLE', { port: '18765', host: 'host.docker.internal' }, 400),
      );

      await expect(
        service.createPortExposeApp({
          name: 'QA Probe',
          port: 18765,
          exposureMode: 'local',
        }),
      ).rejects.toMatchObject({ message: 'PORT_EXPOSE_PORT_UNREACHABLE' });

      expect(appsRepository.createApp).not.toHaveBeenCalled();
      expect(traefikConfigService.syncPortExposeRoutes).not.toHaveBeenCalled();
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
      ).rejects.toMatchObject({ message: 'PORT_EXPOSE_SUBDOMAIN_REQUIRED' });
    });

    it('throws when another app already uses the port', async () => {
      appsRepository.getAppsByPort.mockResolvedValue([{ appName: 'other-app' }] as any);

      await expect(
        service.updatePortExposeApp('my-workload:_user', {
          port: 9090,
          exposureMode: 'local',
        }),
      ).rejects.toMatchObject({ message: 'APP_ERROR_PORT_ALREADY_IN_USE' });
    });

    /*
     * Switching to Public Web under the same subdomain: the tunnel sync claims the very row the registry
     * pinned, so a registry `remove` sent after it released the row and the record the sync had just
     * made (#2144). The old entry has to go first.
     */
    it('removes the This Machine Only entry before the public sync claims its name', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);

      await service.updatePortExposeApp('my-workload:_user', {
        port: 8080,
        exposureMode: 'cloudflare',
        localSubdomain: 'my-workload',
        publicDomain: 'example.com',
      });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledTimes(1);
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [{ name: 'my-workload', slug: 'my-workload', port: 8080, publicDomain: undefined, remove: true }],
      });
      expect(portalClient.postDeviceApplicationsRegistry.mock.invocationCallOrder[0]).toBeLessThan(
        exposureSyncService.syncExposurePublic.mock.invocationCallOrder[0] ?? 0,
      );
    });

    // Built from the updated row, the `remove` named the new subdomain and the old entry stayed (#2144).
    it('removes the old entry under its old subdomain when the switch picks a new one', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);

      await service.updatePortExposeApp('my-workload:_user', {
        port: 8080,
        exposureMode: 'cloudflare',
        localSubdomain: 'my-workload-web',
        publicDomain: 'example.com',
      });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ apps: [expect.objectContaining({ slug: 'my-workload', remove: true })] }),
      );
    });

    it('updates the entry in place when a This Machine Only port moves to the Private VPN', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      appsRepository.getAppByUrn.mockResolvedValueOnce(existingApp as any).mockResolvedValue({ ...existingApp, exposureMode: 'tailscale' } as any);

      await service.updatePortExposeApp('my-workload:_user', { port: 8080, exposureMode: 'tailscale' });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledTimes(1);
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [{ name: 'my-workload', slug: 'my-workload', port: 8080, publicDomain: undefined, kind: PORT_EXPOSE_KIND, exposureMode: 'tailscale' }],
      });
    });

    it('moves the entry when a This Machine Only port changes subdomain', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      appsRepository.getAppByUrn.mockResolvedValueOnce(existingApp as any).mockResolvedValue({ ...existingApp, localSubdomain: 'renamed' } as any);

      await service.updatePortExposeApp('my-workload:_user', { port: 8080, exposureMode: 'local', localSubdomain: 'renamed' });

      const posted = portalClient.postDeviceApplicationsRegistry.mock.calls.map(([payload]) => payload.apps[0]);
      expect(posted).toEqual([
        expect.objectContaining({ slug: 'my-workload', remove: true }),
        expect.objectContaining({ slug: 'renamed', exposureMode: 'local' }),
      ]);
    });

    // Public to This Machine Only: the sync releases the public row, then the registry pins the new one.
    it('registers a public port that moves to This Machine Only after the sync, removing nothing', async () => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
      const publicApp = { ...existingApp, exposureMode: 'cloudflare', localSubdomain: 'my-workload', publicDomain: 'example.com' };
      appsRepository.getAppByUrn.mockResolvedValueOnce(publicApp as any).mockResolvedValue(existingApp as any);

      await service.updatePortExposeApp('my-workload:_user', { port: 8080, exposureMode: 'local' });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledTimes(1);
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ apps: [expect.not.objectContaining({ remove: true })] }),
      );
      expect(exposureSyncService.syncExposurePublic.mock.invocationCallOrder[0]).toBeLessThan(
        portalClient.postDeviceApplicationsRegistry.mock.invocationCallOrder[0] ?? 0,
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

  /*
   * A port exposed This Machine Only or on the Private VPN reaches Companion Portal only through the
   * registry, so that is where its kind and mode go for a reinstalled Hub to put it back (#2131).
   */
  describe('registry entries for exposed ports', () => {
    const portExposeRow = (appName: string, exposureMode: string, port: number | null = 8091, extra: Record<string, unknown> = {}) =>
      ({
        appName,
        appStoreSlug: '_user',
        localSubdomain: appName,
        exposureMode,
        port,
        publicDomain: null,
        config: { kind: PORT_EXPOSE_KIND },
        ...extra,
      }) as any;

    beforeEach(() => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
    });

    it('sends the kind and mode when a This Machine Only port is exposed', async () => {
      appsRepository.getAppByUrn.mockResolvedValueOnce(null as any).mockResolvedValue(portExposeRow('notes', 'local'));

      await service.createPortExposeApp({ name: 'notes', port: 8091, exposureMode: 'local' });

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [{ name: 'notes', slug: 'notes', port: 8091, publicDomain: undefined, kind: PORT_EXPOSE_KIND, exposureMode: 'local' }],
      });
    });

    it('names the row and nothing more when it removes one', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(portExposeRow('notes', 'tailscale'));
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null as any);

      await service.beforePortExposeUninstall('notes:_user');

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [{ name: 'notes', slug: 'notes', port: 8091, publicDomain: undefined, remove: true }],
      });
    });

    it('sends every This Machine Only and Private VPN port at once and nothing else', async () => {
      appsRepository.getApps.mockResolvedValue([
        portExposeRow('notes', 'tailscale'),
        portExposeRow('dev', 'local', 8092),
        portExposeRow('game', 'cloudflare', 3080),
        portExposeRow('broken', 'local', null),
        // Its entry was removed when the uninstall began. Sent again, it would stay pinned once the app is gone.
        portExposeRow('gone', 'local', 8093, { status: 'uninstalling' }),
        { ...portExposeRow('wordpress', 'local', 8080), appStoreSlug: 'ci-marketplace', config: {} },
      ]);

      await service.syncAllPortalRegistryEntries();

      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledTimes(1);
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [
          { name: 'notes', slug: 'notes', port: 8091, publicDomain: undefined, kind: PORT_EXPOSE_KIND, exposureMode: 'tailscale' },
          { name: 'dev', slug: 'dev', port: 8092, publicDomain: undefined, kind: PORT_EXPOSE_KIND, exposureMode: 'local' },
        ],
      });
    });

    // A save through the generic config route rewrites the stored form without `kind`.
    it('finds an exposed port by its config.json when its stored form lost the kind', async () => {
      appsRepository.getApps.mockResolvedValue([{ ...portExposeRow('notes', 'tailscale'), config: {} }]);
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ kind: PORT_EXPOSE_KIND } as any);

      await service.syncAllPortalRegistryEntries();

      expect(appFilesManager.getInstalledAppInfo).toHaveBeenCalledWith('notes:_user');
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith(
        expect.objectContaining({ apps: [expect.objectContaining({ name: 'notes', kind: PORT_EXPOSE_KIND, exposureMode: 'tailscale' })] }),
      );
    });

    it('sends nothing when there is nothing to send, or the Hub is not registered', async () => {
      await service.syncAllPortalRegistryEntries();

      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null as any);
      appsRepository.getApps.mockResolvedValue([portExposeRow('notes', 'tailscale')]);
      await service.syncAllPortalRegistryEntries();

      expect(portalClient.postDeviceApplicationsRegistry).not.toHaveBeenCalled();
    });
  });

  /*
   * The tunnel sync never releases a row the registry pinned, so after a reinstall the entry for a port
   * the restore could not bring back stayed on the Portal for good (#2134).
   */
  describe('releaseUnrestoredRegistryEntries', () => {
    const portalEntry = (name: string, extra: Record<string, unknown> = {}) =>
      ({ id: `id-${name}`, name, slug: name, port: 8091, publicDomain: null, pinned: true, ...extra }) as any;

    beforeEach(() => {
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({ id: 'org-1' } as any);
    });

    it('removes the pinned entries this Hub has no app for, in one request', async () => {
      appsRepository.getApps.mockResolvedValue([{ appName: 'wordpress', appStoreSlug: 'ci-marketplace', localSubdomain: null } as any]);

      const released = await service.releaseUnrestoredRegistryEntries([
        portalEntry('notes'),
        portalEntry('old', { port: 8092 }),
        portalEntry('game', { pinned: false }),
        portalEntry('legacy', { pinned: undefined }),
      ]);

      expect(released).toEqual(['notes', 'old']);
      expect(portalClient.postDeviceApplicationsRegistry).toHaveBeenCalledWith({
        organizationId: 'org-1',
        apps: [
          { name: 'notes', slug: 'notes', port: 8091, remove: true },
          { name: 'old', slug: 'old', port: 8092, remove: true },
        ],
      });
    });

    // The registry removes by slug. A public app on the same subdomain shares the row: removing it would take that app's address.
    it('leaves an entry whose name or slug an app here uses', async () => {
      appsRepository.getApps.mockResolvedValue([
        { appName: 'notes', appStoreSlug: '_user', localSubdomain: 'notes' } as any,
        { appName: 'blog', appStoreSlug: 'ci-marketplace', localSubdomain: 'myblog' } as any,
        { appName: 'wiki', appStoreSlug: 'ci-marketplace', localSubdomain: null } as any,
      ]);

      const released = await service.releaseUnrestoredRegistryEntries([
        portalEntry('notes'),
        portalEntry('blogpin', { slug: 'myblog' }),
        portalEntry('wikipin', { slug: 'wiki-ci-marketplace' }),
      ]);

      expect(released).toEqual([]);
      expect(portalClient.postDeviceApplicationsRegistry).not.toHaveBeenCalled();
    });
  });
});
