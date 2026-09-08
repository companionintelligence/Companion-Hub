import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import type Dockerode from 'dockerode';
import { TelemetryFeedbackService } from '../telemetry-feedback.service';

describe('TelemetryFeedbackService', () => {
  let service: TelemetryFeedbackService;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let errorReporting: ReturnType<typeof mock<ErrorReportingService>>;
  let hostTelemetry: ReturnType<typeof mock<HostTelemetryService>>;
  let docker: ReturnType<typeof mock<Dockerode>>;

  beforeEach(() => {
    logger = mock<LoggerService>();
    errorReporting = mock<ErrorReportingService>();
    hostTelemetry = mock<HostTelemetryService>();
    docker = mock<Dockerode>();

    errorReporting.isEnabled.mockReturnValue(true);
    hostTelemetry.recordEvent.mockResolvedValue();

    service = new TelemetryFeedbackService(logger, errorReporting, hostTelemetry, docker);
  });

  it('captures and reports a container crash loop', async () => {
    const report = await service.captureCrashLoop({
      containerId: 'c-123456',
      containerName: 'photoprism_app_1',
      appUrn: 'ci-marketplace/photoprism',
      restartCount: 5,
      exitCode: 137,
      logs: 'OOMKilled: out of memory',
    });

    expect(report.id).toBeDefined();
    expect(report.type).toBe('crash_loop');
    expect(report.appUrn).toBe('ci-marketplace/photoprism');
    expect(report.restartCount).toBe(5);
    expect(report.exitCode).toBe(137);
    expect(report.logs).toContain('OOMKilled');

    expect(errorReporting.reportAppFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        appUrn: 'ci-marketplace/photoprism',
        phase: 'crash',
        errorCode: 'container_crash_loop',
      }),
    );

    expect(hostTelemetry.recordEvent).toHaveBeenCalledWith(
      'warn',
      'container.crash_loop',
      expect.any(String),
      expect.objectContaining({
        containerId: 'c-123456',
        containerName: 'photoprism_app_1',
        restartCount: 5,
      }),
    );

    const crashReports = service.getCrashLoopReports();
    expect(crashReports).toHaveLength(1);
    expect(crashReports[0]?.id).toBe(report.id);
  });

  it('captures and reports an install failure', async () => {
    const report = await service.captureInstallFailure({
      appUrn: 'ci-marketplace/nextcloud',
      error: new Error('Docker network subnet collision'),
      errorCode: 'network_overlap',
      durationMs: 4500,
      phase: 'install',
    });

    expect(report.id).toBeDefined();
    expect(report.type).toBe('install_failure');
    expect(report.appUrn).toBe('ci-marketplace/nextcloud');
    expect(report.message).toBe('Docker network subnet collision');
    expect(report.errorCode).toBe('network_overlap');
    expect(report.durationMs).toBe(4500);

    expect(errorReporting.reportAppFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        appUrn: 'ci-marketplace/nextcloud',
        phase: 'install',
        errorCode: 'network_overlap',
      }),
    );

    expect(hostTelemetry.recordEvent).toHaveBeenCalledWith(
      'error',
      'app.install_failure',
      expect.stringContaining('Docker network subnet collision'),
      expect.objectContaining({
        appUrn: 'ci-marketplace/nextcloud',
        errorCode: 'network_overlap',
      }),
    );

    const installReports = service.getInstallFailureReports();
    expect(installReports).toHaveLength(1);
    expect(installReports[0]?.id).toBe(report.id);
  });

  it('scans and detects crash loops from docker containers', async () => {
    const mockContainerHealthy = {
      inspect: vi.fn().mockResolvedValue({
        State: { Restarting: false, ExitCode: 0 },
        RestartCount: 0,
        Name: '/healthy_container',
      }),
    };

    const mockContainerRestarting = {
      inspect: vi.fn().mockResolvedValue({
        State: { Restarting: true, ExitCode: 1, Error: 'Executable not found' },
        RestartCount: 6,
        Name: '/restarting_app',
        Config: {
          Labels: {
            'ci.app.urn': 'ci-marketplace/broken-app',
          },
        },
      }),
      logs: vi.fn().mockResolvedValue(Buffer.from('panic: binary not found in PATH')),
    };

    docker.listContainers.mockResolvedValue([
      { Id: 'healthy-id', Names: ['/healthy_container'] } as any,
      { Id: 'restarting-id', Names: ['/restarting_app'] } as any,
    ]);

    docker.getContainer.mockImplementation((id: string) => {
      if (id === 'restarting-id') return mockContainerRestarting as any;
      return mockContainerHealthy as any;
    });

    const detected = await service.detectCrashLoops(3);

    expect(detected).toHaveLength(1);
    expect(detected[0]?.containerId).toBe('restarting-id');
    expect(detected[0]?.containerName).toBe('restarting_app');
    expect(detected[0]?.appUrn).toBe('ci-marketplace/broken-app');
    expect(detected[0]?.restartCount).toBe(6);
    expect(detected[0]?.logs).toContain('panic: binary not found');
  });

  it('tracks summary metrics and clears reports', async () => {
    await service.captureCrashLoop({
      containerName: 'c1',
      appUrn: 'app1',
      restartCount: 4,
    });

    await service.captureInstallFailure({
      appUrn: 'app2',
      error: 'Install timeout',
    });

    const summary = service.getSummary();
    expect(summary.totalCrashLoops).toBe(1);
    expect(summary.totalInstallFailures).toBe(1);
    expect(summary.recentCount).toBe(2);
    expect(summary.lastCrashLoopAt).toBeDefined();
    expect(summary.lastInstallFailureAt).toBeDefined();

    const all = service.getAllReports();
    expect(all).toHaveLength(2);

    service.clearReports();
    expect(service.getAllReports()).toHaveLength(0);
    expect(service.getSummary().recentCount).toBe(0);
  });
});
