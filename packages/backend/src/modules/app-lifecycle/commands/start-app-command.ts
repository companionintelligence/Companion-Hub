import { extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { ensureCustomAppHostPort } from '@/modules/custom-apps/custom-app-host-port';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import type Dockerode from 'dockerode';
import { AppLifecycleCommand } from './command';

/**
 * The compose subcommand a start runs.
 *
 * `--force-recreate` stays the default, so a start from the dashboard, a sweep, a reset, or a
 * rehydration behaves as before. `onlyRecreateChanged` drops it so compose's own change detection
 * decides, which is what a Hub boot wants (see `AppLifecycleService.restartRunningApps`).
 */
export function startComposeCommand(options: { forcePull: boolean; onlyRecreateChanged?: boolean }): string {
  return ['up', '--detach', options.onlyRecreateChanged ? '' : '--force-recreate', '--remove-orphans', options.forcePull ? '--pull always' : '']
    .filter(Boolean)
    .join(' ');
}

/**
 * Removes this app's containers that Docker is restart-looping, and returns their names.
 *
 * A change-only `up` leaves a container alone when its definition is unchanged, including one
 * stuck in `restarting`. The force-recreate boot this replaced gave such a container a fresh
 * writable layer on every version change, which clears state that survives a restart, such as a
 * stale pid or lock file after an unclean shutdown. core-2 had a ci-memory service in `restarting`
 * on 2026-09-17. Removing the looping container before `up` keeps that recovery, and compose
 * then creates it again from the same definition; its data lives in mounts and volumes, not the
 * container. Exited containers need no such step because `prepareAppComposeDir` prunes them.
 */
export async function removeRestartingAppContainers(docker: Pick<Dockerode, 'listContainers' | 'getContainer'>, appUrn: AppUrn): Promise<string[]> {
  const removed: string[] = [];
  const seen = new Set<string>();
  for (const label of [`ci-hub.appurn=${appUrn}`, `ci-os-hub.appurn=${appUrn}`]) {
    const containers = (await docker.listContainers({ all: true, filters: { label: [label], status: ['restarting'] } })) ?? [];
    for (const container of containers) {
      if (seen.has(container.Id)) {
        continue;
      }
      seen.add(container.Id);
      await docker.getContainer(container.Id).remove({ force: true });
      removed.push(container.Names?.[0]?.replace(/^\//, '') || container.Id);
    }
  }
  return removed;
}

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

      // A custom app made before custom apps got a host port of their own still publishes its
      // internal port on the host. It gets one on this first start, as a new custom app does when
      // it is created; see `allocateCustomAppHostPort`.
      if (extractAppUrn(appUrn).appStoreId === '_user' && !form.port && config.port) {
        form.port = await ensureCustomAppHostPort(
          this.moduleRef.get(PortManagerService, { strict: false }),
          this.moduleRef.get(AppsRepository, { strict: false }),
          appUrn,
          config.port,
        );
        logger.info(`Custom app ${appUrn} now publishes on host port ${form.port}`);
      }

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

      if (form.onlyRecreateChanged) {
        const removed = await removeRestartingAppContainers(this.docker, appUrn).catch((error: unknown) => {
          // Best effort: the change-only `up` below still runs, it just cannot clear a crash loop.
          logger.warn(`Could not remove restart-looping containers for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
          return [] as string[];
        });
        if (removed.length > 0) {
          logger.info(`Removed restart-looping containers for ${appUrn} so compose creates them fresh: ${removed.join(', ')}`);
        }
      }

      const forcePull = !form.skipPull && config.force_pull;
      await this.composeAppWithNetworkRecovery(appUrn, form, startComposeCommand({ forcePull, onlyRecreateChanged: form.onlyRecreateChanged }));

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
