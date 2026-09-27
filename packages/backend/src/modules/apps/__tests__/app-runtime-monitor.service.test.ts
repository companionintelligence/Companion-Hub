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
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { GpuProcessSamplerService } from '@/modules/inference/gpu-process-sampler.service';
import { AppFilesManager } from '../app-files-manager';
import { EnvUtils } from '@/modules/env/env.utils';
import si from 'systeminformation';

vi.mock('systeminformation');

describe('AppRuntimeMonitorService', () => {
  const originalHostname = process.env.HOSTNAME;
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;
  let appsRepository: MockProxy<AppsRepository>;
  let appsService: MockProxy<AppsService>;
  let dockerReadFacade: MockProxy<DockerReadFacade>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  let gpuSampler: MockProxy<GpuProcessSamplerService>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let envUtils: MockProxy<EnvUtils>;
  let service: AppRuntimeMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();
    appsRepository = mock<AppsRepository>();
    appsService = mock<AppsService>();
    dockerReadFacade = mock<DockerReadFacade>();
    hardwareInspector = mock<HardwareInspectorService>();
    gpuSampler = mock<GpuProcessSamplerService>();
    appFilesManager = mock<AppFilesManager>();
    envUtils = mock<EnvUtils>();
    // No manifest on disk, so no readiness endpoint: every test that predates the probe must
    // never see a fetch. The readiness block below declares one explicitly.
    appFilesManager.getInstalledAppInfo.mockResolvedValue(null);

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
    dockerReadFacade.mapPidsToContainers.mockResolvedValue(new Map());
    // No GPU vendor by default, matching a node the hardware inspector has not (yet) identified
    // one on — every existing test in this file predates GPU attribution and asserts nothing about
    // it, so the default here must be a genuine no-op, not a fabricated reading.
    hardwareInspector.getProfile.mockResolvedValue({} as any);
    gpuSampler.observeVramByProcess.mockResolvedValue({ samples: [], source: null });

    service = new AppRuntimeMonitorService(
      logger,
      config,
      appsRepository,
      appsService,
      dockerReadFacade,
      hardwareInspector,
      gpuSampler,
      appFilesManager,
      envUtils,
    );
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

  /*
   * core-2, 2026-09-27: history samples at 18:00:49.803 and 18:00:50.491. The 60s timer's collection
   * was still fanning out over Docker when a dashboard GET found the cache stale and started a second
   * one, and each appended a sample. Charted by index, a 0.7-second interval drew as wide as a minute.
   */
  it('joins a collection already in flight instead of taking a second sample beside it', async () => {
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
    let release: () => void = () => undefined;
    const docker = new Promise<void>((resolve) => {
      release = resolve;
    });
    dockerReadFacade.getAppRuntimeStats.mockImplementation(async () => {
      await docker;
      return [
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
      ];
    });

    // The timer's path and a page's path, both arriving while Docker has not answered yet.
    const first = service.getRuntimeMonitorSnapshot();
    const second = service.getRuntimeMonitorSnapshot();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(dockerReadFacade.getAppRuntimeStats).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b.history).toHaveLength(1);
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
          {
            appUrn: 'ci-memory:ci-marketplace',
            appName: 'ci-memory',
            status: 'running',
            cpuPercent: 55,
            memoryUsageBytes: 2048,
            containerCount: 3,
            gpuVramMb: null,
          },
        ],
      },
    ]);
    appsRepository.getApps.mockResolvedValue([]);
    dockerReadFacade.getHubRuntimeStats.mockResolvedValue([]);
    (si.processes as any).mockResolvedValue({ list: [] });

    service = new AppRuntimeMonitorService(
      logger,
      config,
      appsRepository,
      appsService,
      dockerReadFacade,
      hardwareInspector,
      gpuSampler,
      appFilesManager,
      envUtils,
      telemetry,
    );
    const snapshot = await service.getRuntimeMonitorSnapshot();

    expect(snapshot.history[0]).toMatchObject({
      sampledAt: '2026-08-18T12:00:00.000Z',
      apps: [expect.objectContaining({ appUrn: 'ci-memory:ci-marketplace', cpuPercent: 55 })],
    });
    expect(telemetry.recordRuntimeApps).toHaveBeenCalled();
  });

  describe('GPU VRAM attribution', () => {
    beforeEach(() => {
      appsRepository.getApps.mockResolvedValue([
        { id: 1, appName: 'alpha', appStoreSlug: 'store', status: 'running', config: {}, updatedAt: new Date().toISOString() },
      ] as any);
      dockerReadFacade.getAppRuntimeStats.mockResolvedValue([
        {
          containerId: 'c1',
          name: 'alpha_store-svc-1',
          state: 'running',
          status: 'Up',
          health: 'healthy',
          exitCode: null,
          cpuPercent: 5,
          memoryUsageBytes: 1000,
          memoryLimitBytes: 4000,
        },
      ] as any);
    });

    it('leaves gpuVramMb null on every workload when the host has no supported GPU vendor', async () => {
      // hardwareInspector.getProfile() resolves to {} in the outer beforeEach — no `gpu` key at
      // all, the shape a host with no GPU (or one the inspector has not read yet) reports.
      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ gpuVramMb: null });
      expect(snapshot.unattributedGpu).toBeNull();
      // Absent, said once per snapshot: the nulls above are for want of a measurement.
      expect(snapshot.gpuVramSource).toBe('absent');
      expect(gpuSampler.observeVramByProcess).toHaveBeenCalledWith(undefined);
    });

    it('reports the source that measured, even when it found nothing holding VRAM', async () => {
      // A fresh host probe file listing no processes is a measurement of an idle card; the chart
      // may show nothing, but the tile must not say the reading is absent on this node.
      hardwareInspector.getProfile.mockResolvedValue({ gpu: { vendor: 'nvidia' } } as any);
      gpuSampler.observeVramByProcess.mockResolvedValue({ samples: [], source: 'host-file' });

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.gpuVramSource).toBe('host-file');
      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ gpuVramMb: null });
      expect(dockerReadFacade.mapPidsToContainers).not.toHaveBeenCalled();
    });

    it('sums a sampled process onto the workload whose container holds it', async () => {
      hardwareInspector.getProfile.mockResolvedValue({ gpu: { vendor: 'amd' } } as any);
      gpuSampler.observeVramByProcess.mockResolvedValue({ samples: [{ pid: 4242, processName: 'some-engine', vramMb: 512 }], source: 'host-file' });
      dockerReadFacade.mapPidsToContainers.mockResolvedValue(new Map([[4242, 'alpha_store-svc-1']]));

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ gpuVramMb: 512 });
      expect(snapshot.unattributedGpu).toBeNull();
      expect(snapshot.gpuVramSource).toBe('host-file');
      expect(dockerReadFacade.mapPidsToContainers).toHaveBeenCalledWith([4242]);
    });

    it('sums two processes in the same container onto one workload total', async () => {
      hardwareInspector.getProfile.mockResolvedValue({ gpu: { vendor: 'nvidia' } } as any);
      gpuSampler.observeVramByProcess.mockResolvedValue({
        samples: [
          { pid: 1, processName: 'engine-a', vramMb: 300 },
          { pid: 2, processName: 'engine-b', vramMb: 200 },
        ],
        source: 'tool',
      });
      dockerReadFacade.mapPidsToContainers.mockResolvedValue(
        new Map([
          [1, 'alpha_store-svc-1'],
          [2, 'alpha_store-svc-1'],
        ]),
      );

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ gpuVramMb: 500 });
    });

    it('reports a process matching no known container as unattributed, not silently dropped', async () => {
      hardwareInspector.getProfile.mockResolvedValue({ gpu: { vendor: 'amd' } } as any);
      gpuSampler.observeVramByProcess.mockResolvedValue({ samples: [{ pid: 9, processName: 'ollama', vramMb: 4096 }], source: 'tool' });
      // A bare host process: no container holds this PID at all, unlike the matched cases above.
      dockerReadFacade.mapPidsToContainers.mockResolvedValue(new Map());

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ gpuVramMb: null });
      expect(snapshot.unattributedGpu).toEqual([{ processName: 'ollama', vramMb: 4096 }]);
    });

    it('does not let a GPU sampling failure take down the rest of the snapshot', async () => {
      hardwareInspector.getProfile.mockRejectedValue(new Error('hardware probe timed out'));

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'alpha:store')).toMatchObject({ cpuPercent: 5, gpuVramMb: null });
      expect(snapshot.gpuVramSource).toBe('absent');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GPU VRAM attribution failed'));
    });
  });
  describe('readiness probe (hub_integration.readiness, CI-Hub#1556)', () => {
    const descriptor = { service: 'ci-hermes-gateway', port: 8642, path: '/health/detailed', bearer_env: 'APP_SEED' };
    const runningContainer = {
      containerId: 'abc',
      name: 'svc',
      state: 'running',
      status: 'Up',
      health: 'healthy',
      exitCode: null,
      cpuPercent: 3,
      memoryUsageBytes: 100,
      memoryLimitBytes: 1000,
    };

    function installedApp(status = 'running') {
      appsRepository.getAppByUrn.mockResolvedValue({
        id: 1,
        appName: 'ci-hermes',
        appStoreSlug: 'ci-marketplace',
        status,
        config: {},
        updatedAt: new Date().toISOString(),
      } as any);
      dockerReadFacade.getAppRuntimeStats.mockResolvedValue([runningContainer]);
    }

    /** The app's own compose, as installed: the gateway is a declared service, so the probe may dial it. */
    const hermesCompose = {
      schemaVersion: 2,
      services: [
        { name: 'ci-hermes', image: 'ghcr.io/companionintelligence/ci-hermes:latest', isMain: true },
        { name: 'ci-hermes-gateway', image: 'ghcr.io/companionintelligence/ci-hermes-gateway:latest', isMain: false },
      ],
    };

    beforeEach(() => {
      installedApp();
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ hub_integration: { readiness: descriptor } } as any);
      appFilesManager.getDockerComposeJson.mockResolvedValue({ path: '/apps/ci-hermes/docker-compose.json', content: hermesCompose });
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'APP_SEED=s3cr3t-seed\nOTHER=x\n' });
      envUtils.envStringToMap.mockImplementation((content: string) => {
        const map = new Map<string, string>();
        for (const line of content.split('\n')) {
          const [key, ...rest] = line.split('=');
          if (key && rest.length) map.set(key, rest.join('='));
        }
        return map;
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          status: 'degraded',
          readiness: { status: 'degraded', checks: { model: { status: 'degraded' }, config: { status: 'ok', detail: 'using defaults' } } },
          gateway_busy: false,
          gateway_drainable: true,
        }),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('dials http://<service>:<port><path> with the bearer from the app env, and never logs it', async () => {
      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://ci-hermes-gateway:8642/health/detailed');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cr3t-seed');
      expect(init.signal).toBeInstanceOf(AbortSignal);

      expect(result.readiness).toEqual({
        status: 'degraded',
        checks: { model: { status: 'degraded' }, config: { status: 'ok', detail: 'using defaults' } },
        busy: false,
        drainable: true,
        sampledAt: result.sampledAt,
      });
      // Docker-derived health is untouched: readiness is a second axis, never an input to `degraded`.
      expect(result.degraded).toBe(false);
      expect(result.responsive).toBe(true);

      const logged = [logger.debug, logger.info, logger.warn, logger.error].flatMap((fn) => fn.mock.calls.flat().map(String));
      expect(logged.some((line) => line.includes('s3cr3t-seed'))).toBe(false);
    });

    it('reports null, and does not fetch, when the app declares no readiness endpoint', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ hub_integration: { mcp_client: true } } as any);

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('reports null, and does not fetch, when the app is not running', async () => {
      installedApp('stopped');
      dockerReadFacade.getAppRuntimeStats.mockResolvedValue([]);

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('probes without a bearer when the manifest names none', async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        hub_integration: { readiness: { service: 'app', port: 8080, path: '/health' } },
      } as any);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/apps/x/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'app', image: 'app:latest', isMain: true }] },
      });
      vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'ok' }));

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://app:8080/health');
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(appFilesManager.getAppEnv).not.toHaveBeenCalled();
      expect(result.readiness).toMatchObject({ status: 'ok', checks: {} });
    });

    it("never dials a service the app's own compose does not declare: unknown, no fetch, one warning", async () => {
      // A third-party manifest could otherwise point `bearer_env` at another app on the shared
      // network, the host, or the internet, and the Hub would hand it this app's key.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        hub_integration: { readiness: { ...descriptor, service: 'ci-memory-gateway' } },
      } as any);

      const first = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);
      const second = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(first.readiness).toMatchObject({ status: 'unknown', checks: {} });
      expect(second.readiness).toMatchObject({ status: 'unknown' });
      expect(fetch).not.toHaveBeenCalled();
      expect(appFilesManager.getAppEnv).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"ci-memory-gateway" is not a service in this app\'s docker-compose.json'));
      const logged = [logger.debug, logger.info, logger.warn, logger.error].flatMap((fn) => fn.mock.calls.flat().map(String));
      expect(logged.some((line) => line.includes('s3cr3t-seed'))).toBe(false);
    });

    it("dials the service once it is declared in the app's compose", async () => {
      // The compose is the gate, not the manifest: the same descriptor is refused above and
      // accepted here, and the only difference is what this app's docker-compose.json says.
      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(appFilesManager.getDockerComposeJson).toHaveBeenCalledWith('ci-hermes:ci-marketplace');
      expect(fetch).toHaveBeenCalledWith('http://ci-hermes-gateway:8642/health/detailed', expect.anything());
      expect(result.readiness).toMatchObject({ status: 'degraded' });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("treats a missing or unparseable compose as not this app's service, and does not fetch", async () => {
      appFilesManager.getDockerComposeJson.mockResolvedValueOnce({ path: '/apps/ci-hermes/docker-compose.json', content: null });
      expect((await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any)).readiness).toMatchObject({ status: 'unknown' });

      appFilesManager.getDockerComposeJson.mockResolvedValueOnce({ path: '/apps/ci-hermes/docker-compose.json', content: { services: 'garbage' } });
      expect((await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any)).readiness).toMatchObject({ status: 'unknown' });

      expect(fetch).not.toHaveBeenCalled();
    });

    it('is unknown, never degraded, when the probe times out or throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toMatchObject({ status: 'unknown', checks: {}, busy: null, drainable: null });
      expect(result.degraded).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('is unknown when the endpoint answers non-2xx (a 401 on a missing bearer, say)', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('unauthorized', { status: 401 }));

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toMatchObject({ status: 'unknown' });
    });

    it('is unknown when the body is not JSON', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toMatchObject({ status: 'unknown' });
    });

    it("keeps an unreadable app env inside this app's own sample rather than failing the probe path", async () => {
      appFilesManager.getAppEnv.mockRejectedValue(new Error('EACCES'));

      const result = await service.getAppRuntimeHealth('ci-hermes:ci-marketplace' as any);

      expect(result.readiness).toMatchObject({ status: 'unknown' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('carries readiness on the monitor snapshot and leaves the Hub entity null', async () => {
      appsRepository.getApps.mockResolvedValue([
        { id: 1, appName: 'ci-hermes', appStoreSlug: 'ci-marketplace', status: 'running', config: {}, updatedAt: new Date().toISOString() },
      ] as any);
      dockerReadFacade.getHubRuntimeStats.mockResolvedValue([
        {
          containerId: 'hub',
          name: 'ci-hub',
          state: 'running',
          status: 'Up',
          health: null,
          exitCode: null,
          cpuPercent: 1,
          memoryUsageBytes: 1,
          memoryLimitBytes: 1,
        },
      ]);
      process.env.HOSTNAME = 'hub';

      const snapshot = await service.getRuntimeMonitorSnapshot();

      expect(snapshot.apps.find((app) => app.appUrn === 'ci-hermes:ci-marketplace')?.readiness).toMatchObject({ status: 'degraded' });
      expect(snapshot.apps.find((app) => app.appUrn === 'ci-hub:system')?.readiness).toBeNull();
    });
  });
});
