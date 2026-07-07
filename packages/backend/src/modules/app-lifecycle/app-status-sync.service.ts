import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { DOCKERODE } from '../docker/constants';
import { AppsRepository } from '../apps/apps.repository';
import type { AppStatus } from '@/core/database/drizzle/types';
import { SystemEventsQueue } from '../queue/entities/system-events';
import { DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { NetworkDiagnosticsService } from '../network/network-diagnostics.service';
import { isPortExposeApp } from '@ci-hub/common/schemas';

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
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
    @Optional() private readonly errorReportingService?: ErrorReportingService,
    @Optional() private readonly networkDiagnostics?: NetworkDiagnosticsService,
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
          // Large image pulls can exceed the default queue grace; don't mark as missing mid-install.
          if (app.status === 'installing' || app.status === 'install_failed') {
            skippedCount++;
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
          await this.appRepository.updateAppById(app.id, { status: newStatus });
          this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: newStatus });
          this.logger.info(`Synced ${appUrn}: '${app.status}' -> '${newStatus}'`);

          // Detect crash: running → stopped or missing
          if (app.status === 'running' && (newStatus === 'stopped' || newStatus === 'missing')) {
            this.agentNotifyService?.notify('app.crashed', { appUrn, previousStatus: app.status, newStatus }, 'high');
            this.errorReportingService?.reportAppFailure({
              appUrn,
              phase: 'crash',
              message: `App transitioned from ${app.status} to ${newStatus} during status sync`,
            });
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

      return {
        success: false,
        message: `Error during sync: ${String(error)}`,
        syncedCount: 0,
        skippedCount: 0,
        totalApps: 0,
      };
    }
  }

  private getTransitionalGraceMs(status: AppStatus): number {
    const eventsTimeoutMinutes = this.configuration.get('userSettings').eventsTimeout;
    const minutes = LONG_RUNNING_TRANSITIONAL_STATES.includes(status)
      ? Math.max(eventsTimeoutMinutes, Number(DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES))
      : eventsTimeoutMinutes;
    return minutes * 60 * 1000;
  }
}
