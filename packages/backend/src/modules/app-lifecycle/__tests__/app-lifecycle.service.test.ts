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

      registrationService.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-id', tunnelId: 'tunnel-id' } as any);
      appsRepository.getApps.mockResolvedValue([]);
      configService.getConfig.mockReturnValue({ userSettings: { localDomain: 'lan' } } as any);

      await service.invokeCommand(data, reply);

      expect(mutex.acquire).toHaveBeenCalledWith('test-app');
      expect(command.execute).toHaveBeenCalledWith('test-app', expect.anything());
      expect(cloudflareClientService.syncState).toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith({ success: true, message: 'OK' });
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
});
