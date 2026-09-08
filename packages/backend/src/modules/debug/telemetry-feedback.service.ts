import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type Dockerode from 'dockerode';
import { randomUUID } from 'node:crypto';

export interface CrashLoopParams {
  containerId?: string;
  containerName?: string;
  appUrn?: string;
  appName?: string;
  restartCount?: number;
  exitCode?: number;
  error?: string;
  logs?: string;
  metadata?: Record<string, unknown>;
}

export interface CrashLoopReport {
  id: string;
  type: 'crash_loop';
  appUrn: string;
  containerId?: string;
  containerName?: string;
  restartCount: number;
  exitCode?: number;
  error: string;
  logs?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
}

export interface InstallFailureParams {
  appUrn: string;
  error: string | Error;
  errorCode?: string;
  durationMs?: number;
  phase?: string;
  metadata?: Record<string, unknown>;
  containers?: Array<{ name: string; state: string; logs?: string }>;
}

export interface InstallFailureReport {
  id: string;
  type: 'install_failure';
  appUrn: string;
  message: string;
  errorCode?: string;
  durationMs?: number;
  phase: string;
  metadata: Record<string, unknown>;
  containers?: Array<{ name: string; state: string; logs?: string }>;
  capturedAt: string;
}

export type TelemetryFeedbackReport = CrashLoopReport | InstallFailureReport;

export interface TelemetryFeedbackSummary {
  totalCrashLoops: number;
  totalInstallFailures: number;
  lastCrashLoopAt?: string;
  lastInstallFailureAt?: string;
  recentCount: number;
}

/**
 * Service for capturing and reporting container crash loops and app install failures
 * into appliance error telemetry, host event logs, and operational feedback loops.
 */
@Injectable()
export class TelemetryFeedbackService {
  private readonly maxBufferSize = 200;
  private readonly crashLoopReports: CrashLoopReport[] = [];
  private readonly installFailureReports: InstallFailureReport[] = [];

  constructor(
    private readonly logger: LoggerService,
    @Optional() private readonly errorReporting?: ErrorReportingService,
    @Optional() private readonly hostTelemetry?: HostTelemetryService,
    @Optional() @Inject(DOCKERODE) private readonly docker?: Dockerode,
  ) {}

  /**
   * Capture and report a container crash loop.
   */
  async captureCrashLoop(params: CrashLoopParams): Promise<CrashLoopReport> {
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const appUrn = params.appUrn ?? params.appName ?? 'system';
    const restartCount = params.restartCount ?? 1;
    const errorMsg =
      params.error ||
      `Container ${params.containerName || params.containerId || 'unknown'} is crash looping (restarts: ${restartCount}, exit code: ${params.exitCode ?? 'unknown'})`;

    const report: CrashLoopReport = {
      id,
      type: 'crash_loop',
      appUrn,
      containerId: params.containerId,
      containerName: params.containerName,
      restartCount,
      exitCode: params.exitCode,
      error: errorMsg,
      logs: params.logs,
      metadata: params.metadata ?? {},
      capturedAt,
    };

    this.crashLoopReports.unshift(report);
    if (this.crashLoopReports.length > this.maxBufferSize) {
      this.crashLoopReports.pop();
    }

    this.logger.warn(`[telemetry-feedback] Container crash loop detected: ${errorMsg} (app=${appUrn})`);

    // Report to error reporting (Sentry)
    if (this.errorReporting?.isEnabled()) {
      try {
        this.errorReporting.reportAppFailure({
          appUrn,
          phase: 'crash',
          message: errorMsg,
          errorCode: 'container_crash_loop',
          containers: params.containerName ? [{ name: params.containerName, state: 'restarting', logs: params.logs }] : undefined,
        });
      } catch (err) {
        this.logger.warn(`Failed to report crash loop to ErrorReportingService: ${err}`);
      }
    }

    // Report to host telemetry event log
    if (this.hostTelemetry) {
      try {
        await this.hostTelemetry.recordEvent('warn', 'container.crash_loop', errorMsg, {
          appUrn,
          containerId: params.containerId,
          containerName: params.containerName,
          restartCount,
          exitCode: params.exitCode,
          logsSnippet: params.logs?.slice(-500),
          ...params.metadata,
        });
      } catch (err) {
        this.logger.warn(`Failed to record crash loop event to HostTelemetryService: ${err}`);
      }
    }

    return report;
  }

  /**
   * Capture and report an application install failure.
   */
  async captureInstallFailure(params: InstallFailureParams): Promise<InstallFailureReport> {
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const errorMessage = params.error instanceof Error ? params.error.message : String(params.error);
    const phase = params.phase ?? 'install';

    const report: InstallFailureReport = {
      id,
      type: 'install_failure',
      appUrn: params.appUrn,
      message: errorMessage,
      errorCode: params.errorCode,
      durationMs: params.durationMs,
      phase,
      metadata: params.metadata ?? {},
      containers: params.containers,
      capturedAt,
    };

    this.installFailureReports.unshift(report);
    if (this.installFailureReports.length > this.maxBufferSize) {
      this.installFailureReports.pop();
    }

    this.logger.error(`[telemetry-feedback] App install failure for ${params.appUrn}: ${errorMessage}`);

    // Report to error reporting (Sentry)
    if (this.errorReporting?.isEnabled()) {
      try {
        this.errorReporting.reportAppFailure({
          appUrn: params.appUrn,
          phase: 'install',
          message: errorMessage,
          errorCode: params.errorCode,
          containers: params.containers,
        });
      } catch (err) {
        this.logger.warn(`Failed to report install failure to ErrorReportingService: ${err}`);
      }
    }

    // Report to host telemetry event log
    if (this.hostTelemetry) {
      try {
        await this.hostTelemetry.recordEvent('error', 'app.install_failure', `Install failed: ${errorMessage}`, {
          appUrn: params.appUrn,
          errorCode: params.errorCode,
          phase,
          durationMs: params.durationMs,
          ...params.metadata,
        });
      } catch (err) {
        this.logger.warn(`Failed to record install failure event to HostTelemetryService: ${err}`);
      }
    }

    return report;
  }

  /**
   * Scan docker containers to automatically detect crash looping containers.
   * A container is considered crash looping if State.Restarting is true or
   * RestartCount exceeds the given threshold.
   */
  async detectCrashLoops(restartThreshold = 3): Promise<CrashLoopReport[]> {
    if (!this.docker) {
      this.logger.debug?.('[telemetry-feedback] Dockerode not injected, skipping auto-detection');
      return [];
    }

    const detected: CrashLoopReport[] = [];

    try {
      const containerInfos = await this.docker.listContainers({ all: true });

      for (const info of containerInfos) {
        try {
          const container = this.docker.getContainer(info.Id);
          const inspection = await container.inspect();

          const isRestarting = inspection.State?.Restarting === true;
          const restartCount = inspection.RestartCount ?? 0;
          const exitCode = inspection.State?.ExitCode;

          if (isRestarting || restartCount >= restartThreshold) {
            let logs: string | undefined;
            try {
              const rawLogs = await container.logs({
                stdout: true,
                stderr: true,
                tail: 50,
                timestamps: false,
              });
              logs = Buffer.isBuffer(rawLogs) ? rawLogs.toString('utf8') : String(rawLogs);
            } catch {
              // Best-effort log retrieval
            }

            const containerName = inspection.Name?.replace(/^\//, '');
            const appUrn = inspection.Config?.Labels?.['com.docker.compose.project'] ?? inspection.Config?.Labels?.['ci.app.urn'] ?? containerName;

            const report = await this.captureCrashLoop({
              containerId: info.Id,
              containerName,
              appUrn,
              restartCount,
              exitCode,
              logs,
              error: inspection.State?.Error || undefined,
            });

            detected.push(report);
          }
        } catch (inspectErr) {
          this.logger.debug?.(`Failed to inspect container ${info.Id}: ${inspectErr}`);
        }
      }
    } catch (listErr) {
      this.logger.warn(`[telemetry-feedback] Failed to list containers for crash loop detection: ${listErr}`);
    }

    return detected;
  }

  /**
   * Retrieve recorded crash loop reports.
   */
  getCrashLoopReports(limit = 50): CrashLoopReport[] {
    return this.crashLoopReports.slice(0, limit);
  }

  /**
   * Retrieve recorded install failure reports.
   */
  getInstallFailureReports(limit = 50): InstallFailureReport[] {
    return this.installFailureReports.slice(0, limit);
  }

  /**
   * Retrieve all recorded feedback reports, ordered newest first.
   */
  getAllReports(limit = 100): TelemetryFeedbackReport[] {
    const combined: TelemetryFeedbackReport[] = [...this.crashLoopReports, ...this.installFailureReports];
    combined.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return combined.slice(0, limit);
  }

  /**
   * Clear in-memory feedback history (useful in testing or manual reset).
   */
  clearReports(): void {
    this.crashLoopReports.length = 0;
    this.installFailureReports.length = 0;
  }

  /**
   * Get statistical summary of reported telemetry events.
   */
  getSummary(): TelemetryFeedbackSummary {
    return {
      totalCrashLoops: this.crashLoopReports.length,
      totalInstallFailures: this.installFailureReports.length,
      lastCrashLoopAt: this.crashLoopReports[0]?.capturedAt,
      lastInstallFailureAt: this.installFailureReports[0]?.capturedAt,
      recentCount: this.crashLoopReports.length + this.installFailureReports.length,
    };
  }
}
