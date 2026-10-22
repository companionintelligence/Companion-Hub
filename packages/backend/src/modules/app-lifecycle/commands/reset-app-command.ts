import { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { removeAppDataDirWithRootFallback } from '@/modules/docker/app-data-removal';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleCommand } from './command';

export class ResetAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const filesystem = this.moduleRef.get(FilesystemService, { strict: false });
    const configuration = this.moduleRef.get(ConfigurationService, { strict: false });
    // The root delete gets what is left of the budget a command has, so the reset answers the queue in time.
    const deadline = AppCommandDeadline.forAppCommand(configuration?.get('userSettings')?.eventsTimeout);

    try {
      logger.info(`Resetting app ${appUrn}`);

      await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

      // Stop app
      try {
        await dockerService.composeApp(appUrn, 'down --remove-orphans --volumes');
      } catch (err) {
        if (err instanceof Error && err.message.includes('conflict')) {
          logger.warn(`Could not reset app ${appUrn}. Most likely there have been made changes to the compose file.`);
        } else {
          throw err;
        }
      }

      // Delete app data directory. A reset that left the old data in place used to say it had reset
      // the app: on a native-Linux Hub, everything a root container wrote survived the Hub's delete.
      const { appDataDir } = appFilesManager.getAppPaths(appUrn);
      if (!(await removeAppDataDirWithRootFallback({ filesystem, docker: dockerService, logger }, appUrn, appDataDir, deadline))) {
        // The app is down and the Hub's own files (app.env first) may be gone with part of the data.
        // Put back what a Start needs, so the app can be started again as it was instead of failing on
        // a missing env file, and say the reset did not happen.
        try {
          await appFilesManager.createAppDataDir(appUrn);
          await appHelpers.generateEnvFile(appUrn, form);
          await appFilesManager.createVolumeHostDirs(appUrn);
        } catch (err) {
          logger.warn(`Could not put back the files ${appUrn} needs to start after the failed reset: ${err}`);
        }
        throw new Error(
          deadline.expired
            ? `Could not delete the data of ${appUrn} in the ${deadline.describe()} a reset has for it, so it was not reset`
            : `Could not delete the data of ${appUrn}, so it was not reset`,
        );
      }
      await appFilesManager.createAppDataDir(appUrn);

      // Create app.env file
      logger.info(`Creating app.env file for app ${appUrn}`);
      await appHelpers.generateEnvFile(appUrn, form);

      // Copy data dir
      logger.info(`Copying data dir for app ${appUrn}`);
      const env = await appFilesManager.getAppEnv(appUrn);
      const envMap = envUtils.envStringToMap(env.content);

      await marketplaceService.copyDataDir(appUrn, envMap);
      // As install does: otherwise Docker creates each bind-mount folder as root when the app starts, and
      // the next reset, restore or backup of what the app writes there needs the root helper again.
      await appFilesManager.createVolumeHostDirs(appUrn);
      await this.ensureAppDir(appUrn, form);

      return { success: true, message: `App ${appUrn} reset successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'reset');
    }
  }
}
