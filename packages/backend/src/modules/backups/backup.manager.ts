import path from 'node:path';

import { resolveBackupFilePath } from './backup-path';
import {
  appDataMemberWithOwners,
  BACKUP_OWNERS_MARKER,
  readVolumeArchiveKeys,
  UnsafeBackupError,
  VOLUME_ARCHIVE_NAME,
  validateRestoreArchiveEntries,
  validateRestoreDirectory,
} from './restore-validation';
import { isAbsoluteHostPath, joinHostPath } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import fs from 'node:fs';
import { HttpStatus, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { TranslatableError } from '@/common/error/translatable-error';
import type { AppUrn } from '@ci-hub/common/types';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppVolumeArchiveService } from '../docker/app-volume-archive.service';
import { removeAppDataDirWithRootFallback } from '../docker/app-data-removal';
import { BACKUP_STAGING_DIRNAME, DockerService } from '../docker/docker.service';
import { AppCommandDeadline } from '@/common/helpers/app-command-deadline';

/**
 * How the Hub copies an app's data into a backup. Links are copied as links with their targets as
 * written: by default `fs.cp` rewrites a relative target to an absolute one under the SOURCE folder,
 * which no longer points anywhere once the data is restored somewhere else.
 */
const appDataCopyOptions = (appDataDir: string): fs.CopyOptions => ({
  recursive: true,
  verbatimSymlinks: true,
  // Judged on the path inside the app's data folder: the folder itself may live under a path that
  // contains "backups" (a volume mounted at /mnt/backups), and excluding it excluded everything.
  filter: (src) => !path.relative(appDataDir, src).includes('backups'),
});

/**
 * The same rule for a walk that meets one entry at a time and never enters what it skips: a path inside
 * the data folder holds "backups" exactly when one of its names does.
 */
const leftOutOfBackups = (entry: string) => path.basename(entry).includes('backups');

@Injectable()
export class BackupManager implements OnApplicationShutdown {
  private static readonly DEFAULT_MAX_BACKUPS = 5;
  private static readonly ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  private retentionInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly archiveManager: ArchiveService,
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly appFilesManager: AppFilesManager,
    private readonly appVolumes: AppVolumeArchiveService,
    private readonly docker: DockerService,
  ) {
    this.retentionInterval = setInterval(
      () => this.enforceRetentionAllApps().catch((e) => this.logger.error('Weekly backup retention failed', e)),
      BackupManager.ONE_WEEK_MS,
    );
  }

  onApplicationShutdown() {
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = null;
    }
  }

  /**
   * @param deadline the budget the root helper may use, when the data needs one. A manual backup gets its own
   *   ({@link AppCommandDeadline.forAppCommand}); a caller doing more than the backup passes its own.
   */
  public backupApp = async (appUrn: AppUrn, deadline: AppCommandDeadline = this.commandDeadline()) => {
    const { dataDir } = this.config.get('directories');
    const backupName = `${appUrn}-${Date.now()}`;
    const { appStoreId, appName } = extractAppUrn(appUrn);

    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);

    // What an earlier backup left in staging (a crash, a helper killed at its time limit) is not a backup, only disk space.
    await this.clearBackupStaging(appUrn);

    const tempDir = await this.filesystem.createTempDirectory(appUrn);

    if (!tempDir) {
      throw new Error('Failed to create temp directory');
    }

    this.logger.info('Copying files to backup location...');

    let staging: { id: string; dir: string } | null = null;

    try {
      await this.filesystem.createDirectory(tempDir);

      const { appDataDir, appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
      const userConfigDir = path.join(dataDir, 'user-config', appStoreId, appName);

      const data = await this.copyAppDataForBackup(appDataDir, path.join(tempDir, 'app-data'));

      // Where the rest of the backup is put together: the temp folder, or a staging folder root can read.
      let assembly = tempDir;

      if (!data.copied) {
        if (!data.permissionDenied) {
          throw new Error('Failed to copy the app files for the backup');
        }

        // A database's files belong to the user its container runs as (MariaDB's are uid 999, folders at
        // 700), and a Hub on a native Linux host cannot read them. Root archives the data instead, with
        // the owners and modes the app gave it, so a restore puts back exactly what the app left rather
        // than a copy the Hub owns, which its permission sweep would then open to everyone.
        this.logger.warn(
          `The Hub cannot read some of the data of ${appUrn} (its container wrote it as another user); archiving it as root, with its owners`,
        );
        staging = await this.docker.createBackupStagingDir(appUrn);

        if (!staging) {
          throw new Error('Failed to copy the app files for the backup');
        }

        assembly = path.join(staging.dir, 'stage');

        if (!(await this.filesystem.writeTextFile(path.join(assembly, BACKUP_OWNERS_MARKER), ''))) {
          throw new Error('Failed to copy the app files for the backup');
        }
      }

      if (!(await this.filesystem.copyDirectory(appInstalledDir, path.join(assembly, 'app')))) {
        throw new Error('Failed to copy the app files for the backup');
      }

      if (await this.filesystem.pathExists(userConfigDir)) {
        this.logger.info('Including user configuration in backup...');

        if (!(await this.filesystem.copyDirectory(userConfigDir, path.join(assembly, 'user-config')))) {
          throw new Error('Failed to copy the app configuration for the backup');
        }
      }

      // Where app-data cannot carry file ownership (a Windows Hub), most apps' databases live in named
      // Docker volumes instead, outside every folder above.
      await this.archiveAppVolumes(appUrn, path.join(assembly, 'volumes'));

      this.logger.info('Creating archive...');

      // Beside the folder being archived, not inside it: an archive written into its own source is
      // read as it grows, and a tar that skips it is a tar that may exit non-zero.
      let archivePath = `${tempDir}.tar.gz`;

      if (staging) {
        const archived = await this.docker.archiveBackupAsRoot(appUrn, staging.id, deadline);

        if (!archived) {
          throw deadline.expired
            ? this.outOfTime('Backing up', appUrn, deadline, 'No backup was made.')
            : new Error('Failed to create the backup archive');
        }

        archivePath = archived;
      } else {
        const { stdout, stderr, exitCode } = await this.archiveManager.createTarGz(tempDir, archivePath);
        this.logger.debug('--- archiveManager.createTarGz ---');
        this.logger.debug('stderr:', stderr);
        this.logger.debug('stdout:', stdout);

        // ⚠ A backup that was not written must not be reported as one. The update flow stops the app,
        // takes this backup and treats the file as the way back; a tar that failed (disk full) used to
        // leave a name for a file that does not exist.
        if (exitCode !== 0) {
          throw new Error(`Failed to create the backup archive${stderr ? `: ${stderr.trim()}` : ''}`);
        }
      }

      this.logger.info('Moving archive to backup directory...', backupDir);

      await this.filesystem.createDirectory(backupDir);
      const finalPath = path.join(backupDir, `${backupName}.tar.gz`);

      try {
        const moved = await this.filesystem.copyFile(archivePath, finalPath);

        if (moved === false || !(await this.filesystem.isFile(finalPath))) {
          throw new Error('Failed to move the backup archive into the backups folder');
        }
      } finally {
        await this.filesystem.removeFile(archivePath);
      }

      this.logger.info('Backup completed!');
      return { filename: `${backupName}.tar.gz` };
    } finally {
      // The temp folder goes whether the backup worked or not: a failed one used to leave a full copy of the app in /tmp.
      await this.filesystem.removeDirectory(tempDir);

      if (staging) {
        await this.filesystem.removeDirectory(staging.dir);
      }
    }
  };

  /**
   * Refuse a backup that cannot be made before anything is stopped for it. Data the Hub cannot read is
   * archived by the root helper, and when that cannot run (no image here and no network to pull one)
   * the backup used to fail only after the app had been stopped.
   */
  public async assertBackupPossible(appUrn: AppUrn): Promise<void> {
    const { appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const unreadable = await this.findUnreadableAppData(appDataDir);

    if (unreadable.length === 0 || (await this.docker.privilegedHelperAvailable(appUrn))) {
      return;
    }

    throw new Error(
      `Cannot back up ${appUrn}: the Hub cannot read ${unreadable.slice(0, 3).join(', ')} (written by the app's own container as another user) ` +
        'and cannot run the helper that archives it as root. Nothing was stopped.',
    );
  }

  /**
   * The Hub's own copy of the app's data for a backup. An app that has not written anything yet may have
   * no data folder. The archive still gets one, because a restore refuses a backup without it. Data the
   * Hub already knows it cannot read is not copied: the copy would stop at the first such file, after
   * copying the rest for nothing, and root archives it instead.
   */
  private async copyAppDataForBackup(appDataDir: string, dest: string): Promise<{ copied: boolean; permissionDenied: boolean }> {
    if (!(await this.filesystem.pathExists(appDataDir))) {
      return { copied: await this.filesystem.createDirectory(dest), permissionDenied: false };
    }

    if ((await this.findUnreadableAppData(appDataDir)).length > 0) {
      return { copied: false, permissionDenied: true };
    }

    return this.filesystem.copyDirectoryDetailed(appDataDir, dest, appDataCopyOptions(appDataDir));
  }

  /** What the Hub cannot read of the data a backup takes. What a backup leaves out never needs the root helper. */
  private findUnreadableAppData(appDataDir: string): Promise<string[]> {
    return this.filesystem.findUnreadable(appDataDir, { skip: leftOutOfBackups });
  }

  /** Remove whatever an earlier backup of this app left in staging. Everything there is the Hub's to delete. */
  private async clearBackupStaging(appUrn: AppUrn) {
    const { dataDir } = this.config.get('directories');
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const stagingDir = path.join(dataDir, 'backups', BACKUP_STAGING_DIRNAME, appStoreId, appName);

    if (await this.filesystem.pathExists(stagingDir)) {
      await this.filesystem.removeDirectory(stagingDir);
    }
  }

  /**
   * @param deadline the budget the restore's root helpers share (the delete, then the extract), so the command
   *   still answers the queue in time on a big data folder. A caller doing more than the restore passes its own.
   */
  public restoreApp = async (appUrn: AppUrn, filename: string, deadline: AppCommandDeadline = this.commandDeadline()) => {
    const { dataDir } = this.config.get('directories');
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);

    // `resolveBackupFilePath` asserts containment itself, after resolution. The
    // string-prefix check that used to stand here is both redundant and wrong in two
    // directions: it passes a sibling directory sharing the prefix, and it fails a
    // correctly-contained path whenever `dataDir` is relative (the resolved archive is
    // absolute, the prefix is not), which would make every restore throw.
    const archive = resolveBackupFilePath(backupDir, filename);

    this.logger.info('Restoring app from backup...');

    // Verify the app has a backup. `isFile` is an lstat: a symlink dropped into the backups
    // folder is not a backup, whatever it points at.
    if (!(await this.filesystem.isFile(archive))) {
      throw new Error('The backup file does not exist');
    }

    const restoreDir = await this.filesystem.createTempDirectory(appUrn);

    if (!restoreDir) {
      throw new Error('Failed to create temp directory');
    }

    let staging: { id: string; dir: string; archive: string } | null = null;

    try {
      await this.filesystem.createDirectory(restoreDir);

      // ⚠ EVERYTHING BEFORE THE REPLACEMENT IS A GATE. Restoring deletes the app's live
      // data before it writes the backup's, so an archive that turns out to be corrupt,
      // truncated, or hostile must be rejected while the live data is still there.
      // Each of these throws; none of them is advisory.
      const checkListing = async (file: string) => {
        try {
          return await this.checkArchiveListing(file);
        } catch (error) {
          this.logRejectedBackup(filename, error);
          throw error;
        }
      };

      let source = archive;
      // A backup the root helper archived carries the data's real owners, and root puts them back.
      let dataMember = await checkListing(source);

      if (dataMember) {
        // Root reads the archive once more, after the live data is gone. So from here on every step reads
        // a link to this file in a folder only the Hub writes. The name in the backups folder can be
        // deleted and uploaded again while the restore runs.
        staging = await this.stageBackupForRootRestore(appUrn, archive);
        source = staging.archive;
        dataMember = await checkListing(source);
      }

      // Checked while the live data is still there, as a backup checks before it stops the app.
      if (dataMember && !(await this.docker.privilegedHelperAvailable())) {
        throw new Error(
          `Cannot restore ${appUrn}: its data goes back as root with its owners, and the helper that does that cannot run. Nothing was changed.`,
        );
      }

      this.logger.info('Extracting archive...');
      const { stderr, stdout } = await this.archiveManager.extractTarGz(source, restoreDir);
      this.logger.debug('--- archiveManager.extractTarGz ---');
      this.logger.debug('stderr:', stderr);
      this.logger.debug('stdout:', stdout);

      let volumeKeys: string[];

      try {
        await validateRestoreDirectory(path.join(restoreDir, 'app-data'), { required: true, symlinks: true });
        await validateRestoreDirectory(path.join(restoreDir, 'app'), { required: true });
        await validateRestoreDirectory(path.join(restoreDir, 'user-config'), { required: false });
        volumeKeys = await readVolumeArchiveKeys(path.join(restoreDir, 'volumes'));

        // A restore empties each volume before it unpacks the archive into it, so an archive that tar
        // cannot read to the end (cut short, or not a tar at all) would cost the app its database.
        for (const key of volumeKeys) {
          await this.archiveManager.verifyPlainTar(path.join(restoreDir, 'volumes', `${key}.tar`));
        }
      } catch (error) {
        this.logRejectedBackup(filename, error);
        throw error;
      }

      // Part of the gate as well, so a volume that cannot go back is found out while the app still has
      // its files. A backup without volumes (made on Linux, or before they were included) never asks Docker.
      const volumes = volumeKeys.length > 0 ? await this.appVolumes.restoreTargets(appUrn, volumeKeys) : [];

      // The same for a backup the Hub copies back itself, when what the app wrote can only be deleted as
      // root. The Hub would otherwise delete what it can first and find out afterwards.
      let needsRoot = Boolean(dataMember);

      if (!dataMember) {
        const { appDataDir } = this.appFilesManager.getAppPaths(appUrn);
        const undeletable = await this.filesystem.findUndeletable(appDataDir);
        needsRoot = undeletable.length > 0;

        if (needsRoot && !(await this.docker.privilegedHelperAvailable(appUrn))) {
          throw new Error(
            `Cannot restore ${appUrn}: the Hub cannot delete what its container wrote in ${undeletable.slice(0, 3).join(', ')}, ` +
              'and the helper that deletes it as root cannot run. Nothing was changed.',
          );
        }
      }

      // The checks above count against the budget too, and on a big backup they can use all of it. A root
      // helper would then refuse to start, after the Hub had already deleted its own part of the data
      // (app.env first), so the restore stops here instead, with the data as it was.
      if (needsRoot && deadline.expired) {
        throw this.outOfTime('Restoring', appUrn, deadline, 'Nothing was changed.');
      }

      await this.replaceAppFiles(appUrn, restoreDir, dataMember && staging ? { stagingId: staging.id, member: dataMember } : null, deadline);

      for (const volume of volumes) {
        this.logger.info(`Restoring Docker volume ${volume.name}...`);
        await this.appVolumes.importVolume(appUrn, volume, path.join(restoreDir, 'volumes', `${volume.key}.tar`));
      }
    } finally {
      // Always, including when validation or extraction threw: an unsafe upload would
      // otherwise leave its extracted contents in the temp folder indefinitely.
      await this.filesystem.removeDirectory(restoreDir);

      if (staging) {
        await this.filesystem.removeDirectory(staging.dir);
      }
    }
  };

  /**
   * List the archive and refuse it if any entry is unsafe.
   *
   * @returns the name of its data folder when the backup was made with its owners, for root to extract, or `null`.
   */
  private async checkArchiveListing(archive: string): Promise<string | null> {
    const entries = await this.archiveManager.listTarGz(archive);
    validateRestoreArchiveEntries(entries);

    return appDataMemberWithOwners(entries);
  }

  /**
   * Keep the archive of a restore that root will read where only the Hub writes: a hard link, which the
   * name in the backups folder going away does not affect, or a copy where the two are on different
   * file systems.
   */
  private async stageBackupForRootRestore(appUrn: AppUrn, archive: string): Promise<{ id: string; dir: string; archive: string }> {
    const staging = await this.docker.createRestoreStagingDir(appUrn);

    if (!staging) {
      throw new Error(`Could not prepare the restore of ${appUrn} as root. Nothing was changed.`);
    }

    try {
      await fs.promises.link(archive, staging.archive);
    } catch {
      if (!(await this.filesystem.copyFile(archive, staging.archive))) {
        await this.filesystem.removeDirectory(staging.dir);
        throw new Error(`Could not prepare the restore of ${appUrn} as root. Nothing was changed.`);
      }
    }

    return staging;
  }

  /** Write each of the app's named Docker volumes into `dir` as `<key>.tar`. An app with none gets no folder. */
  private async archiveAppVolumes(appUrn: AppUrn, dir: string) {
    const volumes = (await this.appVolumes.listAppVolumes(appUrn)).map((volume) => ({ ...volume, file: `${volume.key}.tar` }));

    if (volumes.length === 0) {
      return;
    }

    // Every name is checked before any volume is copied, so a bad one does not cost a full copy of the
    // others first. A restore refuses a name outside the pattern, and two volumes under one key would
    // leave one out.
    const files = new Set<string>();

    for (const { name, file } of volumes) {
      if (!VOLUME_ARCHIVE_NAME.test(file) || files.has(file)) {
        throw new Error(`Volume ${name} cannot go in a backup under the name "${file}"`);
      }

      files.add(file);
    }

    await this.filesystem.createDirectory(dir);

    for (const { name, file } of volumes) {
      this.logger.info(`Including Docker volume ${name} in backup...`);
      await this.appVolumes.exportVolume(name, path.join(dir, file));
    }
  }

  /** Say in the log which entry made a backup unusable; the error the caller sees cannot name it. */
  private logRejectedBackup(filename: string, error: unknown) {
    const detail = error instanceof UnsafeBackupError ? error.detail : error instanceof Error ? error.message : String(error);
    this.logger.error(`Backup ${filename} was refused: ${detail}`);
  }

  /** Swap the app's live folders for the (already validated) ones extracted from a backup. */
  private async replaceAppFiles(
    appUrn: AppUrn,
    restoreDir: string,
    withOwners: { stagingId: string; member: string } | null,
    deadline: AppCommandDeadline,
  ) {
    const { dataDir } = this.config.get('directories');
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const userConfigDir = path.join(dataDir, 'user-config', appStoreId, appName);

    // Remove old data directories
    await this.removeLiveAppData(appUrn, appDataDir, deadline);
    await this.filesystem.removeDirectory(appInstalledDir);
    await this.filesystem.removeDirectory(userConfigDir);

    await this.filesystem.createDirectory(appDataDir);
    await this.filesystem.createDirectory(appInstalledDir);
    await this.filesystem.createDirectory(userConfigDir);

    // Copy data from the backup folder. `copyDirectory` reports failure by returning false
    // (ENOSPC, EACCES), and a restore that copied nothing must not report success. The data of a backup
    // made with its owners goes back through root from the same archive, which every check above passed.
    const copied = [
      withOwners
        ? (await this.docker.extractBackupAppDataAsRoot(appUrn, withOwners.stagingId, withOwners.member, deadline)) &&
          (await this.rootRestoreLanded(appUrn, path.join(restoreDir, 'app-data'), appDataDir))
        : await this.filesystem.copyDirectory(path.join(restoreDir, 'app-data'), appDataDir, { verbatimSymlinks: true }),
      await this.filesystem.copyDirectory(path.join(restoreDir, 'app'), appInstalledDir),
    ];

    if (await this.filesystem.isDirectory(path.join(restoreDir, 'user-config'))) {
      copied.push(await this.filesystem.copyDirectory(path.join(restoreDir, 'user-config'), userConfigDir));
    }

    if (copied.includes(false)) {
      throw deadline.expired
        ? this.outOfTime(
            'Restoring',
            appUrn,
            deadline,
            'The backup is unchanged; the data the app has now may be incomplete until it is restored again.',
          )
        : new Error('Failed to restore the backup files');
    }

    // A backup taken before a folder existed does not bring it back, and Docker would create it as root.
    await this.appFilesManager.createVolumeHostDirs(appUrn);
  }

  /**
   * Whether the data root extracted is where the Hub looks for it. The helper writes to the host path it
   * works out from the settings, not to the Hub's own mount, so its exit status alone does not prove the
   * app got its data back. The Hub extracted the same archive into `extracted`, so the top-level names
   * of the data folder must all be there.
   */
  private async rootRestoreLanded(appUrn: AppUrn, extracted: string, appDataDir: string): Promise<boolean> {
    const present = new Set(await this.filesystem.listFiles(appDataDir));
    const missing = (await this.filesystem.listFiles(extracted)).filter((name) => !present.has(name));

    if (missing.length > 0) {
      this.logger.error(`Root restored the data of ${appUrn}, but ${appDataDir} does not hold ${missing.slice(0, 3).join(', ')}`);
      return false;
    }

    return true;
  }

  /**
   * Delete the app's data folder so the backup's copy replaces it instead of being mixed into it. Data
   * a container wrote as another user (Uptime Kuma re-creates its `data/` as root after Reset app) goes
   * through the root helper. Data that still cannot go stops the restore before anything is copied,
   * since a copy over what is left would leave old and restored files side by side.
   */
  private async removeLiveAppData(appUrn: AppUrn, appDataDir: string, deadline: AppCommandDeadline) {
    if (
      !(await removeAppDataDirWithRootFallback(
        { filesystem: this.filesystem, docker: this.docker, logger: this.logger },
        appUrn,
        appDataDir,
        deadline,
      ))
    ) {
      throw deadline.expired
        ? this.outOfTime('Restoring', appUrn, deadline, 'The backup is unchanged; part of the current data may already be gone.')
        : new Error(`Could not remove the current data of ${appUrn} to restore the backup`);
    }
  }

  /** The budget for one backup or restore command, from the same setting as the queue that waits for it. */
  private commandDeadline(): AppCommandDeadline {
    return AppCommandDeadline.forAppCommand(this.config.get('userSettings').eventsTimeout);
  }

  /**
   * Said when the root helpers used up the command's budget. The helper was stopped at the limit, so
   * nothing goes on writing after the command has answered.
   */
  private outOfTime(doing: string, appUrn: AppUrn, deadline: AppCommandDeadline, outcome: string): Error {
    return new Error(
      `${doing} ${appUrn} ran out of time: the root helpers it needs get ${deadline.describe()} in all, so that it can still report back ` +
        `before the Hub stops waiting for it. ${outcome}`,
    );
  }

  /**
   * Delete a backup file
   * @param appUrn - The app id
   * @param filename - The filename of the backup
   */
  public async deleteBackup(appUrn: AppUrn, filename: string) {
    const { dataDir } = this.config.get('directories');

    const { appName, appStoreId } = extractAppUrn(appUrn);
    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);
    const backupPath = resolveBackupFilePath(backupDir, filename);

    if (await this.filesystem.pathExists(backupPath)) {
      await this.filesystem.removeFile(backupPath);
    }
  }

  /**
   * Clean up old backups based on retention policy
   * @param appUrn - The app id
   * @param maxBackups - Maximum number of backups to keep (0 means no limit)
   */
  public async cleanupOldBackups(appUrn: AppUrn, maxBackups: number) {
    if (!maxBackups) {
      return;
    }

    const backups = await this.listBackupsByAppId(appUrn);

    if (backups.length <= maxBackups) {
      return;
    }

    backups.sort((a, b) => b.date - a.date);

    const backupsToDelete = backups.slice(maxBackups);
    this.logger.info(`Cleaning up ${backupsToDelete.length} old backup(s) for ${appUrn}...`);

    await Promise.all(backupsToDelete.map((backup) => this.deleteBackup(appUrn, backup.id)));
    this.logger.info(`Cleanup completed for ${appUrn}`);
  }

  /**
   * The HOST path of an app's backup directory (`{ROOT_FOLDER_HOST}/backups/{store}/{app}`) —
   * the path to show a user for a manual `rm`, never the in-container one.
   *
   * Deliberately NOT built on `getAppDataHostPath`: that resolves against an app-data base the
   * operator can relocate (`CI_HUB_APP_DATA_PATH` / `appDataPath`), whereas backups always live
   * under the hub's own data dir, which is bind-mounted straight from `ROOT_FOLDER_HOST`.
   *
   * Best-effort guidance only — returns undefined on a misconfigured (non-absolute)
   * ROOT_FOLDER_HOST instead of throwing, so resolving a path for a warning message can never
   * escalate into a failed uninstall.
   */
  public getAppBackupsHostDir(appUrn: AppUrn): string | undefined {
    const rootFolderHost = this.config.get('rootFolderHost');

    if (!rootFolderHost || !isAbsoluteHostPath(rootFolderHost)) {
      return undefined;
    }

    const { appName, appStoreId } = extractAppUrn(appUrn);
    return joinHostPath(rootFolderHost, 'backups', appStoreId, appName);
  }

  /**
   * Delete all backups for an app
   * @param appUrn - The app id
   */
  public async deleteAppBackupsByUrn(appUrn: AppUrn): Promise<void> {
    const backups = await this.listBackupsByAppId(appUrn);

    await Promise.all(backups.map((backup) => this.deleteBackup(appUrn, backup.id)));
  }

  /**
   * List the backups for an app
   * @param appUrn - The app id
   * @returns The list of backups
   */
  public async listBackupsByAppId(appUrn: AppUrn) {
    const { dataDir } = this.config.get('directories');

    const { appName, appStoreId } = extractAppUrn(appUrn);
    const backupsDir = path.join(dataDir, 'backups', appStoreId, appName);

    if (!(await this.filesystem.pathExists(backupsDir))) {
      return [];
    }

    try {
      const list = await this.filesystem.listFiles(backupsDir);

      const backups = await Promise.all(
        list.map(async (backup) => {
          const stats = await this.filesystem.getStats(path.join(backupsDir, backup));
          return { id: backup, size: stats.size, date: stats.mtime.getTime() };
        }),
      );

      return backups;
    } catch (error) {
      this.logger.error(`Error listing backups for app ${appUrn}:`, error);
      return [];
    }
  }

  /**
   * Get the file path for a backup
   * @param appUrn - The app id
   * @param filename - The filename of the backup
   * @returns The backup file path
   */
  public async getBackupPath(appUrn: AppUrn, filename: string): Promise<string> {
    const { dataDir } = this.config.get('directories');
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);

    const backupPath = resolveBackupFilePath(backupDir, filename);

    if (!(await this.filesystem.isFile(backupPath))) {
      throw new Error('The backup file does not exist');
    }

    return backupPath;
  }

  /**
   * Upload a backup file
   * @param appUrn - The app id
   * @param filename - The filename of the backup
   * @param fileBuffer - The file buffer
   */
  public async uploadBackup(appUrn: AppUrn, filename: string, fileBuffer: Buffer): Promise<void> {
    const { dataDir } = this.config.get('directories');
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);

    const backupPath = resolveBackupFilePath(backupDir, filename);

    // Create backup directory if it doesn't exist
    await this.filesystem.createDirectory(backupDir);

    // Check if file already exists
    if (await this.filesystem.pathExists(backupPath)) {
      // A TranslatableError, not a bare Error: that one reaches the client as "INTERNAL_SERVER_ERROR".
      throw new TranslatableError('APP_BACKUP_UPLOAD_ALREADY_EXISTS', {}, HttpStatus.CONFLICT);
    }

    // Write the file. `writeBinaryFile` reports failure by returning false rather than
    // throwing, so an unwritable backup directory (EACCES, ENOSPC) otherwise produced a
    // logged error, no file, and a `{ success: true }` response to the uploader.
    const written = await this.filesystem.writeBinaryFile(backupPath, fileBuffer);

    if (!written) {
      throw new Error('Failed to write the backup file');
    }

    this.logger.info(`Backup uploaded successfully: ${filename}`);
  }

  /**
   * Walk all backup directories and enforce a retention limit.
   * Uses the global maxBackups setting or a default of 5 as a safety net.
   */
  public async enforceRetentionAllApps() {
    const { dataDir } = this.config.get('directories');
    const globalMax = this.config.get('userSettings').maxBackups || BackupManager.DEFAULT_MAX_BACKUPS;
    const backupsRoot = path.join(dataDir, 'backups');

    if (!fs.existsSync(backupsRoot)) return;

    let totalCleaned = 0;

    try {
      const storeIds = await this.filesystem.listFiles(backupsRoot);
      for (const storeId of storeIds) {
        // A leading dot marks Hub bookkeeping (the pre-update snapshots), not an app store.
        if (storeId.startsWith('.')) continue;
        const storeDir = path.join(backupsRoot, storeId);
        const stat = await this.filesystem.getStats(storeDir);
        if (!stat.isDirectory()) continue;

        const appNames = await this.filesystem.listFiles(storeDir);
        for (const appName of appNames) {
          const appBackupDir = path.join(storeDir, appName);
          const appStat = await this.filesystem.getStats(appBackupDir);
          if (!appStat.isDirectory()) continue;

          // An app URN is `<appName>:<appStoreId>` (see extractAppUrn), but the backups
          // tree is laid out `backups/<appStoreId>/<appName>`. Composing the URN in
          // directory order inverted the halves, so every lookup below resolved to
          // `backups/<appName>/<appStoreId>` — a path that never exists — and this whole
          // retention sweep silently cleaned nothing.
          const appUrn = `${appName}:${storeId}` as AppUrn;
          const backups = await this.listBackupsByAppId(appUrn);

          if (backups.length > globalMax) {
            backups.sort((a, b) => b.date - a.date);
            const toDelete = backups.slice(globalMax);
            await Promise.all(toDelete.map((b) => this.deleteBackup(appUrn, b.id)));
            totalCleaned += toDelete.length;
          }
        }
      }
    } catch (e) {
      this.logger.error('Error during backup retention enforcement', e);
    }

    if (totalCleaned > 0) {
      this.logger.info(`Backup retention: removed ${totalCleaned} old backup(s) across all apps`);
    }
  }
}
