import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@runtipi/common/types';
import { AppLifecycleCommand } from './command';

export class StopAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });

    try {
      const config = await appFilesManager.getInstalledAppInfo(appUrn);

      if (!config) {
        return { success: true, message: 'App config not found. Skipping...' };
      }

      logger.info(`Stopping app ${appUrn}`);

      await this.ensureAppDir(appUrn, form);

      if (!form.skipEnv) {
        logger.info(`Regenerating app.env file for app ${appUrn}`);
        await appHelpers.generateEnvFile(appUrn, form);
      }

      await dockerService.composeApp(appUrn, 'down --remove-orphans');

      // Regenerate Traefik file-based config after app stops to remove its routes
      const effectiveExposure = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
      if (effectiveExposure !== 'local') {
        logger.debug(`Regenerating Traefik config after stopping exposed app ${appUrn}`);
        await traefikConfigService.regenerateTraefikConfig(1000); // Wait 1s for container to fully stop
      }

      logger.info(`App ${appUrn} stopped successfully`);

      return { success: true, message: `App ${appUrn} stopped successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'stop');
    }
  }
}
