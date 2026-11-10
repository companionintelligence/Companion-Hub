import { LoggerService } from '@/core/logger/logger.service';
import { AppHelpers } from '@/modules/apps/app.helpers';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleCommand } from './command';

export class GenerateAppEnvCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });

    try {
      logger.info(`Regenerating app.env file for app ${appUrn}`);
      // Writing the env file never needs volume folders. Making them here would block a store app's
      // pending data copy (#2198); start creates them before compose up.
      await this.ensureAppDir(appUrn, form, { createVolumeDirs: false });
      await appHelpers.generateEnvFile(appUrn, form);

      return { success: true, message: `App ${appUrn} env file regenerated successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'generate_env_error');
    }
  }
}
