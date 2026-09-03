import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '../apps.repository';
import { AppsService } from '../apps.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import si from 'systeminformation';

vi.mock('systeminformation');

describe('AppRuntimeMonitorService', () => {
  const originalHostname = process.env.HOSTNAME;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let appsService: MockProxy<AppsService>;
  let dockerReadFacade: MockProxy<DockerReadFacade>;
  let service: AppRuntimeMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    appsService = mock<AppsService>();
    dockerReadFacade = mock<DockerReadFacade>();

    config.get.mockImplementation((key: string) => {
      if (key === 'userSettings') {
        return {} as any;
      }
      return undefined as any;
    });
    (si.processes as any) = vi.fn().mockResolvedValue({
      list: [
        {
          pid: process.pid,
          cpu: 7.5,
          memRss: 2048,
          state: 'running',
        },
      ],
    });
    dockerReadFacade.getHubRuntimeStats.mockResolvedValue([]);

    service = new AppRuntimeMonitorService(logger, config, appsRepository, appsService, dockerReadFacade);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHostname === undefined) {
      delete process.env.HOSTNAME;
    } else {
      process.env.HOSTNAME = originalHostname;
    }
  });

  it('does not probe healthy running apps in the hot path', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      appName: 'test-app',
      appStoreSlug: 'store',
      status: 'running',
      config: {},
      updatedAt: new Date().toISOString(),
    } as any);
    dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
      {
        containerId: 'abc',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        exitCode: null,
        cpuPercent: 12,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      },
    ]);

    const result = await service.getAppRuntimeHealth('test-app:store' as any);

    expect(result.responsive).toBe(true);
    expect(appsService.checkAppAvailability).not.toHaveBeenCalled();
  });

  it('caches availability probes for suspicious apps', async () => {
    appsRepository.getAppByUrn.mockResolvedValue({
      id: 1,
      appName: 'test-app',
      appStoreSlug: 'store',
      status: 'running',
      config: {},
      updatedAt: new Date().toISOString(),
    } as any);
    dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
      {
        containerId: 'abc',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        exitCode: null,
        cpuPercent: 95,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      },
    ]);
    appsService.checkAppAvailability.mockResolvedValue({
      available: false,
      detail: 'Connection refused',
    } as any);

    const first = await service.getAppRuntimeHealth('test-app:store' as any);
    const second = await service.getAppRuntimeHealth('test-app:store' as any);

    expect(first.responsive).toBe(false);
    expect(second.responsive).toBe(false);
    expect(appsService.checkAppAvailability).toHaveBeenCalledTimes(1);
  });

  it('returns not found when the app record is gone', async () => {
    appsRepository.getAppByUrn.mockResolvedValue(null);

    await expect(service.getAppRuntimeHealth('missing:store' as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns cached monitor snapshots without re-polling Docker immediately', async () => {
    vi.useFakeTimers();
    appsRepository.getApps.mockResolvedValue([
      {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'store',
        status: 'running',
        config: {},
        updatedAt: new Date().toISOString(),
      } as any,
    ]);
    dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
      {
        containerId: 'abc',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        exitCode: null,
        cpuPercent: 12,
        memoryUsageBytes: 100,
        memoryLimitBytes: 1000,
      },
    ]);

    await service.getRuntimeMonitorSnapshot();
    await service.getRuntimeMonitorSnapshot();

    expect(dockerReadFacade.getAppRuntimeStats).toHaveBeenCalledTimes(1);
  });

  it('includes rolling history gathered before the page is opened', async () => {
    vi.useFakeTimers();
    appsRepository.getApps.mockResolvedValue([
      {
        id: 1,
        appName: 'test-app',
        appStoreSlug: 'store',
        status: 'running',
        config: {},
        updatedAt: new Date().toISOString(),
      } as any,
    ]);
    dockerReadFacade.getAppRuntimeStats
      .mockResolvedValueOnce([
        {
          containerId: 'abc',
          name: 'svc',
          state: 'running',
          status: 'Up',
          health: 'healthy',
          cpuPercent: 12,
          memoryUsageBytes: 100,
          memoryLimitBytes: 1000,
        },
      ])
      .mockResolvedValueOnce([
        {
          containerId: 'abc',
          name: 'svc',
          state: 'running',
          status: 'Up',
          health: 'healthy',
          cpuPercent: 18,
          memoryUsageBytes: 120,
          memoryLimitBytes: 1000,
        },
      ]);

    const first = await service.getRuntimeMonitorSnapshot();
    vi.advanceTimersByTime(31_000);
    const second = await service.getRuntimeMonitorSnapshot();

    expect(first.history).toHaveLength(1);
    expect(second.history).toHaveLength(2);
    expect(second.history[0]?.apps.find((app) => app.appUrn === 'test-app:store')).toMatchObject({
      appUrn: 'test-app:store',
      appName: 'test-app',
      cpuPercent: 12,
      memoryUsageBytes: 100,
      containerCount: 1,
    });
    expect(second.history[1]?.apps.find((app) => app.appUrn === 'test-app:store')).toMatchObject({
      cpuPercent: 18,
      memoryUsageBytes: 120,
    });
  });

  it('includes the companion hub api in monitor snapshots', async () => {
    appsRepository.getApps.mockResolvedValue([]);
    dockerReadFacade.getHubRuntimeStats.mockResolvedValue([
      {
        containerId: 'hub-db',
        name: 'ci-hub-db',
        state: 'running',
        status: 'Up',
        health: null,
        exitCode: null,
        cpuPercent: 2.5,
        memoryUsageBytes: 4096,
        memoryLimitBytes: 8192,
      },
    ]);

    const snapshot = await service.getRuntimeMonitorSnapshot();

    expect(snapshot.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appUrn: 'ci-hub:system',
          appName: 'CI Hub',
          cpuPercent: 10,
          memoryUsageBytes: 2048 * 1024 + 4096,
          memoryLimitBytes: 8192,
        }),
      ]),
    );
    expect(snapshot.history[0]?.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appUrn: 'ci-hub:system',
          appName: 'CI Hub',
          cpuPercent: 10,
          memoryUsageBytes: 2048 * 1024 + 4096,
        }),
      ]),
    );
  });

  it('does not double-count the backend process when its container is already tracked', async () => {
    process.env.HOSTNAME = 'hub-api-container';
    appsRepository.getApps.mockResolvedValue([]);
    dockerReadFacade.getHubRuntimeStats.mockResolvedValue([
      {
        containerId: 'hub-api-container-123456',
        name: 'ci-os-hub',
        state: 'running',
        status: 'Up',
        health: null,
        exitCode: null,
        cpuPercent: 4.25,
        memoryUsageBytes: 8192,
        memoryLimitBytes: 16384,
      },
    ]);

    const snapshot = await service.getRuntimeMonitorSnapshot();

    expect(si.processes).not.toHaveBeenCalled();
    expect(snapshot.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          appUrn: 'ci-hub:system',
          appName: 'CI Hub',
          cpuPercent: 4.25,
          memoryUsageBytes: 8192,
          memoryLimitBytes: 16384,
        }),
      ]),
    );
  });

  it('returns the last good snapshot when collection times out', async () => {
    vi.useFakeTimers();
    try {
      appsRepository.getApps.mockResolvedValue([
        {
          id: 1,
          appName: 'test-app',
          appStoreSlug: 'store',
          status: 'running',
          config: {},
          updatedAt: new Date().toISOString(),
        } as any,
      ]);
      dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
        {
          containerId: 'abc',
          name: 'svc',
          state: 'running',
          status: 'Up',
          health: 'healthy',
          exitCode: null,
          cpuPercent: 12,
          memoryUsageBytes: 100,
          memoryLimitBytes: 1000,
        },
      ]);

      const first = await service.getRuntimeMonitorSnapshot();
      await vi.advanceTimersByTimeAsync(31_000);

      dockerReadFacade.getAppRuntimeStats.mockImplementation(
        () =>
          new Promise(() => {
            /* hang */
          }),
      );

      const secondPromise = service.getRuntimeMonitorSnapshot();
      await vi.advanceTimersByTimeAsync(30_100);
      const second = await secondPromise;

      expect(first.apps.some((app) => app.appUrn === 'test-app:store')).toBe(true);
      expect(second).toBe(first);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));

      dockerReadFacade.getAppRuntimeStats.mockClear();
      const third = await service.getRuntimeMonitorSnapshot();
      expect(third).toBe(first);
      expect(dockerReadFacade.getAppRuntimeStats).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates rolling history from persisted telemetry after a restart', async () => {
    const telemetry = mock<HostTelemetryService>();
    telemetry.getRuntimeHistory.mockResolvedValue([
      {
        sampledAt: '2026-08-18T12:00:00.000Z',
        apps: [
          { appUrn: 'ci-memory:ci-marketplace', appName: 'ci-memory', status: 'running', cpuPercent: 55, memoryUsageBytes: 2048, containerCount: 3 },
        ],
      },
    ]);
    appsRepository.getApps.mockResolvedValue([]);
    dockerReadFacade.getHubRuntimeStats.mockResolvedValue([]);
    (si.processes as any).mockResolvedValue({ list: [] });

    service = new AppRuntimeMonitorService(logger, config, appsRepository, appsService, dockerReadFacade, telemetry);
    const snapshot = await service.getRuntimeMonitorSnapshot();

    expect(snapshot.history[0]).toMatchObject({
      sampledAt: '2026-08-18T12:00:00.000Z',
      apps: [expect.objectContaining({ appUrn: 'ci-memory:ci-marketplace', cpuPercent: 55 })],
    });
    expect(telemetry.recordRuntimeApps).toHaveBeenCalled();
  });
});
