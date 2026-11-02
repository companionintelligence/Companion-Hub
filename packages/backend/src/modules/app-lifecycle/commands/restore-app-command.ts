import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DockerService } from '@/modules/docker/docker.service';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import { AppLifecycleCommand } from './command';

export class RestoreAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly filename: string,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const backupManager = this.moduleRef.get(BackupManager, { strict: false });

    try {
      // Stop the app
      logger.info(`Stopping app ${appUrn} for restore operation`);
      await dockerService.composeApp(appUrn, 'stop').catch((err) => {
        logger.error(`Failed to stop app ${appUrn}:`, err);
      });

      const sseService = this.moduleRef.get(SSEService, { strict: false });
      // Data only (appFiles defaults to 'keep'): the archive may be one somebody uploaded.
      await backupManager.restoreApp(appUrn, this.filename, undefined, {
        onProgress: (dataProgress) => sseService?.emit('app', { event: 'status_change', appUrn, appStatus: 'restoring', dataProgress }),
      });

      // Done
      logger.info(`App ${appUrn} restored!`);
      return { success: true, message: `App ${appUrn} restored successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'restore');
    }
  }
}
