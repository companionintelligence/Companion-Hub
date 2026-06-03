import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppStatusSyncService } from '../app-status-sync.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { SSEService } from '@/core/sse/sse.service';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { ConfigurationService } from '@/core/config/configuration.service';
import type Dockerode from 'dockerode';

describe('AppStatusSyncService', () => {
  let service: AppStatusSyncService;
  let appRepository: MockProxy<AppsRepository>;
  let docker: MockProxy<Dockerode>;

  beforeEach(() => {
    appRepository = mock<AppsRepository>();
    docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);

    const config = mock<ConfigurationService>();
    config.get.mockImplementation((key: string) => {
      if (key === 'userSettings') {
        return { eventsTimeout: 5 };
      }
      return {};
    });

    const systemEventsQueue = mock<SystemEventsQueue>();
    systemEventsQueue.onEvent.mockImplementation(() => {
      /* no-op */
    });

    service = new AppStatusSyncService(mock<LoggerService>(), appRepository, mock<SSEService>(), systemEventsQueue, config, docker);
  });

  it('does not mark install_failed apps as missing while no containers exist', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 3,
        appName: 'plane',
        appStoreSlug: 'ci-marketplace',
        status: 'install_failed',
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ] as any);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppById).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it('does not mark installing apps as missing while no containers exist', async () => {
    const updatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    appRepository.getApps.mockResolvedValue([
      {
        id: 1,
        appName: 'openclaw',
        appStoreSlug: 'ci-marketplace',
        status: 'installing',
        updatedAt,
      },
    ] as never);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppById).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(result.syncedCount).toBe(0);
  });

  it('marks stopped apps without containers as missing', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 2,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'stopped',
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppById).toHaveBeenCalledWith(2, expect.objectContaining({ status: 'missing' }));
  });
});
