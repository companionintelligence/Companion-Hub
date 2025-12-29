import { AppLifecycleService } from '../app-lifecycle.service';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { AppsRepository } from '../../apps/apps.repository';
import { AppsService } from '../../apps/apps.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppEventsQueue } from '../../queue/entities/app-events';
import { AppLifecycleCommandFactory } from '../app-lifecycle-command.factory';
import { AppFilesManager } from '../../apps/app-files-manager';
import { SSEService } from '@/core/sse/sse.service';
import { BackupManager } from '../../backups/backup.manager';
import { Test } from '@nestjs/testing';
import { mock } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { LoggerService } from '@/core/logger/logger.service';
import { createAppUrn } from '@/common/helpers/app-helpers';

import { HostsFileService } from '../../system/hosts-file.service';

describe('AppLifecycleService', () => {
  let service: AppLifecycleService;
  let marketplaceService = mock<MarketplaceService>();
  let appsRepository = mock<AppsRepository>();
  let appsService = mock<AppsService>();
  let configService = mock<ConfigurationService>();
  let appEventsQueue = mock<AppEventsQueue>();
  let commandFactory = mock<AppLifecycleCommandFactory>();
  let appFilesManager = mock<AppFilesManager>();
  let sseService = mock<SSEService>();
  let backupManager = mock<BackupManager>();
  let loggerService = mock<LoggerService>();
  let hostsFileService = mock<HostsFileService>();
  let mutex = { acquire: vi.fn().mockResolvedValue(() => {}) };

  beforeEach(async () => {
    service = new AppLifecycleService(
      loggerService,
      appEventsQueue,
      commandFactory,
      appsRepository,
      configService,
      marketplaceService,
      appsService,
      appFilesManager,
      sseService,
      backupManager,
      hostsFileService,
      mutex as any,
    );

    configService.getConfig.mockReturnValue({
      demoMode: false,
      version: '1.0.0',
      architecture: 'amd64',
    } as any);

    configService.get.mockImplementation((key: any) => {
      if (key === 'userSettings') return { localDomain: 'ci.local' };
      return undefined as any;
    });
  });

  it('should set default exposedLocal, localSubdomain and port when installing app', async () => {
    const appUrn = createAppUrn('test-app', 'test-store');
    const form = {};
    const appInfo = {
      id: 'test-app',
      port: 8080,
      exposable: true,
      supported_architectures: ['amd64'],
    };

    marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfo as any);
    appsRepository.getAppByUrn.mockResolvedValueOnce(undefined).mockResolvedValue({ id: 'test-id' } as any);
    appsRepository.getApps.mockResolvedValue([]);
    appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
    appsRepository.getAppsByPort.mockResolvedValue([]);
    appsService.getRandomPort.mockResolvedValue(12345);
    appEventsQueue.publish.mockResolvedValue({ success: true, message: 'ok' } as any);
    appsRepository.createApp.mockResolvedValue({ id: 'new-app-id' } as any);

    await service.installApp({ appUrn, form });

    expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        exposedLocal: true,
        localSubdomain: 'test-app-test-store',
        port: 12345,
      }),
    }));
    
    // Wait for async operations in .then() block
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(hostsFileService.addDomain).toHaveBeenCalledWith('test-app-test-store.ci.local');
  });

  it('should call hostsFileService.removeDomain when uninstalling app', async () => {
    const appUrn = createAppUrn('test-app', 'test-store');
    const app = {
      id: 'test-id',
      localSubdomain: 'test-app',
    };

    appsRepository.getAppByUrn.mockResolvedValue(app as any);
    appEventsQueue.publish.mockResolvedValue({ success: true, message: 'ok' } as any);

    await service.uninstallApp({ appUrn, removeBackups: false });

    // Wait for async operations in .then() block
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(hostsFileService.removeDomain).toHaveBeenCalledWith('test-app.ci.local');
  });

  it('should not override provided values', async () => {
    const appUrn = createAppUrn('test-app', 'test-store');
    const form = {
      exposedLocal: false,
      localSubdomain: 'custom-subdomain',
      port: 9999,
    };
    const appInfo = {
      id: 'test-app',
      port: 8080,
      exposable: true,
      supported_architectures: ['amd64'],
    };

    marketplaceService.getAppInfoFromAppStoreOrInstalled.mockResolvedValue(appInfo as any);
    appsRepository.getAppByUrn.mockResolvedValue(undefined);
    appsRepository.getApps.mockResolvedValue([]);
    appsRepository.getAppsByLocalSubdomain.mockResolvedValue([]);
    appsRepository.getAppsByPort.mockResolvedValue([]);
    appEventsQueue.publish.mockReturnValue(new Promise(() => {}));

    await service.installApp({ appUrn, form });

    expect(appEventsQueue.publish).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        exposedLocal: false,
        localSubdomain: 'custom-subdomain',
        port: 9999,
      }),
    }));
  });
});
