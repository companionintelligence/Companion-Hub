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

  describe('containerRollup — the pool capability sample', () => {
    function container(overrides: Record<string, unknown> = {}) {
      return {
        containerId: 'c1',
        name: 'svc',
        state: 'running',
        status: 'Up',
        health: 'healthy',
        exitCode: null,
        cpuPercent: 10,
        memoryUsageBytes: 1000,
        memoryLimitBytes: 4000,
        ...overrides,
      };
    }

    beforeEach(() => {
      // Nothing containerised for the Hub itself, and no backend process either, so each test
      // decides its own container population instead of inheriting one.
      dockerReadFacade.getHubRuntimeStats.mockResolvedValue([]);
      (si.processes as any).mockResolvedValue({ list: [] });
    });

    it('reports nothing at all before the first sample has landed', () => {
      // The state every Hub is in for the first seconds after boot. It must reach a peer as an
      // omitted key, not as "0 containers" — this node has measured precisely nothing.
      expect(service.containerRollup()).toBeNull();
    });

    it('reports nothing when a collection failed and there was never a successful sample', async () => {
      appsRepository.getApps.mockRejectedValue(new Error('docker is down'));

      await service.getRuntimeMonitorSnapshot();

      // `collectRuntimeMonitorSnapshot` swallows the failure and RETURNS an empty snapshot, whose
      // `apps: []` is pixel-identical to an idle node. Only this service knows which happened, so
      // only this service can refuse to answer.
      expect(service.containerRollup()).toBeNull();
    });

    it('rolls the collected sample up into counts and totals', async () => {
      appsRepository.getApps.mockResolvedValue([
        { id: 1, appName: 'alpha', appStoreSlug: 'store', status: 'running', config: {}, updatedAt: new Date().toISOString() },
      ] as any);
      dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
        container({ containerId: 'a1', cpuPercent: 12.5, memoryUsageBytes: 2_000 }),
        container({ containerId: 'a2', state: 'exited', status: 'Exited (0)', cpuPercent: 0, memoryUsageBytes: 0 }),
        container({ containerId: 'a3', state: 'paused', cpuPercent: 0.5, memoryUsageBytes: 500 }),
      ] as any);

      await service.getRuntimeMonitorSnapshot();

      // `paused` is not running, so it lands in `stopped`: the question a peer is asking is how much
      // of this box is doing work, and the two buckets are defined to sum to `total`.
      expect(service.containerRollup()).toEqual({ running: 1, stopped: 2, total: 3, cpuPercent: 13, memoryBytes: 2_500 });
    });

    it('reports a genuinely idle node as zeros rather than omitting the figure', async () => {
      appsRepository.getApps.mockResolvedValue([] as any);

      await service.getRuntimeMonitorSnapshot();

      // The collection SUCCEEDED and found nothing. That is a claim this node is entitled to make,
      // and it is the one case that must not be confused with "cannot tell you".
      expect(service.containerRollup()).toEqual({ running: 0, stopped: 0, total: 0, cpuPercent: 0, memoryBytes: 0 });
    });

    it('withholds the figure when Docker was never reached, even though the collection succeeded', async () => {
      /*
       * THE PATH THAT PUBLISHED ZEROS AS A MEASUREMENT.
       *
       * `collectHubRuntimeHealth` catches every Docker error and returns null, which the collector
       * cannot tell from "this Hub has no containerised entity". With no non-missing apps there is
       * no second Docker call left to throw, so the collection completes, stamps a fresh
       * `sampledAt` and stores an empty `apps` array — and the rollup taken from it said
       * `running: 0, total: 0` to every paired peer.
       *
       * Indistinguishable, on the wire, from the idle node in the test above. That is the one
       * confusion this payload exists to prevent.
       */
      appsRepository.getApps.mockResolvedValue([] as any);
      dockerReadFacade.getHubRuntimeStats.mockRejectedValue(new Error('Cannot connect to the Docker daemon'));

      await service.getRuntimeMonitorSnapshot();

      expect(service.containerRollup()).toBeNull();
    });

    it('excludes the backend Node process, which is not a container', async () => {
      appsRepository.getApps.mockResolvedValue([] as any);
      (si.processes as any).mockResolvedValue({ list: [{ pid: process.pid, cpu: 7.5, memRss: 2048, state: 'running' }] });

      await service.getRuntimeMonitorSnapshot();

      // The monitor injects a synthetic `pid:<pid>` entry for the Hub's own process on a
      // non-containerised install. Counting it would inflate every count on the fleet by one and
      // put the CPU total on a different population from the counts.
      expect(service.containerRollup()).toMatchObject({ running: 0, total: 0, cpuPercent: 0 });
    });

    it('stops reporting once the last successful sample is too old to believe', async () => {
      appsRepository.getApps.mockResolvedValue([] as any);

      await service.getRuntimeMonitorSnapshot();
      const sampledAtMs = Date.parse((await service.getRuntimeMonitorSnapshot()).sampledAt);

      // Inside two monitor intervals a sample is still the answer; past them the monitor has
      // stopped producing and a peer must be told nothing rather than something stale.
      expect(service.containerRollup(sampledAtMs + 90_000)).not.toBeNull();
      expect(service.containerRollup(sampledAtMs + 121_000)).toBeNull();
    });

    it('keeps answering from cache without touching Docker, since this runs on a peer poll path', async () => {
      appsRepository.getApps.mockResolvedValue([] as any);
      await service.getRuntimeMonitorSnapshot();
      dockerReadFacade.getAppRuntimeStats.mockClear();
      dockerReadFacade.getHubRuntimeStats.mockClear();

      service.containerRollup();
      service.containerRollup();

      // A Docker fan-out here is the documented way a healthy node gets marked unreachable: the
      // capabilities probe answering this has a 15s budget and three overruns is all it takes.
      expect(dockerReadFacade.getAppRuntimeStats).not.toHaveBeenCalled();
      expect(dockerReadFacade.getHubRuntimeStats).not.toHaveBeenCalled();
    });
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
