import { Test, TestingModule } from '@nestjs/testing';
import { BackupsService } from '../backups.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppEventsQueue } from '@/modules/queue/entities/app-events';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { BackupManager } from '../backup.manager';
import { SSEService } from '@/core/sse/sse.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('BackupsService', () => {
  let service: BackupsService;
  let appsRepository: MockProxy<AppsRepository>;
  let logger: MockProxy<LoggerService>;
  let configService: MockProxy<ConfigurationService>;
  let appEventsQueue: MockProxy<AppEventsQueue>;
  let appLifecycle: MockProxy<AppLifecycleService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let backupManager: MockProxy<BackupManager>;
  let sseService: MockProxy<SSEService>;

  beforeEach(async () => {
    appsRepository = mock<AppsRepository>();
    logger = mock<LoggerService>();
    configService = mock<ConfigurationService>();
    appEventsQueue = mock<AppEventsQueue>();
    appLifecycle = mock<AppLifecycleService>();
    appFilesManager = mock<AppFilesManager>();
    backupManager = mock<BackupManager>();
    sseService = mock<SSEService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: AppsRepository, useValue: appsRepository },
        { provide: LoggerService, useValue: logger },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppEventsQueue, useValue: appEventsQueue },
        { provide: AppLifecycleService, useValue: appLifecycle },
        { provide: AppFilesManager, useValue: appFilesManager },
        { provide: BackupManager, useValue: backupManager },
        { provide: SSEService, useValue: sseService },
      ],
    }).compile();

    service = module.get<BackupsService>(BackupsService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('backupApp', () => {
    it('should backup app successfully', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'running', config: {} };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);
      configService.get.mockReturnValue(false); // No demo mode

      await service.backupApp({ appUrn });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'backing_up' }));
      expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({ command: 'backup', appUrn }));

      // Since it's fire-and-forget promise chain, we wait a bit or trust it runs if no error?
      // With mockResolvedValue, the .then() runs immediately effectively in microtasks.
      // But let's check expectations.
      // It should call startApp if it was running.
      // Wait, we need to ensure the promise chain executes.
      // In JS, promises resolve in next microtask.

      await new Promise(process.nextTick);

      expect(appLifecycle.startApp).toHaveBeenCalled();
    });

    it('should throw if demo mode', async () => {
      configService.get.mockReturnValue(true);
      await expect(service.backupApp({ appUrn: 'test' as any })).rejects.toThrow('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    });
  });

  describe('restoreApp', () => {
    it('should restore app successfully', async () => {
      const appUrn = 'test-app' as any;
      const app = { id: 1, name: 'test-app', status: 'stopped', config: {} };
      appsRepository.getAppByUrn.mockResolvedValue(app as any);
      appEventsQueue.publish.mockResolvedValue({ success: true, message: 'OK' } as any);

      await service.restoreApp({ appUrn, filename: 'backup.tar.gz' });

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'restoring' }));

      await new Promise(process.nextTick);

      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'stopped' }));
    });
  });
});
