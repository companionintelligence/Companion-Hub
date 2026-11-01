import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleCommand } from './command';

export class RestartAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string }> {
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

      // Host-device preflight — a device present at install time (e.g. /dev/kfd for ROCm)
      // can be gone by the time the app is restarted (driver not loaded yet at boot, host
      // reconfigured). Catch that here with friendly guidance instead of letting Docker's
      // raw device-attach error reach the user unclassified.
      await this.assertRequiredHostDevices(appUrn);

      await this.ensureAppDir(appUrn, form);

      logger.info(`Stopping app ${appUrn}`);

      await dockerService.composeApp(appUrn, 'down --remove-orphans').catch((err) => {
        logger.error(`Failed to stop app ${appUrn}:`, err);
      });

      // TODO(#244): revisit on next Traefik upgrade
      // apps.yml still sends the app's routes to the addresses its old containers had, and a route
      // whose middlewares all live in the file provider (a Private VPN one, say) outlives them. Rebuilt
      // now, only the app's routes to the starting page stay (CI-Hub#1944) until compose up is done.
      if (form.exposedLocal) {
        await traefikConfigService.regenerateTraefikConfig(0);
      }
      await this.ensureAppDir(appUrn, form);

      if (!form.skipEnv) {
        logger.info(`Regenerating app.env file for app ${appUrn}`);
        await appHelpers.generateEnvFile(appUrn, form);
      }

      const forcePull = !form.skipPull && config.force_pull;
      // Another program can hold the port the app restarts on. Move the app off it, as install does, rather than fail.
      const refusedHostPorts = new Set<number>();
      await this.composeAppWithNetworkRecovery(
        appUrn,
        form,
        `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`,
        3,
        undefined,
        {
          recoverHostPortConflict: (error) => this.moveMainPortOffConflict(appUrn, form, error, refusedHostPorts),
        },
      );

      // TODO(#244): revisit on next Traefik upgrade
      // Regenerate Traefik file-based config after app restarts (workaround for Docker API version issue)
      if (form.exposedLocal) {
        logger.debug(`Regenerating Traefik config for restarted exposed app ${appUrn}`);
        // Wait longer for container to fully start and network to be attached
        await traefikConfigService.regenerateTraefikConfig(5000); // Wait 5s for container to fully start
      }

      logger.info(`App ${appUrn} restarted`);

      return { success: true, message: `App ${appUrn} restarted successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'restart');
    }
  }
}
