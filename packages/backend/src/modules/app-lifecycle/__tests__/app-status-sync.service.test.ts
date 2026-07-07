import { describe, it, expect, beforeEach } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppStatusSyncService } from '../app-status-sync.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { SSEService } from '@/core/sse/sse.service';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import type Dockerode from 'dockerode';

describe('AppStatusSyncService', () => {
  let service: AppStatusSyncService;
  let appRepository: MockProxy<AppsRepository>;
  let docker: MockProxy<Dockerode>;
  let errorReportingService: MockProxy<ErrorReportingService>;

  beforeEach(() => {
    appRepository = mock<AppsRepository>();
    docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);
    errorReportingService = mock<ErrorReportingService>();

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

    service = new AppStatusSyncService(
      mock<LoggerService>(),
      appRepository,
      mock<SSEService>(),
      systemEventsQueue,
      config,
      docker,
      undefined,
      errorReportingService,
    );
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

  it('keeps port-expose workloads running without Docker containers', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 6,
        appName: 'ggs',
        appStoreSlug: '_user',
        status: 'missing',
        config: { kind: 'port-expose', port: 3000 },
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppById).toHaveBeenCalledWith(6, expect.objectContaining({ status: 'running' }));
  });

  it('does not override port-expose workloads while uninstalling', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 7,
        appName: 'ggs',
        appStoreSlug: '_user',
        status: 'uninstalling',
        config: { kind: 'port-expose', port: 3000 },
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppById).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it('reports warning coverage for stuck transitional apps', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 4,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'restarting',
        updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(errorReportingService.captureWarning).toHaveBeenCalledWith(
      "App demo:ci-marketplace stuck in 'restarting'",
      expect.objectContaining({ appUrn: 'demo:ci-marketplace', status: 'restarting' }),
      expect.objectContaining({ debounceKey: 'app-status-sync:stuck:demo:ci-marketplace:restarting' }),
    );
  });

  it('reports warning coverage for mixed container states', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 5,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        State: 'running',
        Status: 'Up 5 seconds',
        Labels: { 'ci-os-hub.appurn': 'demo:ci-marketplace' },
      },
      {
        State: 'exited',
        Status: 'Exited (1) 1 second ago',
        Labels: { 'ci-os-hub.appurn': 'demo:ci-marketplace' },
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(errorReportingService.captureWarning).toHaveBeenCalledWith(
      'App demo:ci-marketplace has mixed container states',
      expect.objectContaining({ appUrn: 'demo:ci-marketplace', runningContainers: 1, totalContainers: 2 }),
      expect.objectContaining({ debounceKey: 'app-status-sync:mixed:demo:ci-marketplace' }),
    );
  });
});
