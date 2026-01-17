import { Test } from '@nestjs/testing';
import { AppLifecycleService } from './app-lifecycle.service';
import { AppStoreService } from '../app-stores/app-store.service';
import { ReposHelpers } from '../app-stores/repos.helpers';
import { AppsService } from '../apps/apps.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { BackupManager } from '../backups/backup.manager';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { RegistrationService } from '../registration/registration.service';
import { AppEventsQueue } from '../queue/entities/app-events';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mock, mockDeep } from 'vitest-mock-extended';

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;

  // Mocks
  const configService = mock<ConfigurationService>();
  const loggerService = mockDeep<LoggerService>();
  const sseService = mock<SSEService>();
  const appFilesManager = mock<AppFilesManager>();
  const appsRepository = mock<AppsRepository>();
  const appsService = mock<AppsService>();
  const backupManager = mock<BackupManager>();
  const cloudflareClientService = mock<CloudflareClientService>();
  const marketplaceService = mock<MarketplaceService>();
  const registrationService = mock<RegistrationService>();
  const reposHelpers = mock<ReposHelpers>();
  const appStoreService = mock<AppStoreService>();
  const appEventsQueue = mock<AppEventsQueue>();
  const commandFactory = mock<AppLifecycleCommandFactory>();
  const asyncMutex = { run: vi.fn((fn) => fn()) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppLifecycleService,
        { provide: ConfigurationService, useValue: configService },
        { provide: LoggerService, useValue: loggerService },
        { provide: SSEService, useValue: sseService },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: AppsRepository, useValue: appsRepository },
        { provide: AppsService, useValue: appsService },
        { provide: BackupManager, useValue: backupManager },
        { provide: CloudflareClientService, useValue: cloudflareClientService },
        { provide: MarketplaceService, useValue: marketplaceService },
        { provide: RegistrationService, useValue: registrationService },
        { provide: ReposHelpers, useValue: reposHelpers },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: AppEventsQueue, useValue: appEventsQueue },
        { provide: AppLifecycleCommandFactory, useValue: commandFactory },
        { provide: APP_ASYNC_MUTEX, useValue: asyncMutex },
      ],
    }).compile();

    service = moduleRef.get<AppLifecycleService>(AppLifecycleService);

    // Mock config
    configService.getConfig.mockReturnValue({
      demoMode: false,
      version: '1.0.0',
      architecture: 'amd64',
    } as any);

    // Mock generic repositories
    // @ts-expect-error
    appEventsQueue.publish.mockResolvedValue({ success: true, message: 'ok' });
    // @ts-expect-error
    appsRepository.createApp.mockResolvedValue({ id: 'new-app-id', status: 'installing' });
    // @ts-expect-error
    appsRepository.updateAppById.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('installApp with ci_cloud_api', () => {
    it('should download files before install', async () => {
      const appId = 'cloud-app';
      const storeId = 'ci-cloud';

      // Mock Command Factory to return a mock command execution
      const installCommand = { execute: vi.fn().mockResolvedValue(undefined) };
      commandFactory.createInstallCommand.mockReturnValue(installCommand as any);

      // @ts-expect-error
      appStoreService.getAppStoreBySlug.mockResolvedValue({
        id: '1',
        slug: storeId,
        type: 'ci_cloud_api',
        url: 'http://cloud.api',
      });

      // Mock Marketplace Service (NOT appsService)
      // @ts-expect-error
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        id: appId,
        slug: appId,
        repo: { slug: storeId },
        supported_architectures: ['amd64'],
        port: 8080,
        tipi_version: 1,
      });

      reposHelpers.downloadAppFiles.mockResolvedValue({ success: true });

      await service.installApp({
        appUrn: `${appId}:${storeId}`,
        form: { version: '1.0.0' },
      } as any);

      expect(reposHelpers.downloadAppFiles).toHaveBeenCalledWith('http://cloud.api', storeId, appId);
    });

    it('should throw error if download fails', async () => {
      const appId = 'paid-app';
      const storeId = 'ci-cloud';

      // @ts-expect-error
      appStoreService.getAppStoreBySlug.mockResolvedValue({
        id: '1',
        slug: storeId,
        type: 'ci_cloud_api',
        url: 'http://cloud.api',
      });

      // Mock Marketplace Service
      // @ts-expect-error
      marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue({
        id: appId,
        slug: appId,
        repo: { slug: storeId },
        supported_architectures: ['amd64'],
      });

      reposHelpers.downloadAppFiles.mockResolvedValue({
        success: false,
        message: 'Payment Required',
      });

      await expect(
        service.installApp({
          appUrn: `${appId}:${storeId}`,
          form: {},
        } as any),
      ).rejects.toThrow('Payment Required');
    });
  });
});
