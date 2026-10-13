import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { removeSettingsJsonCopies, writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { APP_DATA_DIR, DATA_DIR, TUNNEL_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { isHomeFolder, isTopOrHomeFolder } from '@/common/helpers/home-folder';
import { linkedMountSource, type MountInfoEntry, mountedDataRoot, parseMountInfo } from '@/common/helpers/mount-source';
import { app } from '@/core/database/drizzle/schema';
import { DATABASE, type Database } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService, inSettingsFileTurn } from '@/core/config/configuration.service';
import { UninstallAppCommand } from '@/modules/app-lifecycle/commands/uninstall-app-command';
import { clearRegistrationRecoveryArtifacts } from '@/modules/app-lifecycle/registration-recovery-state';
import { RegistrationService } from '@/modules/registration/registration.service';
import { removeTunnelRegistrationMarker } from '@/modules/registration/tunnel-markers';
import { BearerOrgMembershipCache } from '@/modules/auth/bearer-org-membership.cache';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { asc, eq, sql } from 'drizzle-orm';

@Injectable()
export class FactoryResetService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly moduleRef: ModuleRef,
    private readonly filesystem: FilesystemService,
    private readonly configuration: ConfigurationService,
    private readonly cache: CacheService,
    private readonly sessionUserCache: SessionUserCache,
    private readonly logger: LoggerService,
    private readonly registrationService: RegistrationService,
  ) {}

  /**
   * Forward-auth Bearer org-membership verdicts live in a process-local store, not `CacheService`,
   * so `cache.clear()` above does not reach them. Without this a subject cached as allowed seconds
   * before the reset keeps passing forward-auth for the rest of its TTL — on an appliance that has
   * just been unbound from the organisation that vouched for them.
   *
   * Resolved through `ModuleRef` rather than injected because `SystemModule` does not import
   * `AuthModule`, and a reset must not fail if that provider is somehow unavailable.
   */
  private clearBearerOrgMembership(): void {
    try {
      this.moduleRef.get(BearerOrgMembershipCache, { strict: false })?.clear();
    } catch (error) {
      this.logger.warn(`Factory reset could not clear Bearer org-membership verdicts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * settings.json is `{}` now, but what was in it is still in memory: the cloud provider keys in
   * `CloudFallbackService`, and the user settings in `ConfigurationService`. Until a restart, apps
   * were handed the old keys, and the next provider saved wrote them all back to the file.
   *
   * Resolved through `ModuleRef`, as the Bearer verdicts are, because `SystemModule` does not import
   * `InferenceModule`.
   */
  private forgetSettingsInMemory(): void {
    this.configuration.forgetPersistedUserSettings();
    try {
      this.moduleRef.get(CloudFallbackService, { strict: false })?.forgetProviders();
    } catch (error) {
      this.logger.warn(`Factory reset could not clear the cloud provider keys in memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Refuse to run when the Hub's data folder is `/` or a home folder. The reset empties `app-data`,
   * `apps`, `repos`, `backups` and `user-config` in it, so with `ROOT_FOLDER_HOST=/home/<user>` it
   * emptied `~/repos` and the rest. `cihub reset` refuses a root like that too.
   *
   * The container sees neither that folder nor the host's home, so this goes by the shape of the path
   * (`isHomeFolder`): `ROOT_FOLDER_HOST` as compose passed it in, and the folder the data folders'
   * mounts come from, which names a home folder that `ROOT_FOLDER_HOST` is a link to. Data folders
   * mounted from the top of their filesystem are as likely to be on a data disk of their own as on
   * `/`, so `/` counts only when `ROOT_FOLDER_HOST` says it.
   */
  private async refuseHomeFolderRoot(): Promise<void> {
    const configured = this.configuration.get('rootFolderHost');
    const mounted = mountedDataRoot(
      await readMounts(),
      this.dataFolders().map(({ dir, name }) => ({ mountPoint: toMountPoint(dir), names: [name, path.basename(dir)] })),
    );
    const root = isTopOrHomeFolder(configured) ? configured : mounted && isHomeFolder(mounted) ? mounted : undefined;

    if (root) {
      this.logger.error(`Factory reset refused: the Hub's data folder ${root} is / or a home folder, and the reset would empty folders in it`);
      throw new TranslatableError('SETTINGS_FACTORY_RESET_DATA_ROOT_REFUSED', { root }, 409);
    }
  }

  public async execute(): Promise<{ success: true; message: string }> {
    await this.refuseHomeFolderRoot();

    this.logger.warn('Factory reset requested — tearing down apps, wiping data mounts, and clearing Hub state');

    await this.tearDownApps();
    await this.wipeDataMounts();
    await this.wipeDatabase();
    await this.clearRegistrationArtifacts();
    await this.registrationService.resetRegistration({ reason: 'manual' });
    await this.resetSettings();
    this.forgetSettingsInMemory();
    this.cache.clear();
    this.clearBearerOrgMembership();

    this.logger.warn('Factory reset complete — Hub is ready for first-operator setup');

    return {
      success: true,
      message: 'Factory reset complete. Sign in again to create the first operator account.',
    };
  }

  public async tearDownApps(): Promise<void> {
    const apps = await this.db.query.app.findMany({ orderBy: asc(app.appName) });
    if (apps.length === 0) {
      return;
    }

    const uninstallCommand = new UninstallAppCommand(this.moduleRef, this.docker, true);

    for (const installedApp of apps) {
      const appUrn = createAppUrn(installedApp.appName, installedApp.appStoreSlug);
      try {
        const result = await uninstallCommand.execute(appUrn);
        if (result.success) {
          // As an ordinary uninstall does once its command succeeds. The TRUNCATE below would take the
          // row anyway, but a reset that stops first (data left behind) must not list apps that are gone.
          await this.db.delete(app).where(eq(app.id, installedApp.id));
        } else {
          this.logger.warn(`Factory reset: app teardown reported failure for ${appUrn}: ${result.message}`);
        }
      } catch (error) {
        this.logger.warn(`Factory reset: failed to tear down ${appUrn}: ${error}`);
      }
    }
  }

  public async wipeDatabase(): Promise<void> {
    try {
      // `api_key` is named rather than left to CASCADE, which reaches it through
      // `created_by_user_id` anyway: a reset has to take every key, and that must not hang on a
      // foreign key. A key acts with its creator's grants, and `RESTART IDENTITY` hands the next
      // account that creator's id, so a key that survived would act as whoever signs in first.
      await this.db.execute(sql`
        TRUNCATE TABLE
          link,
          app,
          port_allocation,
          device_registration,
          app_store,
          api_key,
          "user"
        RESTART IDENTITY CASCADE
      `);
    } finally {
      // In `finally` because the TRUNCATE can commit and still reject on the way back: a wiped
      // user table whose cached DTOs and sessions survived is the worst of both states.
      //
      // This deletes every user row without going through UserRepository, so nothing else drops
      // the cached DTOs. Sessions have to go with them, and they have to go *here*: `execute()`
      // clears the cache only after three more awaits, so a reset that fails partway used to
      // leave a live `ci-hub-sid` behind. `RESTART IDENTITY` then hands the next account the id
      // that cookie names, and it would be admitted as the new operator.
      this.sessionUserCache.invalidate();
      this.cache.clear();
    }
  }

  /**
   * Empty each folder that holds app data, keeping the folder: each is a bind mount, and removing a
   * mount point fails with EBUSY before anything inside it is touched. That is how a reset used to
   * report success with every app backup still on disk.
   *
   * `media` is not one of them. It holds the user's library (books, films, music and downloads that
   * media apps read and write), so a reset leaves it alone; `cihub reset` deletes it with the rest.
   *
   * A folder whose mount comes from a folder with another name is left alone too: on the host it is a
   * link (a symlink, or a junction on Windows) to a folder outside the Hub's data folder, which
   * Docker followed. See `linkedMountSource`.
   *
   * Throws when a folder still has something in it, or was left alone, before the database and the
   * registration are wiped, so the operator can still sign in and run the reset again. The page
   * shows that error, so it says how much is left, names the first few, and points to `cihub reset --yes`.
   */
  public async wipeDataMounts(): Promise<void> {
    // No mounts (outside a container, or not Linux) means every folder is emptied.
    const mounts = await readMounts();
    const left: string[] = [];

    for (const { dir: target, name } of this.dataFolders()) {
      const linkedTo = linkedMountSource(mounts, toMountPoint(target), [name, path.basename(target)]);

      if (linkedTo) {
        this.logger.error(
          `Factory reset left ${target} alone: it is mounted from ${linkedTo}, not from a folder named ${name}, so it is a link to a folder outside the Hub's data folder`,
        );
        left.push(`${path.basename(target)}/`);
        continue;
      }

      const entries = await this.emptyDirectory(target);

      if (entries.length > 0) {
        this.logger.error(`Factory reset could not empty ${target}; still there: ${entries.slice(0, 10).join(', ')}`);
        // Named as they sit in the Hub's data folder (`backups/...`), which is where the operator looks.
        left.push(...entries.map((entry) => `${path.basename(target)}/${entry}`));
      }
    }

    if (left.length > 0) {
      throw new TranslatableError('SETTINGS_FACTORY_RESET_FILES_LEFT', { count: String(left.length), paths: left.slice(0, 3).join(', ') });
    }
  }

  /** The folders the reset empties. `name` is the folder the compose files mount there, `<ROOT_FOLDER_HOST>/<name>`. */
  private dataFolders(): Array<{ dir: string; name: string }> {
    const { dataDir } = this.configuration.get('directories');

    return [
      { dir: APP_DATA_DIR, name: 'app-data' },
      { dir: path.join(dataDir, 'apps'), name: 'apps' },
      { dir: path.join(dataDir, 'repos'), name: 'repos' },
      { dir: path.join(dataDir, 'backups'), name: 'backups' },
      // Per-app env and compose overrides, which a reinstalled app would pick up again.
      { dir: path.join(dataDir, 'user-config'), name: 'user-config' },
    ];
  }

  public async clearRegistrationArtifacts(): Promise<void> {
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    const resolvedEnvPath = path.join(DATA_DIR, 'state', '.env.resolved');

    await fs.promises.unlink(tokenPath).catch(() => undefined);
    // Remove the marker with its token: the desktop app and CLI start the tunnel when both exist.
    await removeTunnelRegistrationMarker().catch((error: unknown) => {
      this.logger.warn(`Factory reset could not remove the tunnel registration marker: ${error instanceof Error ? error.message : String(error)}`);
    });
    await fs.promises.unlink(resolvedEnvPath).catch(() => undefined);
    await clearRegistrationRecoveryArtifacts();
  }

  public async resetSettings(): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    // After any save already under way, which would otherwise write the old settings back over `{}`.
    await inSettingsFileTurn(async () => {
      await writeSettingsJsonFile(settingsPath, '{}', this.logger);
      // Not allowed to fail the reset: the cache and Bearer verdicts after this must still be cleared.
      await removeSettingsJsonCopies(settingsPath).catch((error: unknown) => {
        this.logger.warn(
          `Factory reset could not remove the copies of settings.json in ${path.dirname(settingsPath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  /** Remove everything inside `dirPath`, and return the names of what is still there. */
  private async emptyDirectory(dirPath: string): Promise<string[]> {
    await this.filesystem.createDirectory(dirPath);

    for (const entry of await this.listDirectory(dirPath)) {
      await this.filesystem.removeDirectory(path.join(dirPath, entry));
    }

    return this.listDirectory(dirPath);
  }

  /** `readdir`, with a missing folder read as empty. Any other error is thrown, never read as empty. */
  private async listDirectory(dirPath: string): Promise<string[]> {
    return fs.promises.readdir(dirPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [];
      }

      throw error;
    });
  }
}

/** This process's mounts. Unreadable or missing mountinfo reads as none. */
async function readMounts(): Promise<MountInfoEntry[]> {
  return parseMountInfo(await fs.promises.readFile('/proc/self/mountinfo', 'utf8').catch(() => ''));
}

/** `dir` as mountinfo writes a mount point: absolute, with forward slashes and no drive letter. */
function toMountPoint(dir: string): string {
  return path
    .resolve(dir)
    .replace(/^[A-Za-z]:/, '')
    .split(path.sep)
    .join('/');
}
