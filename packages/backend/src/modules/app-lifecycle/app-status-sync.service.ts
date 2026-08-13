import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { DOCKERODE } from '../docker/constants';
import { DockerReadFacade } from '../docker/docker-read.facade';
import { AppsRepository } from '../apps/apps.repository';
import { InstallPipelineTracker } from '../apps/install-pipeline.tracker';
import type { AppStatus } from '@/core/database/drizzle/types';
import { SystemEventsQueue } from '../queue/entities/system-events';
import { DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { NetworkDiagnosticsService } from '../network/network-diagnostics.service';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { AppOperationRegistry } from './app-operation-registry';

const LONG_RUNNING_TRANSITIONAL_STATES: AppStatus[] = ['installing', 'updating'];

const TRANSITIONAL_STATES: AppStatus[] = [
  'installing',
  'uninstalling',
  'stopping',
  'starting',
  'updating',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
];

@Injectable()
export class AppStatusSyncService {
  constructor(
    private readonly logger: LoggerService,
    private readonly appRepository: AppsRepository,
    private readonly sseService: SSEService,
    private readonly systemEventsQueue: SystemEventsQueue,
    private readonly configuration: ConfigurationService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly installPipelineTracker: InstallPipelineTracker,
    private readonly operationRegistry: AppOperationRegistry,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
    @Optional() private readonly errorReportingService?: ErrorReportingService,
    @Optional() private readonly networkDiagnostics?: NetworkDiagnosticsService,
    @Optional() private readonly dockerReadFacade?: DockerReadFacade,
  ) {
    if (this.configuration.get('userSettings').eventsTimeout > 5) {
      const eventsTimeout = this.configuration.get('userSettings').eventsTimeout;
      this.logger.warn(
        `You have set a high events timeout of ${eventsTimeout} minutes. Consider lowering if app status syncs are not occurring as expected.`,
      );
      this.errorReportingService?.captureWarning(
        'App status sync configured with a high events timeout',
        { eventsTimeoutMinutes: eventsTimeout },
        { debounceKey: 'app-status-sync:high-events-timeout', debounceMs: 60 * 60_000 },
      );
    }

    this.systemEventsQueue.onEvent(async (data, reply) => {
      if (data.command === 'sync_app_statuses') {
        const result = await this.syncAllAppStatuses();
        await reply(result);
        return;
      }

      if (data.command === 'reconcile_orphan_networks') {
        if (!this.networkDiagnostics) {
          await reply({ success: false, message: 'Network diagnostics unavailable' });
          return;
        }

        const result = await this.networkDiagnostics.reconcileOrphanNetworks();
        await reply(result);
      }
    });
  }

  async syncAllAppStatuses() {
    try {
      this.logger.debug('Starting app status sync');

      const apps = await this.appRepository.getApps();
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['ci-os-hub.managed=true'] },
      });

      const dockerStatusMap = new Map<string, { running: number; exitZero: number; total: number }>();

      for (const container of containers) {
        const appUrn = container.Labels?.['ci-os-hub.appurn'];
        if (!appUrn) continue;

        if (!dockerStatusMap.has(appUrn)) {
          dockerStatusMap.set(appUrn, { running: 0, exitZero: 0, total: 0 });
        }

        const status = dockerStatusMap.get(appUrn);
        if (status) {
          status.total++;
          if (container.State === 'running') status.running++;
          if (container.State === 'exited' && /Exited \(0\)/.test(container.Status)) status.exitZero++;
        }
      }

      let syncedCount = 0;
      let skippedCount = 0;

      for (const app of apps) {
        const appUrn: AppUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;

        const isTransitional = TRANSITIONAL_STATES.includes(app.status);
        const transitionalGraceMs = this.getTransitionalGraceMs(app.status);
        if (isTransitional) {
          const timeSinceUpdate = Date.now() - new Date(app.updatedAt).getTime();
          if (timeSinceUpdate < transitionalGraceMs) {
            this.logger.debug(`Skipping ${appUrn} - in recent transitional state '${app.status}'`);
            skippedCount++;
            continue;
          }
          const minutesStuck = Math.round(timeSinceUpdate / 60000);
          this.logger.warn(`App ${appUrn} stuck in '${app.status}' for ${minutesStuck} minutes`);
          this.errorReportingService?.captureWarning(
            `App ${appUrn} stuck in '${app.status}'`,
            { appUrn, status: app.status, minutesStuck },
            { debounceKey: `app-status-sync:stuck:${appUrn}:${app.status}`, debounceMs: 30 * 60_000 },
          );
        }

        // Port-expose workloads are not Docker-managed; keep them running so Traefik
        // and Cloudflare exposure sync continue to treat them as available.
        if (isPortExposeApp(app.config)) {
          if (app.status === 'uninstalling') {
            skippedCount++;
            continue;
          }

          if (app.status === 'running') {
            skippedCount++;
          } else {
            await this.appRepository.updateAppById(app.id, { status: 'running' });
            this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'running' });
            this.logger.info(`Synced ${appUrn}: '${app.status}' -> 'running' (port-expose)`);
            syncedCount++;
          }
          continue;
        }

        const dockerStatus = dockerStatusMap.get(appUrn);
        let newStatus: AppStatus;

        if (!dockerStatus || dockerStatus.total === 0) {
          if (app.status === 'install_failed') {
            skippedCount++;
            continue;
          }

          if (app.status === 'installing') {
            const timeSinceUpdate = Date.now() - new Date(app.updatedAt).getTime();
            const stillLive = this.installPipelineTracker.getActive() === appUrn || Boolean(this.operationRegistry.get(appUrn));
            if (timeSinceUpdate < transitionalGraceMs || stillLive) {
              skippedCount++;
              continue;
            }

            const applied = await this.appRepository.updateAppByIdIfStatus(app.id, 'installing', { status: 'install_failed' });
            if (!applied) {
              skippedCount++;
              continue;
            }

            const message = `Install stalled with no containers after ${Math.round(timeSinceUpdate / 60000)} minutes. Retry the install.`;
            this.sseService.emit('app', {
              event: 'install_error',
              appUrn,
              appStatus: 'install_failed',
              error: message,
            });
            this.logger.warn(`Healed stranded install ${appUrn}: 'installing' -> 'install_failed'`);
            this.agentNotifyService?.notify('install_error', { appUrn }, 'high');
            this.errorReportingService?.reportAppFailure({
              appUrn,
              phase: 'install',
              message,
            });
            syncedCount++;
            continue;
          }

          newStatus = 'missing';
        } else if (dockerStatus.running + dockerStatus.exitZero === dockerStatus.total) {
          newStatus = 'running';
        } else {
          newStatus = 'stopped';
          if (dockerStatus.running > 0) {
            this.logger.warn(`App ${appUrn} has mixed container states: ${dockerStatus.running}/${dockerStatus.total} running`);
            this.errorReportingService?.captureWarning(
              `App ${appUrn} has mixed container states`,
              { appUrn, runningContainers: dockerStatus.running, totalContainers: dockerStatus.total },
              { debounceKey: `app-status-sync:mixed:${appUrn}`, debounceMs: 30 * 60_000 },
            );
          }
        }

        if (app.status !== newStatus) {
          const applied = await this.appRepository.updateAppByIdIfStatus(app.id, app.status, { status: newStatus });
          if (!applied) {
            this.logger.debug(`Skipped ${appUrn}: status changed since sync snapshot ('${app.status}' -> '${newStatus}')`);
            skippedCount++;
            continue;
          }

          this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: newStatus });
          this.logger.info(`Synced ${appUrn}: '${app.status}' -> '${newStatus}'`);

          // Detect crash: running → stopped or missing
          if (app.status === 'running' && (newStatus === 'stopped' || newStatus === 'missing')) {
            this.agentNotifyService?.notify('app.crashed', { appUrn, previousStatus: app.status, newStatus }, 'high');
            await this.reportAppCrash(appUrn, app.status, newStatus);
          }
          syncedCount++;
        }
      }

      this.logger.debug(`App status sync completed: ${syncedCount} synced, ${skippedCount} skipped`);

      return {
        success: true,
        message: `Synced ${syncedCount} apps`,
        syncedCount,
        skippedCount,
        totalApps: apps.length,
      };
    } catch (error) {
      this.logger.error('Error during app status sync:', error);
      // Status sync is what detects app crashes. If the loop itself dies and we
      // only log locally, crash detection goes dark with no Sentry signal.
      this.errorReportingService?.captureException(error, { surface: 'app-status-sync' });

      return {
        success: false,
        message: `Error during sync: ${String(error)}`,
        syncedCount: 0,
        skippedCount: 0,
        totalApps: 0,
      };
    }
  }

  /**
   * Report a marketplace app crash with the same container-log trail post_start
   * already attaches. Without logs, Sentry only said "transitioned from running
   * to stopped" — useless for figuring out why the app died.
   */
  private async reportAppCrash(appUrn: AppUrn, previousStatus: AppStatus, newStatus: AppStatus): Promise<void> {
    let containers: Array<{ name: string; state: string; logs?: string }> | undefined;
    let message = `App transitioned from ${previousStatus} to ${newStatus} during status sync`;

    if (this.dockerReadFacade) {
      try {
        const diag = await this.dockerReadFacade.diagnoseAppContainers(appUrn);
        if (diag.unhealthy.length > 0) {
          containers = diag.unhealthy;
          const logSummary = diag.unhealthy.map((container) => `${container.name} (${container.state}): ${container.logs || '(no logs)'}`).join('\n');
          message = `${message}\n${logSummary}`;
        }
      } catch (diagError) {
        this.logger.warn(`Failed to capture container logs for crashed app ${appUrn}: ${String(diagError)}`);
      }
    }

    this.errorReportingService?.reportAppFailure({
      appUrn,
      phase: 'crash',
      message,
      containers,
    });
  }

  private getTransitionalGraceMs(status: AppStatus): number {
    const eventsTimeoutMinutes = this.configuration.get('userSettings').eventsTimeout;
    const minutes = LONG_RUNNING_TRANSITIONAL_STATES.includes(status)
      ? Math.max(eventsTimeoutMinutes, Number(DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES))
      : eventsTimeoutMinutes;
    return minutes * 60 * 1000;
  }
}
