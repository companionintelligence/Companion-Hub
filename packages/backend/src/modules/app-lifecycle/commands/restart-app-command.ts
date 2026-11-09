import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { getEffectiveExposureMode } from '@/modules/apps/app-exposure.helpers';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { DockerService } from '@/modules/docker/docker.service';
import { APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN } from '@/modules/docker/managed-app-containers';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { HostPortMove } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleCommand } from './command';
import { hostPortMoveOf } from './main-host-port';

export class RestartAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<{ success: boolean; message: string; movedHostPort?: HostPortMove }> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });
    const portOnRestart = form.port;
    const refusedHostPorts = new Set<number>();

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

      // Not `form.exposedLocal`, which a Private VPN app leaves off: its routes go through Traefik too.
      const exposedThroughTraefik = getEffectiveExposureMode(form) !== 'local';

      logger.info(`Stopping app ${appUrn}`);

      await dockerService.composeApp(appUrn, 'down --remove-orphans').catch((err) => {
        logger.error(`Failed to stop app ${appUrn}:`, err);
      });

      // TODO(#244): revisit on next Traefik upgrade
      // apps.yml still sends the app's routes to the addresses its old containers had, and a route
      // whose middlewares all live in the file provider (a Private VPN one, say) outlives them. Rebuilt
      // now, only the app's routes to the starting page stay (CI-Hub#1944) until compose up is done.
      if (exposedThroughTraefik) {
        await traefikConfigService.regenerateTraefikConfig(0);
      }
      await this.ensureAppDir(appUrn, form);

      if (!form.skipEnv) {
        logger.info(`Regenerating app.env file for app ${appUrn}`);
        await appHelpers.generateEnvFile(appUrn, form);
      }

      const forcePull = !form.skipPull && config.force_pull;
      // Another program can hold the port the app restarts on. Move the app off it, as install does, rather than fail.
      await this.composeUpRecordingPulls(
        appUrn,
        form,
        `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`,
        3,
        undefined,
        {
          recoverHostPortConflict: (error) => this.moveMainPortOffConflict(appUrn, form, error, refusedHostPorts),
        },
      ).catch(async (error: unknown) => {
        if (form.stopIfNotUp) {
          await this.stopAppLeftRestarting(appUrn);
        }
        throw error;
      });

      // `compose up` returning says nothing about a service that crashes as soon as it starts.
      const notUp = await this.appCameUpError(appUrn, form.stopIfNotUp ? APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN : undefined);
      if (notUp && form.stopIfNotUp) {
        await this.stopAppThatDidNotComeUp(appUrn);
      }

      // TODO(#244): revisit on next Traefik upgrade
      // Regenerate Traefik file-based config after app restarts (workaround for Docker API version issue).
      // Also when a service failed: either the other containers stay up and go on serving or they just
      // went down and the routes have to follow. The check above is the wait for them to start.
      if (exposedThroughTraefik) {
        logger.debug(`Regenerating Traefik config for restarted exposed app ${appUrn}`);
        await traefikConfigService.regenerateTraefikConfig(0);
      }

      if (notUp) {
        throw notUp;
      }

      logger.info(`App ${appUrn} restarted`);

      return { success: true, message: `App ${appUrn} restarted successfully`, movedHostPort: hostPortMoveOf(form, refusedHostPorts, portOnRestart) };
    } catch (err) {
      // The row, config and app.env stay on a port the run moved to, whatever failed after the move.
      return { ...(await this.handleAppError(err, appUrn, 'restart')), movedHostPort: hostPortMoveOf(form, refusedHostPorts, portOnRestart) };
    }
  }
}
