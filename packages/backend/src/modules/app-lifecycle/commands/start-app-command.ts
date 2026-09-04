import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { AppLifecycleCommand } from './command';

export class StartAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });

    try {
      const config = await appFilesManager.getInstalledAppInfo(appUrn);

      if (!config) {
        return { success: true, message: 'App config not found. Skipping...' };
      }

      await this.assertMarketplaceEntitlement(appUrn, 'start');

      if (isPortExposeApp(config)) {
        const { PortExposeService } = await import('../../custom-apps/port-expose.service');
        const portExposeService = this.moduleRef.get(PortExposeService, { strict: false });
        await portExposeService?.syncPortExposeRoutes();
        logger.info(`Port-expose workload ${appUrn} started`);
        return { success: true, message: `App ${appUrn} started successfully` };
      }

      logger.info(`Starting app ${appUrn}`);

      // Host-device preflight — a device present at install time (e.g. /dev/kfd for ROCm)
      // can be gone by the time the app is started again (driver not loaded yet at boot,
      // host reconfigured). Catch that here with friendly guidance instead of letting
      // Docker's raw device-attach error reach the user unclassified.
      await this.assertRequiredHostDevices(appUrn);

      await this.ensureAppDir(appUrn, form);

      if (!form.skipEnv) {
        logger.info(`Regenerating app.env file for app ${appUrn}`);
        await appHelpers.generateEnvFile(appUrn, form);
      }

      const forcePull = !form.skipPull && config.force_pull;
      await this.composeAppWithNetworkRecovery(appUrn, form, `up --detach --force-recreate --remove-orphans ${forcePull ? '--pull always' : ''}`);

      // Regenerate Traefik file-based config after app starts
      const effectiveExposure = form.exposureMode || (form.exposedLocal ? 'cloudflare' : 'local');
      if (effectiveExposure !== 'local') {
        logger.debug(`Regenerating Traefik config for exposed app ${appUrn}`);
        // Wait longer for container to fully start and network to be attached
        await traefikConfigService.regenerateTraefikConfig(5000); // Wait 5s for container to fully start
      }

      logger.info(`App ${appUrn} started`);

      return { success: true, message: `App ${appUrn} started successfully` };
    } catch (err) {
      return this.handleAppError(err, appUrn, 'start');
    }
  }
}
