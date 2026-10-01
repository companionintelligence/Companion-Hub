import path from 'node:path';

import { resolveBackupFilePath } from './backup-path';
import { UnsafeBackupError, validateRestoreArchiveEntries, validateRestoreDirectory } from './restore-validation';
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

  public backupApp = async (appUrn: AppUrn) => {
    const { dataDir } = this.config.get('directories');
    const backupName = `${appUrn}-${Date.now()}`;
    const { appStoreId, appName } = extractAppUrn(appUrn);

    const backupDir = path.join(dataDir, 'backups', appStoreId, appName);

    const tempDir = await this.filesystem.createTempDirectory(appUrn);

    if (!tempDir) {
      throw new Error('Failed to create temp directory');
    }

    this.logger.info('Copying files to backup location...');

    try {
      await this.filesystem.createDirectory(tempDir);

      const { appDataDir, appInstalledDir } = this.appFilesManager.getAppPaths(appUrn);
      const userConfigDir = path.join(dataDir, 'user-config', appStoreId, appName);

      // Links are copied as links with their targets as written: by default `fs.cp` rewrites a relative
      // target to an absolute one under the SOURCE folder, which no longer points anywhere once the
      // data is restored somewhere else.
      // An app that has not written anything yet may have no data folder. The archive still gets one,
      // because a restore refuses a backup without it.
      const dataCopied = (await this.filesystem.pathExists(appDataDir))
        ? await this.filesystem.copyDirectory(appDataDir, path.join(tempDir, 'app-data'), {
            recursive: true,
            verbatimSymlinks: true,
            // Judged on the path inside the app's data folder: the folder itself may live under a path that
            // contains "backups" (a volume mounted at /mnt/backups), and excluding it excluded everything.
            filter: (src) => !path.relative(appDataDir, src).includes('backups'),
          })
        : await this.filesystem.createDirectory(path.join(tempDir, 'app-data'));
      const filesCopied = await this.filesystem.copyDirectory(appInstalledDir, path.join(tempDir, 'app'));

      if (!dataCopied || !filesCopied) {
        throw new Error('Failed to copy the app files for the backup');
      }

      if (await this.filesystem.pathExists(userConfigDir)) {
        this.logger.info('Including user configuration in backup...');

        if (!(await this.filesystem.copyDirectory(userConfigDir, path.join(tempDir, 'user-config')))) {
          throw new Error('Failed to copy the app configuration for the backup');
        }
      }

      this.logger.info('Creating archive...');

      // Beside the folder being archived, not inside it: an archive written into its own source is
      // read as it grows, and a tar that skips it is a tar that may exit non-zero.
      const archivePath = `${tempDir}.tar.gz`;
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
    }
  };

  public restoreApp = async (appUrn: AppUrn, filename: string) => {
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

    try {
      await this.filesystem.createDirectory(restoreDir);

      // ⚠ EVERYTHING BEFORE THE REPLACEMENT IS A GATE. Restoring deletes the app's live
      // data before it writes the backup's, so an archive that turns out to be corrupt,
      // truncated, or hostile must be rejected while the live data is still there.
      // Each of these throws; none of them is advisory.
      try {
        validateRestoreArchiveEntries(await this.archiveManager.listTarGz(archive));
      } catch (error) {
        this.logRejectedBackup(filename, error);
        throw error;
      }

      this.logger.info('Extracting archive...');
      const { stderr, stdout } = await this.archiveManager.extractTarGz(archive, restoreDir);
      this.logger.debug('--- archiveManager.extractTarGz ---');
      this.logger.debug('stderr:', stderr);
      this.logger.debug('stdout:', stdout);

      try {
        await validateRestoreDirectory(path.join(restoreDir, 'app-data'), { required: true, symlinks: true });
        await validateRestoreDirectory(path.join(restoreDir, 'app'), { required: true });
        await validateRestoreDirectory(path.join(restoreDir, 'user-config'), { required: false });
      } catch (error) {
        this.logRejectedBackup(filename, error);
        throw error;
      }

      await this.replaceAppFiles(appUrn, restoreDir);
    } finally {
      // Always, including when validation or extraction threw: an unsafe upload would
      // otherwise leave its extracted contents in the temp folder indefinitely.
      await this.filesystem.removeDirectory(restoreDir);
    }
  };

  /** Say in the log which entry made a backup unusable; the error the caller sees cannot name it. */
  private logRejectedBackup(filename: string, error: unknown) {
    const detail = error instanceof UnsafeBackupError ? error.detail : error instanceof Error ? error.message : String(error);
    this.logger.error(`Backup ${filename} was refused: ${detail}`);
  }

  /** Swap the app's live folders for the (already validated) ones extracted from a backup. */
  private async replaceAppFiles(appUrn: AppUrn, restoreDir: string) {
    const { dataDir } = this.config.get('directories');
    const { appStoreId, appName } = extractAppUrn(appUrn);
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    const userConfigDir = path.join(dataDir, 'user-config', appStoreId, appName);

    // Remove old data directories
    await this.filesystem.removeDirectory(appDataDir);
    await this.filesystem.removeDirectory(appInstalledDir);
    await this.filesystem.removeDirectory(userConfigDir);

    await this.filesystem.createDirectory(appDataDir);
    await this.filesystem.createDirectory(appInstalledDir);
    await this.filesystem.createDirectory(userConfigDir);

    // Copy data from the backup folder. `copyDirectory` reports failure by returning false
    // (ENOSPC, EACCES), and a restore that copied nothing must not report success.
    const copied = [
      await this.filesystem.copyDirectory(path.join(restoreDir, 'app-data'), appDataDir, { verbatimSymlinks: true }),
      await this.filesystem.copyDirectory(path.join(restoreDir, 'app'), appInstalledDir),
    ];

    if (await this.filesystem.isDirectory(path.join(restoreDir, 'user-config'))) {
      copied.push(await this.filesystem.copyDirectory(path.join(restoreDir, 'user-config'), userConfigDir));
    }

    if (copied.includes(false)) {
      throw new Error('Failed to restore the backup files');
    }
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
