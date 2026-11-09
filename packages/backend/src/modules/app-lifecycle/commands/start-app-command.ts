import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { getEffectiveExposureMode } from '@/modules/apps/app-exposure.helpers';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { customAppMainPortAvoids, ensureCustomAppHostPort, hubHostPorts, mappedHostPorts } from '@/modules/custom-apps/custom-app-host-port';
import { appUrnLabelSets, listContainersMatchingAnyLabelSets } from '@/modules/docker/hub-container-query';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import { PortManagerService } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import type Dockerode from 'dockerode';
import { AppLifecycleCommand } from './command';
import { hostPortMoveOf } from './main-host-port';

/**
 * The compose subcommand a start runs.
 *
 * `--force-recreate` stays the default, so a start from the dashboard, a sweep, a reset, or a
 * rehydration behaves as before. `onlyRecreateChanged` drops it so compose's own change detection
 * decides, which is what a Hub boot wants (see `AppLifecycleService.restartRunningApps`) and what the
 * start after an update wants, since the update command has just started the new version
 * (see `AppLifecycleService.updateApp`).
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
  for (const container of await listContainersMatchingAnyLabelSets(docker, appUrnLabelSets(appUrn), true, { status: ['restarting'] })) {
    await docker.getContainer(container.Id).remove({ force: true });
    removed.push(container.Names?.[0]?.replace(/^\//, '') || container.Id);
  }
  return removed;
}

export class StartAppCommand extends AppLifecycleCommand {
  public async execute(appUrn: AppUrn, form: AppEventFormInput) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const traefikConfigService = this.moduleRef.get(TraefikConfigService, { strict: false });
    const portOnStart = form.port;
    const refusedHostPorts = new Set<number>();

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

      if (extractAppUrn(appUrn).appStoreId === '_user' && config.port) {
        await this.assignCustomAppHostPort(appUrn, form, config.port, logger);
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
      // Another program can hold the port the app starts on. Move the app off it, as install does, rather than fail.
      await this.composeUpRecordingPulls(
        appUrn,
        form,
        startComposeCommand({ forcePull, onlyRecreateChanged: form.onlyRecreateChanged }),
        3,
        undefined,
        {
          recoverHostPortConflict: (error) => this.moveMainPortOffConflict(appUrn, form, error, refusedHostPorts),
        },
      ).catch((error: unknown) => this.failComposeUp(appUrn, form, error));

      // `compose up` returning says nothing about a service that crashes as soon as it starts.
      const notUp = await this.appCameUpErrorAfterStart(appUrn, form);

      if (notUp) {
        await this.rebuildRoutesAfterFailure(appUrn, form);
        throw notUp;
      }

      // Regenerate Traefik file-based config after app starts. The check above is the wait for them to start.
      if (getEffectiveExposureMode(form) !== 'local') {
        logger.debug(`Regenerating Traefik config for exposed app ${appUrn}`);
        await traefikConfigService.regenerateTraefikConfig(0);
      }

      logger.info(`App ${appUrn} started`);

      return { success: true, message: `App ${appUrn} started successfully`, movedHostPort: hostPortMoveOf(form, refusedHostPorts, portOnStart) };
    } catch (err) {
      // The row, config and app.env stay on a port the run moved to, whatever failed after the move.
      return { ...(await this.handleAppError(err, appUrn, 'start')), movedHostPort: hostPortMoveOf(form, refusedHostPorts, portOnStart) };
    }
  }

  /**
   * Give a custom app made before custom apps got a host port of their own one now; see
   * `ensureCustomAppHostPort`. It keeps the port it publishes unless the Hub or another app holds it.
   *
   * Such an app holds no port allocation. It has no port on its row, or has its internal port there:
   * the settings dialog fills the port field from config.json, which holds the internal port, and a
   * save stores it. An app that holds an allocation is left alone unless its port is one of the Hub's
   * own ports, which it can never bind. The ports avoided are the ones a creation avoids. If none can
   * be found or recorded, the app publishes what it did before.
   */
  private async assignCustomAppHostPort(appUrn: AppUrn, form: AppEventFormInput, internalPort: number, logger: LoggerService): Promise<void> {
    const hubPorts = hubHostPorts(this.moduleRef.get(ConfigurationService, { strict: false })?.get('userSettings'));

    try {
      const portManager = this.moduleRef.get(PortManagerService, { strict: false });
      if (form.port && !hubPorts.has(form.port) && (await portManager.getMainPort(appUrn)) !== null) {
        return;
      }

      const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
      const compose = await this.moduleRef.get(AppFilesManager, { strict: false }).getDockerComposeJson(appUrn);
      const services = (compose.content as { services?: Parameters<typeof mappedHostPorts>[0] } | null)?.services;
      const currentPort = form.port ?? internalPort;
      const avoid = await customAppMainPortAvoids(appsRepository, appUrn, mappedHostPorts(services), [internalPort, currentPort], hubPorts);

      form.port = await ensureCustomAppHostPort(portManager, appsRepository, appUrn, internalPort, avoid, currentPort);
      logger.info(`Custom app ${appUrn} now publishes on host port ${form.port}`);
    } catch (error) {
      logger.warn(
        `Could not give custom app ${appUrn} a host port of its own, so it publishes ${form.port ?? internalPort} as before: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
