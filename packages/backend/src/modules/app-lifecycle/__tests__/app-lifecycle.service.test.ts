import { Test, TestingModule } from '@nestjs/testing';
import { AppLifecycleService } from '../app-lifecycle.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { AppLifecycleCommandFactory } from '../app-lifecycle-command.factory';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { ConfigurationService } from '@/core/config/configuration.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppsService } from '@/modules/apps/apps.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { SSEService } from '@/core/sse/sse.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ReposHelpers } from '@/modules/app-stores/repos.helpers';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;
  let logger: MockProxy<LoggerService>;
  let appEventsQueue: MockProxy<AppEventsQueue>;
  let commandFactory: MockProxy<AppLifecycleCommandFactory>;
  let appsRepository: MockProxy<AppsRepository>;
  let configService: MockProxy<ConfigurationService>;
  let marketplaceService: MockProxy<MarketplaceService>;
  let appsService: MockProxy<AppsService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let sseService: MockProxy<SSEService>;
  let backupManager: MockProxy<BackupManager>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;
  let registrationService: MockProxy<RegistrationService>;
  let reposHelpers: MockProxy<ReposHelpers>;
  let appStoreService: MockProxy<AppStoreService>;
  let mutex: any;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    appEventsQueue = mock<AppEventsQueue>();
    commandFactory = mock<AppLifecycleCommandFactory>();
    appsRepository = mock<AppsRepository>();
    configService = mock<ConfigurationService>();
    marketplaceService = mock<MarketplaceService>();
    appsService = mock<AppsService>();
    appFilesManager = mock<AppFilesManager>();
    sseService = mock<SSEService>();
    backupManager = mock<BackupManager>();
    cloudflareClientService = mock<CloudflareClientService>();
    registrationService = mock<RegistrationService>();
    reposHelpers = mock<ReposHelpers>();
    appStoreService = mock<AppStoreService>();

    const release = vi.fn();
    mutex = {
      acquire: vi.fn().mockResolvedValue(release),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppLifecycleService,
        { provide: LoggerService, useValue: logger },
        { provide: AppEventsQueue, useValue: appEventsQueue },
        { provide: AppLifecycleCommandFactory, useValue: commandFactory },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: ConfigurationService, useValue: configService },
        { provide: MarketplaceService, useValue: marketplaceService },
        { provide: AppsService, useValue: appsService },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: SSEService, useValue: sseService },
        { provide: BackupManager, useValue: backupManager },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: RegistrationService, useValue: registrationService },
        { provide: ReposHelpers, useValue: reposHelpers },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: APP_ASYNC_MUTEX, useValue: mutex },
      ],
    }).compile();

    configService.getConfig.mockReturnValue({ isProduction: false, userSettings: { localDomain: 'lan' } } as any);

    service = module.get<AppLifecycleService>(AppLifecycleService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should subscribe to queue on init', () => {
    expect(appEventsQueue.onEvent).toHaveBeenCalled();
  });

  describe('invokeCommand', () => {
    it('should execute command and sync cloudflare on success', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'org-slug',
        name: 'Org Label',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({ userSettings: { localDomain: 'lan' } } as any);

      await service.invokeCommand(data, reply);

      expect(mutex.acquire).toHaveBeenCalledWith('test-app');
      expect(command.execute).toHaveBeenCalledWith('test-app', expect.anything());
      expect(cloudflareClientService.syncState).toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith({ success: true, message: 'OK' });
    });

    it('should include Hub route as OS Hub in cloudflare sync payload', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'myorg',
        name: 'My Org',
        hubSubdomain: 'mydevice-myorg',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-id',
        expect.arrayContaining([
          expect.objectContaining({
            name: 'OS Hub',
            subdomain: 'mydevice',
            localPort: 80,
            hostname: 'traefik',
            originServerName: 'mydevice-myorg.companionintelligence.com',
            isHub: true,
          }),
        ]),
        'tunnel-id',
      );
    });

    it('should include Hub route alongside exposed apps', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'acme',
        name: 'Acme Corp',
        hubSubdomain: 'hub1-acme',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'n8n',
          exposedLocal: true,
          status: 'running',
          localSubdomain: 'n8n-abc',
          appStoreSlug: 'ci-marketplace',
        },
      ] as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'companionintelligence.com', localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      const syncCall = cloudflareClientService.syncState.mock.calls[0];
      const apps = syncCall?.[1] as any[];

      // Hub should be first with correct hostname
      expect(apps[0]).toMatchObject({ name: 'OS Hub', subdomain: 'hub1', originServerName: 'hub1-acme.companionintelligence.com', isHub: true });
      // Exposed app should follow
      expect(apps[1]).toMatchObject({ name: 'n8n', subdomain: 'n8n-abc' });
    });

    it('should not include Hub route when hubSubdomain is not set', async () => {
      const data = { appUrn: 'test-app', action: 'install', form: {} } as any;
      const reply = vi.fn();
      const command = { execute: vi.fn().mockResolvedValue({ success: true, message: 'OK' }) };

      commandFactory.createCommand.mockReturnValue(command as any);

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-id',
        tunnelId: 'tunnel-id',
        slug: 'myorg',
        name: 'My Org',
      } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({
        userSettings: { localDomain: 'lan' },
        domain: 'companionintelligence.com',
      } as any);

      await service.invokeCommand(data, reply);

      const syncCall = cloudflareClientService.syncState.mock.calls[0];
      const apps = syncCall?.[1] as any[];
      expect(apps).toHaveLength(0);
    });

    it('should handle errors during execution', async () => {
      const data = { appUrn: 'test-app', action: 'install' } as any;
      const reply = vi.fn();
      commandFactory.createCommand.mockImplementation(() => {
        throw new Error('Exec failed');
      });

      await service.invokeCommand(data, reply);
      expect(reply).toHaveBeenCalledWith({ success: false, message: 'Error: Exec failed' });
    });
  });

  describe('installApp', () => {
    const appUrn = 'testapp:ci-marketplace' as any;
    const baseAppInfo = {
      id: 'testapp',
      urn: 'urn:app:testapp',
      name: 'Test App',
      port: 8080,
      tipi_version: 1,
      exposable: true,
      supported_architectures: ['amd64'],
    };

    beforeEach(() => {
      configService.getConfig.mockReturnValue({
        isProduction: false,
        architecture: 'amd64',
        version: '1.0.0',
        userSettings: { localDomain: 'lan', guestDashboard: false },
      } as any);
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(baseAppInfo as any);
      appsRepository.getAppsByDomain.mockResolvedValue([]);
      appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
      appsRepository.getAppsByPort.mockResolvedValue([]);
      appsRepository.createApp.mockImplementation(async (data: any) => ({ id: 1, ...data }));
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      appFilesManager.getAppEnvMap.mockReturnValue(new Map());
      reposHelpers.downloadAppFiles.mockResolvedValue({ files: {} } as any);
    });

    it('MUST persist exposureMode=cloudflare when provided in form', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'cloudflare', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'cloudflare' }));
    });

    it('MUST persist exposureMode=tailscale when provided in form', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'tailscale', exposedLocal: true } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'tailscale' }));
    });

    it('MUST default exposureMode to local when not provided', async () => {
      await service.installApp({ appUrn, form: {} });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });

    it('MUST persist exposureMode=local explicitly when provided', async () => {
      await service.installApp({ appUrn, form: { exposureMode: 'local' } });

      expect(appsRepository.createApp).toHaveBeenCalledWith(expect.objectContaining({ exposureMode: 'local' }));
    });
  });

  describe('startApp', () => {
    it('should start existing app', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'stopped' };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      await service.startApp({ appUrn });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { status: 'starting' });
      expect(sseService.emit).toHaveBeenCalledWith('app', expect.objectContaining({ event: 'status_change', appStatus: 'starting' }));
    });

    it('should throw if app not found', async () => {
      appsRepository.getAppByUrn.mockResolvedValue(null as any);
      await expect(service.startApp({ appUrn: 'missing' as any })).rejects.toThrow('APP_ERROR_APP_NOT_FOUND');
    });
  });

  describe('syncCloudflareState - device slug in hostname', () => {
    it('should include device slug in publicHostname when hubSubdomain has different device slug', async () => {
      // Setup: org with hubSubdomain hub-test1-myorg
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-1',
        slug: 'myorg',
        hubSubdomain: 'hub-test1-myorg',
        tunnelId: 'tunnel-123',
        tunnelToken: 'token',
      } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'element',
          appStoreSlug: 'store1',
          localSubdomain: 'element',
          exposedLocal: true,
          status: 'running',
          port: 80,
        },
      ] as any);

      await service.syncExposurePublic();

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-1',
        expect.arrayContaining([
          expect.objectContaining({
            originServerName: 'element-test1-myorg.example.com',
          }),
        ]),
        'tunnel-123',
      );
    });

    it('should omit device slug when it equals org slug', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({
        id: 'org-1',
        slug: 'myorg',
        hubSubdomain: 'hub-myorg-myorg',
        tunnelId: 'tunnel-123',
        tunnelToken: 'token',
      } as any);
      configService.getConfig.mockReturnValue({
        userSettings: { domain: 'example.com' },
        domain: 'example.com',
      } as any);
      appsRepository.getApps.mockResolvedValue([
        {
          appName: 'element',
          appStoreSlug: 'store1',
          localSubdomain: 'element',
          exposedLocal: true,
          status: 'running',
          port: 80,
        },
      ] as any);

      await service.syncExposurePublic();

      expect(cloudflareClientService.syncState).toHaveBeenCalledWith(
        'org-1',
        expect.arrayContaining([
          expect.objectContaining({
            originServerName: 'element-myorg.example.com',
          }),
        ]),
        'tunnel-123',
      );
    });
  });
});
