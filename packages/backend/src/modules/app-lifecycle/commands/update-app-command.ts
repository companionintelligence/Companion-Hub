import { DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES } from '@/common/constants';
import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { mergeArchitectureOverrides } from '@/common/helpers/compose-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { AgentNotifyService } from '@/modules/agent-notify/agent-notify.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { BackupManager } from '@/modules/backups/backup.manager';
import { removeAppDataDirWithRootFallback } from '@/modules/docker/app-data-removal';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import type Dockerode from 'dockerode';
import type { OperationPhase } from '../app-operation-registry';
import { AppLifecycleCommand, type CommandExecutionContext } from './command';
import { type UpdatePhase, parseComposeJson } from '@ci-hub/common/schemas';

/**
 * Kept free at the end of an update's time (`CommandExecutionContext.deadline`) for undoing it:
 * taking the new version down, putting the previous files and data back and starting it again.
 */
const UPDATE_ROLLBACK_RESERVE_MS = 10 * 60_000;
/** An update with less than this left for its own work when a worker takes it is not started. */
const UPDATE_MIN_WORK_MS = 5 * 60_000;
/**
 * Allowed for a worker to take an update off the queue when judging a lowered budget. Without it a
 * budget of exactly the work time plus the reserve passed that check and then always failed the next
 * one, by the seconds the update had spent queued, with a message about waiting for a worker.
 */
const UPDATE_PICKUP_SLACK_MS = 60_000;

/**
 * What a cancel may still do in each step (see `OperationPhase`): up to and during the health wait
 * it stops the update at the next safe point and rolls it back; once the update is finishing or
 * already rolling back, it is refused.
 */
const REGISTRY_PHASE: Record<UpdatePhase, OperationPhase> = {
  preparing: 'preparing',
  pulling: 'pulling',
  backing_up: 'preparing',
  replacing: 'composing',
  starting: 'composing',
  verifying: 'verifying',
  finalizing: 'finalizing',
  rolling_back: 'finalizing',
};

/** The person cancelled the update; it stops where it is and puts the previous version back. */
class UpdateCancelledError extends Error {}

export class UpdateAppCommand extends AppLifecycleCommand {
  /**
   * @param performBackup back the app up (which stops it) before replacing its files
   * @param wasRunning whether the app was running when the update was requested. A stopped app is
   *   updated and left stopped; only a running one is started again afterwards. Defaults to `true`,
   *   the behaviour before the flag existed, for a queued message that predates it.
   */
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly performBackup: boolean = true,
    private readonly wasRunning: boolean = true,
  ) {
    super(moduleRef, docker);
  }

  /**
   * The update's one time limit (`CommandExecutionContext.deadline`), kept for the rollback: its
   * restore and the root helpers under it must end before the reply is due like everything else.
   */
  private deadline: AppCommandDeadline | undefined;

  /** What the update leaves for after its reply (see `afterReply`). */
  private afterReplyWork: (() => Promise<void>) | undefined;

  /**
   * Empty the snapshot the update no longer needs, once its reply has been sent. It is a delete that
   * need not finish before the reply, so it gets the helper's own 30 minutes rather than whatever the
   * update had left: a snapshot left on disk because a long rollback used up the deadline is never
   * removed by anything else.
   */
  public async afterReply(): Promise<void> {
    const work = this.afterReplyWork;
    this.afterReplyWork = undefined;
    await work?.();
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput, ctx?: CommandExecutionContext) {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const sseService = this.moduleRef.get(SSEService, { strict: false });
    this.deadline = ctx?.deadline;
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const marketplaceService = this.moduleRef.get(MarketplaceService, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const backupManager = this.moduleRef.get(BackupManager, { strict: false });

    let composeToInstall: Awaited<ReturnType<MarketplaceService['getDockerComposeJson']>>;
    try {
      composeToInstall = await marketplaceService.getDockerComposeJson(appUrn);
      parseComposeJson(composeToInstall.content);
    } catch (err) {
      logger.error(`Error parsing docker-compose.yml for app ${appUrn} from marketplace repository. Are you running the latest version of CI Hub?`);
      // Nothing has been touched: the running app is exactly as it was.
      return { ...(await this.handleAppError(err, appUrn, 'update_error')), rolledBack: true };
    }

    let backupFile: string | undefined;
    let snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;
    let previousEnv: string | undefined;

    // How far the update got, so a failure knows how much there is to undo. Each is set BEFORE the step
    // it describes, not after: a step that fails half-way has still done part of its work.
    let stoppedForBackup = false;
    let replacingFiles = false;
    let tookDown = false;
    let startedNewVersion = false;

    // Each step is reported to the operation registry, which decides what a cancel may still do, and
    // to the app page, which shows it. Before, the page said "Preparing..." for the whole update.
    const report = (phase: UpdatePhase) => {
      ctx?.setPhase(REGISTRY_PHASE[phase]);
      sseService?.emit('app', { event: 'status_change', appUrn, appStatus: 'updating', updatePhase: phase });
    };

    // ⚠ ONE DEADLINE FOR THE WHOLE UPDATE. The service waits for the reply for a fixed time from when
    // it queued the update (`AppCommandDeadline.untilReply`). The update's own work, the pull, the
    // backup and the health wait included, ends `UPDATE_ROLLBACK_RESERVE_MS` before that deadline, so
    // a rollback still fits. The rollback's restore gets what is left of it.
    const workEndsAt = ctx?.deadline ? ctx.deadline.endsAt - UPDATE_ROLLBACK_RESERVE_MS : undefined;
    const workLeftMs = () => ctx?.deadline?.remainingBeforeMs(UPDATE_ROLLBACK_RESERVE_MS) ?? Number.POSITIVE_INFINITY;

    // A safe point: no step is half-done here, so a cancel or a used-up budget stops the update and
    // the catch below undoes what it changed. A cancel between two safe points waits for the next one.
    const checkpoint = (where: string) => {
      if (ctx?.signal.aborted) {
        throw new UpdateCancelledError(`The update of ${appUrn} was cancelled ${where}`);
      }
      if (workLeftMs() <= 0) {
        throw new Error(`The update of ${appUrn} ran out of time ${where}; the Hub gives an update until its reply is due, less time to undo it`);
      }
    };

    try {
      // Checked before the first step is shown: an update a worker takes this late may be one the
      // service has already settled, and telling the page it is updating would leave it spinning.
      // A budget lowered below what any update needs is a setting to change, not a queue to wait out.
      if (ctx?.deadline && ctx.deadline.budgetMs - UPDATE_ROLLBACK_RESERVE_MS < UPDATE_MIN_WORK_MS + UPDATE_PICKUP_SLACK_MS) {
        throw new Error(
          `The update of ${appUrn} was not started: CI_HUB_PRIVILEGED_HELPER_BUDGET_SECONDS gives an app command ${Math.round(ctx.deadline.budgetMs / 1000)} s. ` +
            `An update needs at least ${(UPDATE_MIN_WORK_MS + UPDATE_ROLLBACK_RESERVE_MS + UPDATE_PICKUP_SLACK_MS) / 60_000} minutes: ` +
            `${UPDATE_MIN_WORK_MS / 60_000} to do its work, ${UPDATE_ROLLBACK_RESERVE_MS / 60_000} to undo it ` +
            `and ${UPDATE_PICKUP_SLACK_MS / 60_000} for a worker to take it. Nothing was changed; raise that setting or remove it.`,
        );
      }
      if (workLeftMs() < UPDATE_MIN_WORK_MS) {
        throw new Error(
          `The update of ${appUrn} was not started: it waited for a free worker until too little of its time was left. Nothing was changed; try the update again.`,
        );
      }
      report('preparing');

      await this.assertMarketplaceEntitlement(appUrn, 'update');

      // ⚠ PULL BEFORE TOUCHING THE RUNNING APP. The pull is the step that most often fails (no
      // network, registry down, a tag that does not exist) and the slowest, so doing it after the
      // old version was stopped and torn down turned every such failure into downtime with the new
      // files already on disk. Nothing is stopped, removed or replaced until the images are here.
      logger.info(`Pulling images for ${appUrn} before stopping the current version`);
      report('pulling');
      await dockerService.pullImages(this.imagesToPull(composeToInstall.content), {
        forcePull: true,
        signal: ctx?.signal,
        timeoutMs: Math.min(workLeftMs(), DEFAULT_APP_IMAGE_PULL_TIMEOUT_MINUTES * 60_000),
      });
      checkpoint('after downloading the new images');

      if (this.performBackup) {
        // Before the stop: data the Hub cannot read needs the root helper, and a backup that cannot be
        // made must not cost the app its uptime first.
        await backupManager.assertBackupPossible(appUrn);
        stoppedForBackup = true;
        report('backing_up');
        await dockerService.composeApp(appUrn, 'stop');
        // The backup's root helpers get the update's work time, not a fresh budget of their own.
        const backupRes = await backupManager.backupApp(appUrn, ctx?.deadline?.withReserve(UPDATE_ROLLBACK_RESERVE_MS));
        backupFile = backupRes?.filename;
        await this.applyBackupRetention(appUrn);
      }

      // The data is already in the backup when there is one; copying it again here is a second full
      // copy of the app's data folder that nothing reads. The installed files are always snapshotted:
      // they are what a rollback puts back.
      // A copy of the data as root is part of the update's work, so it gets the work time like the backup.
      snapshotResult = await dockerService.createPreUpdateVolumeSnapshot(appUrn, {
        includeData: !backupFile,
        deadline: ctx?.deadline?.withReserve(UPDATE_ROLLBACK_RESERVE_MS),
      });

      // An update that cannot be undone is not started. Nothing has been changed yet, so refusing here
      // costs nothing; going on would put a failed or partial snapshot in charge of the rollback.
      if (!snapshotResult?.success) {
        throw new Error(`Could not snapshot ${appUrn} before updating it (${snapshotResult?.error ?? 'unknown error'}); the update was not started`);
      }
      previousEnv = (await appFilesManager.getAppEnv(appUrn))?.content;
      checkpoint('before replacing the app files');

      logger.info(`Updating app ${appUrn}`);
      // A stopped app is updated and left stopped, so its page must not say it is being started.
      report(this.wasRunning ? 'starting' : 'replacing');
      // From here on the previous files and app.env are being replaced.
      replacingFiles = true;
      await this.ensureAppDir(appUrn, form);
      await appHelpers.generateEnvFile(appUrn, form);

      tookDown = true;
      try {
        await dockerService.composeApp(appUrn, 'down --rmi local --remove-orphans');
      } catch (_) {
        logger.warn(`App ${appUrn} has likely a broken docker-compose.yml file. Continuing with update...`);
      }

      if (!(await appFilesManager.deleteAppFolder(appUrn))) {
        throw new Error(`Could not remove the previous files of ${appUrn}`);
      }
      await marketplaceService.copyAppFromRepoToInstalled(appUrn);

      await this.ensureAppDir(appUrn, form);

      // An app that was stopped when the update began is updated and left stopped. Starting it here,
      // as every update did, switched on something its owner had switched off.
      if (this.wasRunning) {
        // The last safe point before the new version runs: stopping here leaves the data as it was.
        checkpoint('before starting the new version');
        await dockerService.composeApp(appUrn, 'pull');
        startedNewVersion = true;
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
        checkpoint('after starting the new version');

        // An app whose health check still says `starting` is waited for, up to the start period it
        // declares: rolling back an app that is still coming up undid good updates of slow starters.
        // The wait ends with the update's own time. A cancel ends it at once.
        report('verifying');
        const probeResult = await dockerService.verifyContainerHealthProbe(appUrn, {
          maxAttempts: 5,
          delayMs: 2000,
          waitWhileStarting: true,
          waitUntil: workEndsAt,
          signal: ctx?.signal,
        });
        if (probeResult.cancelled) {
          throw new UpdateCancelledError(`The update of ${appUrn} was cancelled while it waited for the new version's health check`);
        }
        if (!probeResult.healthy) {
          logger.error(`Post-update health check failed for app ${appUrn}: ${probeResult.message}. Initiating auto-rollback...`);
          throw new Error(`Update failed health probe: ${probeResult.message}`);
        }
        logger.info(`Post-update health check passed for app ${appUrn}: ${probeResult.message}`);
      }

      // The registry accepts a cancel until `finalizing`, so one that arrived since the last safe point
      // still counts. A stopped app has no safe point after its files were replaced, and a cancel can
      // land just as the health check passes.
      if (ctx?.signal.aborted) {
        throw new UpdateCancelledError(`The update of ${appUrn} was cancelled before it was finished`);
      }

      // Past this point the update is done and is no longer cancelled.
      report('finalizing');

      // The update just replaced the app's config.json, which is where the wake endpoint
      // and port come from. Without re-registering, the Hub would keep POSTing to the URL
      // captured at install time — so a manifest that moves the endpoint would never take
      // effect on an app that is already installed.
      try {
        const agentNotifyService = this.moduleRef.get(AgentNotifyService, { strict: false });
        const target = await agentNotifyService?.resolveWebhookTarget(appUrn);
        if (target) {
          agentNotifyService.registerWebhook(appUrn, target.url, target.token);
        }
      } catch (hookErr) {
        logger.warn(`Failed to refresh the agent webhook for ${appUrn}: ${hookErr}`);
      }

      this.discardSnapshotAfterReply(snapshotResult);

      return { success: true, message: `App ${appUrn} updated successfully` };
    } catch (err) {
      // An aborted pull throws its own error, so the signal decides whether this was a cancel.
      const cancelled = err instanceof UpdateCancelledError || ctx?.signal.aborted === true;
      if (stoppedForBackup || replacingFiles) {
        report('rolling_back');
      }

      // Once the new version has been started it may have migrated the data, so putting the old files
      // back is not enough: the data comes back too. Before that, the old data was never touched.
      const rolledBack = startedNewVersion
        ? await this.rollBackStartedVersion(appUrn, { backupFile, snapshotResult })
        : await this.restorePreviousVersion(appUrn, { stoppedForBackup, replacingFiles, tookDown, snapshotResult, previousEnv });

      // The snapshot is the last copy of the previous version when a rollback has not worked. It goes
      // only once the previous version is demonstrably back.
      if (rolledBack) {
        this.discardSnapshotAfterReply(snapshotResult);
      }

      if (cancelled) {
        // Settled by the worker (`finalizeCancelledUpdate`), which knows the status the app had before.
        logger.info(
          `${err instanceof Error ? err.message : `The update of ${appUrn} was cancelled`}; ${rolledBack ? 'the previous version is back' : 'the previous version could NOT be put back'}`,
        );
        return {
          success: false,
          cancelled: true,
          rolledBack,
          message: rolledBack
            ? `Update of ${appUrn} cancelled; the previous version is back`
            : `Update of ${appUrn} cancelled, but the previous version could not be put back. See the Hub logs.`,
        };
      }

      return { ...(await this.handleAppError(err, appUrn, 'update_error')), rolledBack };
    }
  }

  /**
   * The images the new version needs, as `compose pull` would resolve them: with the per-architecture
   * overrides applied, so the pull asks for the image this machine will actually run.
   */
  private imagesToPull(composeContent: unknown): string[] {
    const configService = this.moduleRef.get(ConfigurationService, { strict: false });
    const { services, overrides } = parseComposeJson(composeContent);
    const merged = mergeArchitectureOverrides(services, overrides, configService?.get('architecture'));

    return [...new Set(merged.map((service) => service.image?.trim()).filter((image): image is string => Boolean(image)))];
  }

  /**
   * Undo an update whose new version was already started: bring everything down, put back the
   * previous files AND data (from the backup if one was taken, otherwise from the snapshot), and
   * start the previous version.
   *
   * ⚠ "BACK UP" IS NOT "ROLLED BACK". The previous version is started whatever happened to the restore,
   * so the app is never left torn down, but the return value is true only when the restore really
   * worked. Reporting a rollback that did nothing would delete the snapshot, the only remaining copy.
   *
   * @returns whether the previous files and data are back in place and the previous version was started
   */
  private async rollBackStartedVersion(
    appUrn: AppUrn,
    state: { backupFile: string | undefined; snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined },
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const backupManager = this.moduleRef.get(BackupManager, { strict: false });

    let restored = false;

    try {
      await dockerService.composeApp(appUrn, 'down --remove-orphans');

      if (state.backupFile) {
        try {
          // Until the reply is due, not a fresh budget: a restore that outlasted it went on writing data
          // after the page had already shown the update as failed.
          await backupManager.restoreApp(appUrn, state.backupFile, this.deadline);
          restored = true;
          logger.info(`Restored ${appUrn} app files and data from backup ${state.backupFile}`);
        } catch (restoreErr) {
          logger.error(`Failed to restore ${appUrn} from backup ${state.backupFile}: ${restoreErr}. The backup file has been kept.`);
        }
      } else if (state.snapshotResult?.snapshotPath || state.snapshotResult?.appFilesSnapshotPath) {
        restored = await this.restoreFromSnapshot(appUrn, state.snapshotResult);
      } else {
        logger.warn(`No backup or volume snapshot available to roll back ${appUrn}; recreating the current containers instead`);
      }

      await dockerService.composeApp(appUrn, 'pull');
      await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
      logger.info(`Auto-rollback recovery step completed for ${appUrn} (data and files ${restored ? 'restored' : 'NOT restored'})`);

      return restored;
    } catch (rollbackErr) {
      logger.error(`Failed to bring ${appUrn} back up after auto-rollback: ${rollbackErr}`);
      return false;
    }
  }

  /** Copy the snapshot's data folder and installed files back, reporting whether every copy worked. */
  private async restoreFromSnapshot(
    appUrn: AppUrn,
    snapshot: NonNullable<Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>>>,
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

    try {
      const { appDataDir, appInstalledDir } = appFilesManager.getAppPaths(appUrn);
      let ok = true;

      // `removeDirectory` and `copyDirectory` report failure (ENOSPC, EACCES) by returning false, not by throwing.
      if (filesystem && snapshot.snapshotPath && (await filesystem.pathExists(snapshot.snapshotPath))) {
        if (snapshot.dataSnapshotCopiedAsRoot) {
          // The copy keeps the owners of the original (a database's files), so the Hub could neither
          // read it nor write it back; the helper empties the data folder and copies the snapshot over it.
          const dockerService = this.moduleRef.get(DockerService, { strict: false });
          // Until the reply is due, like the restore from a backup: not 30 minutes of its own.
          ok = ok && (await dockerService.restoreAppDataDirAsRoot(appUrn, snapshot.snapshotId, this.deadline));
        } else {
          // The Hub could read the data, so it copied it, but what the app's container wrote as another
          // user (Uptime Kuma runs as root) it cannot delete: those go through the root helper. A copy
          // over data that is still there would mix the two versions, so it waits for the delete.
          const dockerService = this.moduleRef.get(DockerService, { strict: false });
          const removed = await removeAppDataDirWithRootFallback({ filesystem, docker: dockerService, logger }, appUrn, appDataDir, this.deadline);
          const copied = removed && (await filesystem.copyDirectory(snapshot.snapshotPath, appDataDir));
          ok = ok && removed && copied !== false;
        }
      }

      if (filesystem && snapshot.appFilesSnapshotPath && (await filesystem.pathExists(snapshot.appFilesSnapshotPath))) {
        const removed = await filesystem.removeDirectory(appInstalledDir);
        const copied = await filesystem.copyDirectory(snapshot.appFilesSnapshotPath, appInstalledDir);
        ok = ok && removed !== false && copied !== false;
      }

      // With the previous files back, any bind-mount folder the snapshot did not hold is made by the
      // Hub, as install does, rather than by Docker as root when the previous version starts.
      if (ok) {
        await appFilesManager.createVolumeHostDirs(appUrn);
      }

      if (ok) {
        logger.info(`Restored ${appUrn} app files and data from snapshot ${snapshot.snapshotId}`);
      } else {
        logger.error(
          `Could not restore all of ${appUrn} from snapshot ${snapshot.snapshotId}; it has been kept at ${snapshot.snapshotBaseDir ?? 'its snapshot folder'}`,
        );
      }

      return ok;
    } catch (snapshotErr) {
      logger.error(`Failed to restore ${appUrn} from volume snapshot: ${snapshotErr}`);
      return false;
    }
  }

  /**
   * After a failed update that never started the new version, put the app back as it was and say
   * whether that worked.
   *
   * Before the files were replaced there is little to undo: the images are pulled and nothing else
   * has changed, except that a backup stops the app. After, the previous installed files and
   * app.env come back from the snapshot taken first. The app is taken down and started again only
   * if the update actually took it down (or the backup stopped it): a failure while the old version
   * was still running must not turn into downtime. When anything cannot be done the snapshot is left
   * where it is, and its path is logged for a manual restore.
   *
   * @returns whether the previous version is back in place and, if it was running, running
   */
  private async restorePreviousVersion(
    appUrn: AppUrn,
    state: {
      stoppedForBackup: boolean;
      replacingFiles: boolean;
      tookDown: boolean;
      snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined;
      previousEnv: string | undefined;
    },
  ): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });

    try {
      if (!state.replacingFiles) {
        if (state.stoppedForBackup && this.wasRunning) {
          await dockerService.composeApp(appUrn, 'up --detach --remove-orphans');
        }

        return true;
      }

      // Checked BEFORE any container is touched: a rollback that cannot restore must not also take
      // down an app that is still running.
      const snapshotPath = state.snapshotResult?.appFilesSnapshotPath;
      const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

      if (!snapshotPath || !filesystem || !(await filesystem.pathExists(snapshotPath))) {
        throw new Error('there is no snapshot of the previous app files to restore');
      }

      if (state.tookDown) {
        await dockerService.composeApp(appUrn, 'down --remove-orphans').catch(() => undefined);
      }

      const { appInstalledDir } = appFilesManager.getAppPaths(appUrn);

      if (
        (await filesystem.removeDirectory(appInstalledDir)) === false ||
        (await filesystem.copyDirectory(snapshotPath, appInstalledDir)) === false
      ) {
        throw new Error(`could not copy the previous app files back from ${snapshotPath}`);
      }

      if (state.previousEnv) {
        await appFilesManager.writeAppEnv(appUrn, state.previousEnv);
      }

      if (this.wasRunning && (state.tookDown || state.stoppedForBackup)) {
        await dockerService.composeApp(appUrn, 'up --detach --force-recreate --remove-orphans');
      }

      logger.info(`Restored the previous version of ${appUrn} after a failed update`);
      return true;
    } catch (restoreErr) {
      const where = state.snapshotResult?.snapshotBaseDir ?? state.snapshotResult?.appFilesSnapshotPath;
      logger.error(
        `Could not restore the previous version of ${appUrn} after a failed update: ${restoreErr}.${where ? ` The snapshot taken before the update is kept at ${where}.` : ''}`,
      );
      return false;
    }
  }

  /** Apply the app's backup limit (or the global one) right after the update's backup, as a manual backup does. */
  private async applyBackupRetention(appUrn: AppUrn): Promise<void> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });

    try {
      const backupManager = this.moduleRef.get(BackupManager, { strict: false });
      const appsRepository = this.moduleRef.get(AppsRepository, { strict: false });
      const config = this.moduleRef.get(ConfigurationService, { strict: false });

      const app = await appsRepository.getAppByUrn(appUrn);
      const maxBackups = app?.maxBackups ?? config.get('userSettings').maxBackups;

      await backupManager.cleanupOldBackups(appUrn, maxBackups);
    } catch (err) {
      // The backup itself succeeded; failing the update over a failed tidy-up would help nobody.
      logger.warn(`Could not apply the backup limit to ${appUrn} after its update backup: ${err}`);
    }
  }

  /** Leave {@link discardSnapshot} for after the reply (see `afterReply`). */
  private discardSnapshotAfterReply(snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined): void {
    if (snapshotResult?.snapshotBaseDir) {
      // Said now, so a Hub stopped before the removal ran leaves a line naming the folder it left behind.
      this.moduleRef
        .get(LoggerService, { strict: false })
        ?.info(`The pre-update snapshot ${snapshotResult.snapshotBaseDir} is no longer needed; it is removed once the reply is out`);
    }
    this.afterReplyWork = () => this.discardSnapshot(snapshotResult);
  }

  /** The snapshot exists to undo a failed update; once there is nothing to undo it is a full copy of the app's files taking disk for good. */
  private async discardSnapshot(snapshotResult: Awaited<ReturnType<DockerService['createPreUpdateVolumeSnapshot']>> | undefined): Promise<void> {
    if (!snapshotResult?.snapshotBaseDir) {
      return;
    }

    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const filesystem = this.moduleRef.get(FilesystemService, { strict: false });

    try {
      if (snapshotResult.dataSnapshotCopiedAsRoot) {
        // Its data copy belongs to other users and the Hub cannot delete it: a helper empties it first.
        const dockerService = this.moduleRef.get(DockerService, { strict: false });
        if (!(await dockerService.removeSnapshotDirAsRoot(snapshotResult.appUrn, snapshotResult.snapshotId))) {
          logger.warn(`Could not empty the pre-update snapshot ${snapshotResult.snapshotBaseDir} as root; it is left on disk`);
          return;
        }
      }
      if ((await filesystem?.removeDirectory(snapshotResult.snapshotBaseDir)) === false) {
        logger.warn(`Could not remove the pre-update snapshot ${snapshotResult.snapshotBaseDir}; it is left on disk`);
        return;
      }
      logger.info(`Removed the pre-update snapshot ${snapshotResult.snapshotBaseDir}`);
    } catch (err) {
      logger.warn(`Could not remove the pre-update snapshot ${snapshotResult.snapshotBaseDir}: ${err}`);
    }
  }
}
