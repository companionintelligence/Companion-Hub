import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { SSEService } from '@/core/sse/sse.service';
import { Injectable, Optional } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { AppOperationRegistry } from '../app-lifecycle/app-operation-registry';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsRepository } from '../apps/apps.repository';
import { AppEventsQueue } from '../queue/entities/app-events';
import { BackupManager } from './backup.manager';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';

/**
 * Each call on one app's backups names its actor and asks the lifecycle's own gate
 * (`AppLifecycleService.assertActorMay`) before it reads, writes or queues anything. The MCP
 * backup tools reached all of these with no grant check, so a restore that overwrites an app's
 * data was open to any key that could restart it (CI-Hub#1397).
 */
@Injectable()
export class BackupsService {
  constructor(
    private appsRepository: AppsRepository,
    private logger: LoggerService,
    private config: ConfigurationService,
    private appEventsQueue: AppEventsQueue,
    private appLifecycle: AppLifecycleService,
    private appFilesManager: AppFilesManager,
    private backupManager: BackupManager,
    private readonly sseService: SSEService,
    private readonly operationRegistry: AppOperationRegistry,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  public async backupApp(params: { appUrn: AppUrn; actor: LifecycleActor }) {
    const { appUrn } = params;

    // A managed app key needs `full` to back up another app: each backup's retention cleanup deletes
    // that app's oldest backups, which is deleting them.
    await this.appLifecycle.assertActorMay(params.actor, appUrn, 'backup');

    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    const appStatusBeforeUpdate = app.status;

    // Run script
    await this.appsRepository.updateAppById(app.id, { status: 'backing_up' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'backing_up' });

    const requestId = crypto.randomUUID();
    this.operationRegistry.register(appUrn, { requestId, command: 'backup', tier: 'non_cancellable' });

    this.appEventsQueue.publish({ appUrn, command: 'backup', requestId, form: app.config }).then(async ({ success, message }) => {
      if (success) {
        if (!this.operationRegistry.claimCompletion(appUrn, requestId)) {
          return;
        }

        if (appStatusBeforeUpdate === 'running') {
          // Part of the backup the caller was authorized for: the app only comes back to how it was.
          await this.resumeApp(app.id, appUrn, 'resume-after-backup');
        } else {
          await this.appsRepository.updateAppById(app.id, { status: appStatusBeforeUpdate });
          this.sseService.emit('app', { event: 'backup_success', appUrn, appStatus: appStatusBeforeUpdate });
        }
      } else {
        this.logger.error(`Failed to backup app ${appUrn}: ${message}`);
        if (this.operationRegistry.claimCompletion(appUrn, requestId)) {
          await this.appsRepository.updateAppById(app.id, { status: 'stopped' });
          // The DB row moves to 'stopped'; without this the page keeps showing "backing up" and the person is
          // never told it failed (the client already has a toast for this event, but nothing sent it).
          this.sseService.emit('app', { event: 'backup_error', appUrn, appStatus: 'stopped' });
          this.agentNotifyService?.notify('backup_error', { appUrn }, 'high');
        }
      }
    });

    return { requestId };
  }

  public async restoreApp(params: { appUrn: AppUrn; filename: string; actor: LifecycleActor }) {
    const { appUrn, filename } = params;

    await this.appLifecycle.assertActorMay(params.actor, appUrn, 'restore');

    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    const appStatusBeforeUpdate = app.status;

    // Run script
    await this.appsRepository.updateAppById(app.id, { status: 'restoring' });
    this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'restoring' });

    const requestId = crypto.randomUUID();
    this.operationRegistry.register(appUrn, { requestId, command: 'restore', tier: 'non_cancellable' });

    this.appEventsQueue.publish({ appUrn, command: 'restore', requestId, filename, form: app.config }).then(async ({ success, message }) => {
      if (success) {
        if (!this.operationRegistry.claimCompletion(appUrn, requestId)) {
          return;
        }

        const restoredAppConfig = await this.appFilesManager.getInstalledAppInfo(appUrn);

        if (typeof restoredAppConfig?.cihub_app_version === 'number') {
          await this.appsRepository.updateAppById(app.id, { version: restoredAppConfig.cihub_app_version });
        }

        if (appStatusBeforeUpdate === 'running') {
          // Part of the restore the caller was authorized for: the app only comes back to how it was.
          await this.resumeApp(app.id, appUrn, 'resume-after-restore');
        } else {
          await this.appsRepository.updateAppById(app.id, { status: appStatusBeforeUpdate });
          this.sseService.emit('app', { event: 'restore_success', appUrn, appStatus: appStatusBeforeUpdate });
        }
      } else {
        this.logger.error(`Failed to restore app ${appUrn}: ${message}`);
        if (this.operationRegistry.claimCompletion(appUrn, requestId)) {
          await this.appsRepository.updateAppById(app.id, { status: 'stopped' });
          this.sseService.emit('app', { event: 'restore_error', appUrn, appStatus: 'stopped' });
          this.agentNotifyService?.notify('restore_error', { appUrn }, 'high');
        }
      }
    });

    return { requestId };
  }

  /**
   * Start an app that a backup or restore stopped. `startApp` refuses while the queue
   * is down, and this runs in a detached `.then` with no catch, so a refusal became an
   * unhandled rejection and left the app in `backing_up` or `restoring` even though the
   * command had already stopped its containers.
   */
  private async resumeApp(appId: number, appUrn: AppUrn, reason: 'resume-after-backup' | 'resume-after-restore') {
    try {
      await this.appLifecycle.startApp({ appUrn, actor: { kind: 'system', reason } });
    } catch (error) {
      this.logger.error(`Could not start ${appUrn} again (${reason}); it stays stopped`, error);
      await this.appsRepository.updateAppById(appId, { status: 'stopped' });
      this.sseService.emit('app', { event: 'status_change', appUrn, appStatus: 'stopped' });
    }
  }

  public async getAppBackups(params: { appUrn: AppUrn; page: number; pageSize: number; actor: LifecycleActor }) {
    const { appUrn, page, pageSize } = params;

    await this.appLifecycle.assertActorMay(params.actor, appUrn, 'view');

    const backups = await this.backupManager.listBackupsByAppId(appUrn);

    backups.sort((a, b) => b.date - a.date);

    // Pages count from 1. A page below that (the route used to default to 0) turned `start` negative,
    // and `slice(-10, 0)` is an empty list however many backups there are.
    const start = (Math.max(1, Math.trunc(page) || 1) - 1) * pageSize;
    const end = start + pageSize;
    const data = backups.slice(start, end);

    return {
      data,
      total: backups.length,
      currentPage: Math.floor(start / pageSize) + 1,
      lastPage: Math.ceil(backups.length / pageSize),
    };
  }

  public async deleteAppBackup(params: { appUrn: AppUrn; filename: string; actor: LifecycleActor }): Promise<void> {
    const { appUrn, filename } = params;

    // A managed app key needs `full` to delete another app's backups.
    await this.appLifecycle.assertActorMay(params.actor, appUrn, 'backup');

    await this.backupManager.deleteBackup(appUrn, filename);
  }

  async backupAllApps(actor: LifecycleActor) {
    const apps = await this.appsRepository.getApps();
    const runningApps = apps.filter((app) => app.status === 'running');

    for (const app of runningApps) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      // Not awaited, so every backup starts at once, as before. `backupApp` rejects rather than throws —
      // a refused actor, demo mode, a missing app — so the failure is caught on its promise; a try/catch
      // around the call never saw one, and each was left an unhandled rejection.
      void this.backupApp({ appUrn, actor }).catch((e) => this.logger.error(`Failed to backup app ${app.id}`, e));
    }
  }

  public async getBackupFilePath(params: { appUrn: AppUrn; filename: string }): Promise<string> {
    const { appUrn, filename } = params;
    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    return this.backupManager.getBackupPath(appUrn, filename);
  }

  public async uploadBackup(params: { appUrn: AppUrn; filename: string; fileBuffer: Buffer }): Promise<void> {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { appUrn, filename, fileBuffer } = params;
    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn });
    }

    await this.backupManager.uploadBackup(appUrn, filename, fileBuffer);
  }
}
