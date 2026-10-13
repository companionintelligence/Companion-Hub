import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppStatusSyncService } from '../app-status-sync.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { InstallPipelineTracker } from '@/modules/apps/install-pipeline.tracker';
import { SSEService } from '@/core/sse/sse.service';
import { SystemEventsQueue } from '@/modules/queue/entities/system-events';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import type { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { AppOperationRegistry } from '../app-operation-registry';
import type Dockerode from 'dockerode';

describe('AppStatusSyncService', () => {
  let service: AppStatusSyncService;
  let appRepository: MockProxy<AppsRepository>;
  let docker: MockProxy<Dockerode>;
  let errorReportingService: MockProxy<ErrorReportingService>;
  let agentNotifyService: MockProxy<AgentNotifyService>;
  let sseService: MockProxy<SSEService>;
  let installPipelineTracker: InstallPipelineTracker;
  let operationRegistry: AppOperationRegistry;
  let dockerReadFacade: { diagnoseAppContainers: ReturnType<typeof vi.fn> };
  let logger: MockProxy<LoggerService>;

  beforeEach(() => {
    logger = mock<LoggerService>();
    appRepository = mock<AppsRepository>();
    appRepository.updateAppByIdIfStatus.mockResolvedValue(true);
    docker = mock<Dockerode>();
    docker.listContainers.mockResolvedValue([]);
    errorReportingService = mock<ErrorReportingService>();
    agentNotifyService = mock<AgentNotifyService>();
    sseService = mock<SSEService>();
    installPipelineTracker = new InstallPipelineTracker();
    operationRegistry = new AppOperationRegistry(mock<LoggerService>());
    dockerReadFacade = {
      diagnoseAppContainers: vi.fn().mockResolvedValue({ unhealthy: [], healthy: [] }),
    };

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
      logger,
      appRepository,
      sseService,
      systemEventsQueue,
      config,
      docker,
      installPipelineTracker,
      operationRegistry,
      agentNotifyService,
      errorReportingService,
      undefined,
      dockerReadFacade as never,
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

  it('does not mark installing apps as missing while no containers exist within the pull grace', async () => {
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
    expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(result.syncedCount).toBe(0);
  });

  it('heals stranded installing apps past grace when nothing is actively installing them', async () => {
    const updatedAt = new Date(Date.now() - 50 * 60 * 1000).toISOString();
    appRepository.getApps.mockResolvedValue([
      {
        id: 1,
        appName: 'flatnotes',
        appStoreSlug: 'ci-marketplace',
        status: 'installing',
        updatedAt,
      },
    ] as never);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(1, 'installing', expect.objectContaining({ status: 'install_failed' }));
    expect(sseService.emit).toHaveBeenCalledWith(
      'app',
      expect.objectContaining({ event: 'install_error', appUrn: 'flatnotes:ci-marketplace', appStatus: 'install_failed' }),
    );
    expect(result.syncedCount).toBe(1);
  });

  it('does not heal an installing app that still holds the pipeline even past grace', async () => {
    const updatedAt = new Date(Date.now() - 50 * 60 * 1000).toISOString();
    appRepository.getApps.mockResolvedValue([
      {
        id: 1,
        appName: 'openclaw',
        appStoreSlug: 'ci-marketplace',
        status: 'installing',
        updatedAt,
      },
    ] as never);
    installPipelineTracker.setActive('openclaw:ci-marketplace' as never);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(result.syncedCount).toBe(0);
  });

  it('keeps stopped apps without containers as stopped', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 2,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'stopped',
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    expect(result.syncedCount).toBe(0);
  });

  it('heals legacy missing status to stopped when no containers exist', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 9,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'missing',
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(9, 'missing', expect.objectContaining({ status: 'stopped' }));
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

  /*
   * Postgres hands a `timestamp` back without a zone ("2026-10-01 10:00:00.123456"), and the Hub writes
   * them as UTC. Every fixture above is an ISO string ending in Z, which names its zone and so hid that
   * the sync read the other kind in the PROCESS's zone: the Hub container runs in the host's.
   */
  describe.each(['Asia/Karachi', 'America/New_York', 'Pacific/Auckland'])(
    'timestamps as Postgres returns them, in a process running in %s',
    (zone) => {
      const originalTz = process.env.TZ;
      const asPostgres = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace('Z', '');

      beforeEach(() => {
        process.env.TZ = zone;
      });

      afterEach(() => {
        if (originalTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = originalTz;
        }
      });

      it('leaves an app that began updating a minute ago alone', async () => {
        appRepository.getApps.mockResolvedValue([
          { id: 4, appName: 'demo', appStoreSlug: 'ci-marketplace', status: 'updating', updatedAt: asPostgres(60 * 1000) },
        ] as never);

        const result = await service.syncAllAppStatuses();

        expect(result.skippedCount).toBe(1);
        expect(appRepository.updateAppById).not.toHaveBeenCalled();
        expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
      });

      it('still reports an app stuck in a transitional state for three hours', async () => {
        appRepository.getApps.mockResolvedValue([
          { id: 4, appName: 'demo', appStoreSlug: 'ci-marketplace', status: 'restarting', updatedAt: asPostgres(3 * 60 * 60 * 1000) },
        ] as never);

        const result = await service.syncAllAppStatuses();

        expect(result.skippedCount).toBe(0);
      });
    },
  );

  it('does not overwrite status when the app moved into a lifecycle transition since the snapshot', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 8,
        appName: 'demo',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
    ] as never);
    appRepository.updateAppByIdIfStatus.mockResolvedValue(false);

    const result = await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(8, 'running', expect.objectContaining({ status: 'stopped' }));
    expect(result.skippedCount).toBe(1);
    expect(result.syncedCount).toBe(0);
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

  /*
   * The desktop's Stop Hub stops every app container with `docker stop`, so each one exits 0.
   * Counting a clean exit as healthy, which is there for one-shot init services, kept such an app
   * `running` with nothing running at all, and nothing offered to start it (Companion-Hub#1938).
   */
  it('marks an app stopped when every container exited cleanly', async () => {
    appRepository.getApps.mockResolvedValue([
      { id: 10, appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running', updatedAt: new Date().toISOString() },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'wp',
        State: 'exited',
        Status: 'Exited (0) 6 minutes ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
      {
        Id: 'db',
        State: 'exited',
        Status: 'Exited (0) 6 minutes ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(10, 'running', expect.objectContaining({ status: 'stopped' }));
    expect(sseService.emit).toHaveBeenCalledWith('app', { event: 'status_change', appUrn: 'wordpress:ci-marketplace', appStatus: 'stopped' });
  });

  it('keeps an app running when only its one-shot init service has exited cleanly', async () => {
    appRepository.getApps.mockResolvedValue([
      { id: 11, appName: 'ci-memory', appStoreSlug: 'ci-marketplace', status: 'running', updatedAt: new Date().toISOString() },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'api',
        State: 'running',
        Status: 'Up 2 hours',
        Labels: { 'ci-hub.appurn': 'ci-memory:ci-marketplace' },
      },
      {
        Id: 'migrate',
        State: 'exited',
        Status: 'Exited (0) 2 hours ago',
        Labels: { 'ci-hub.appurn': 'ci-memory:ci-marketplace' },
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
  });

  /*
   * Every container exiting 0 means something stopped the app on purpose. A stop from the Hub reports
   * no crash, so this one doesn't either: no app.crashed for the agent, nothing to error reporting.
   */
  it('reports no crash for an app it marks stopped because every container exited cleanly', async () => {
    appRepository.getApps.mockResolvedValue([
      { id: 12, appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running', updatedAt: new Date().toISOString() },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'wp',
        State: 'exited',
        Status: 'Exited (0) 6 minutes ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
      {
        Id: 'db',
        State: 'exited',
        Status: 'Exited (0) 6 minutes ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(12, 'running', expect.objectContaining({ status: 'stopped' }));
    expect(agentNotifyService.notify).not.toHaveBeenCalled();
    expect(errorReportingService.reportAppFailure).not.toHaveBeenCalled();
  });

  it('still reports a crash when one of the stopped containers exited with an error', async () => {
    appRepository.getApps.mockResolvedValue([
      { id: 13, appName: 'wordpress', appStoreSlug: 'ci-marketplace', status: 'running', updatedAt: new Date().toISOString() },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        Id: 'wp',
        State: 'exited',
        Status: 'Exited (137) 1 minute ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
      {
        Id: 'db',
        State: 'exited',
        Status: 'Exited (0) 1 minute ago',
        Labels: { 'ci-hub.appurn': 'wordpress:ci-marketplace' },
      },
    ] as never);

    await service.syncAllAppStatuses();

    expect(appRepository.updateAppByIdIfStatus).toHaveBeenCalledWith(13, 'running', expect.objectContaining({ status: 'stopped' }));
    expect(agentNotifyService.notify).toHaveBeenCalledWith('app.crashed', expect.objectContaining({ appUrn: 'wordpress:ci-marketplace' }), 'high');
    expect(errorReportingService.reportAppFailure).toHaveBeenCalledWith(
      expect.objectContaining({ appUrn: 'wordpress:ci-marketplace', phase: 'crash' }),
    );
  });

  it('reports top-level sync failures to Sentry so crash detection outages are visible', async () => {
    const boom = new Error('docker list failed');
    appRepository.getApps.mockRejectedValue(boom);

    const result = await service.syncAllAppStatuses();

    expect(result.success).toBe(false);
    expect(errorReportingService.captureException).toHaveBeenCalledWith(boom, { surface: 'app-status-sync' });
  });

  it('attaches container logs when reporting a running → stopped crash', async () => {
    appRepository.getApps.mockResolvedValue([
      {
        id: 9,
        appName: 'remotion-studio',
        appStoreSlug: 'ci-marketplace',
        status: 'running',
        updatedAt: new Date().toISOString(),
      },
    ] as never);
    docker.listContainers.mockResolvedValue([
      {
        State: 'exited',
        Status: 'Exited (1) 2 seconds ago',
        Labels: { 'ci-os-hub.appurn': 'remotion-studio:ci-marketplace' },
      },
    ] as never);
    dockerReadFacade.diagnoseAppContainers.mockResolvedValue({
      unhealthy: [{ name: 'remotion-studio_ci-marketplace-1', state: 'Exited (1)', logs: 'Error: out of memory' }],
      healthy: [],
    });

    await service.syncAllAppStatuses();

    expect(dockerReadFacade.diagnoseAppContainers).toHaveBeenCalledWith('remotion-studio:ci-marketplace');
    expect(errorReportingService.reportAppFailure).toHaveBeenCalledWith({
      appUrn: 'remotion-studio:ci-marketplace',
      phase: 'crash',
      message: expect.stringContaining('Error: out of memory'),
      containers: [{ name: 'remotion-studio_ci-marketplace-1', state: 'Exited (1)', logs: 'Error: out of memory' }],
    });
  });

  describe('app containers without an app row', () => {
    // A database wiped while its apps kept running: the containers still carry the Hub's labels,
    // but no row names them, so nothing in the Hub can stop, expose, or uninstall them.
    const hermes = [
      {
        Id: 'h1',
        Names: ['/ci-hermes_ci-marketplace-ci-hermes-1'],
        State: 'running',
        Status: 'Up 4 days',
        Labels: { 'ci-hub.managed': 'true', 'ci-hub.appurn': 'ci-hermes:ci-marketplace' },
      },
      {
        Id: 'h2',
        Names: ['/ci-hermes_ci-marketplace-ci-hermes-gateway-1'],
        State: 'running',
        Status: 'Up 4 days',
        Labels: { 'ci-hub.appurn': 'ci-hermes:ci-marketplace' },
      },
    ];
    const tracked = {
      Id: 'f1',
      Names: ['/flatnotes_ci-marketplace-flatnotes-1'],
      State: 'running',
      Status: 'Up',
      Labels: { 'ci-hub.appurn': 'flatnotes:ci-marketplace' },
    };
    const warnings = () => logger.warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('without an app record'));

    beforeEach(() => {
      appRepository.getApps.mockResolvedValue([
        { id: 1, appName: 'flatnotes', appStoreSlug: 'ci-marketplace', status: 'running', updatedAt: new Date().toISOString() },
      ] as never);
    });

    it('names them once per URN, reports to Sentry, and leaves tracked apps and the containers alone', async () => {
      docker.listContainers.mockResolvedValue([...hermes, tracked] as never);

      await service.syncAllAppStatuses();
      await service.syncAllAppStatuses();

      expect(warnings()).toEqual([expect.stringContaining('ci-hermes:ci-marketplace')]);
      expect(warnings()[0]).toContain('ci-hermes_ci-marketplace-ci-hermes-1, ci-hermes_ci-marketplace-ci-hermes-gateway-1');
      expect(warnings()[0]).not.toContain('flatnotes');
      expect(errorReportingService.captureWarning).toHaveBeenCalledWith(
        'Hub app containers without an app record',
        { appUrn: 'ci-hermes:ci-marketplace', containers: ['ci-hermes_ci-marketplace-ci-hermes-1', 'ci-hermes_ci-marketplace-ci-hermes-gateway-1'] },
        expect.objectContaining({ debounceKey: 'app-status-sync:untracked:ci-hermes:ci-marketplace' }),
      );
      expect(appRepository.updateAppByIdIfStatus).not.toHaveBeenCalled();
    });

    it('reports again when the containers come back after being cleared', async () => {
      docker.listContainers.mockResolvedValue([...hermes, tracked] as never);
      await service.syncAllAppStatuses();
      docker.listContainers.mockResolvedValue([tracked] as never);
      await service.syncAllAppStatuses();
      docker.listContainers.mockResolvedValue([...hermes, tracked] as never);
      await service.syncAllAppStatuses();

      expect(warnings()).toHaveLength(2);
    });
  });
});
