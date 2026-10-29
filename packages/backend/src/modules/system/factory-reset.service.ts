import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { removeSettingsJsonCopies, writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { APP_DATA_DIR, DATA_DIR, TUNNEL_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { isHomeFolder, isTopOrHomeFolder } from '@/common/helpers/home-folder';
import { linkedMountSource, type MountInfoEntry, mountedDataRoot, mountedFromFolder, parseMountInfo } from '@/common/helpers/mount-source';
import {
  apiKey,
  app,
  appStore,
  deviceRegistration,
  entitlementCache,
  federatedIdentity,
  hostEventLog,
  hostTelemetrySample,
  hubPoolIdentity,
  hubPoolPeer,
  lifecycleJob,
  link,
  memoryConnection,
  portAllocation,
  user,
  userDirectory,
  whoisCache,
} from '@/core/database/drizzle/schema';
import { DATABASE, type Database } from '@/core/database/database.module';
import { CacheService } from '@/core/cache/cache.service';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService, inSettingsFileTurn, newHubLocalKey } from '@/core/config/configuration.service';
import { UninstallAppCommand } from '@/modules/app-lifecycle/commands/uninstall-app-command';
import { ExposureSyncService } from '@/modules/app-lifecycle/exposure-sync.service';
import { withTimeout } from '@/common/helpers/with-timeout';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PairingAppRestoreService } from '@/modules/app-lifecycle/pairing-app-restore.service';
import { clearPairingAppCheck, clearRegistrationRecoveryArtifacts } from '@/modules/app-lifecycle/registration-recovery-state';
import { RegistrationService } from '@/modules/registration/registration.service';
import { removeTunnelRegistrationMarker } from '@/modules/registration/tunnel-markers';
import { BearerOrgMembershipCache } from '@/modules/auth/bearer-org-membership.cache';
import { ForwardAuthIdentityResolver } from '@/modules/auth/forward-auth-identity.resolver';
import { HubPoolIdentityService } from '@/modules/hub-pool/hub-pool-identity.service';
import { HubPoolPairingPinService } from '@/modules/hub-pool/hub-pool-pairing-pin.service';
import { AppCredentialsService } from '@/modules/inference/app-credentials.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { InferenceRouterService } from '@/modules/inference/inference-router.service';
import { ModelRegistryService } from '@/modules/inference/model-registry.service';
import { DOCKERODE } from '@/modules/docker/constants';
import { Inject, Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { asc, eq, getTableName, sql } from 'drizzle-orm';

/**
 * Every table in the Hub's database. A factory reset empties them all, so the Hub it leaves keeps no
 * row of the one before. The comments say why for the tables whose rows outlive the people, apps and
 * pairing that made them.
 */
const FACTORY_RESET_TABLES = [
  link,
  app,
  portAllocation,
  deviceRegistration,
  // The stores a person added go for good. The CI Marketplace store is written again right after the
  // reset (`restoreCloudAppStore`), as boot writes it.
  appStore,
  // Named rather than left to CASCADE, which reaches both through `user`; see `wipeDatabase`.
  apiKey,
  federatedIdentity,
  user,
  // The next read mints a new directory, so an app backup restored after the reset sees a new Hub's people.
  userDirectory,
  // Memory keys of apps the reset removed: an app installed again under the same name was handed the old one.
  memoryConnection,
  // What the old organization bought and may use.
  entitlementCache,
  whoisCache,
  // Hub Pool pairings with their tokens and this node's key that the peers pinned.
  hubPoolPeer,
  hubPoolIdentity,
  // History of apps that are gone.
  lifecycleJob,
  hostEventLog,
  hostTelemetrySample,
];

/**
 * What became of the apps Companion Portal lists for this device.
 *
 * - `kept`: the person didn't ask to remove them. They stay listed and pairing this Hub again
 *   reinstalls them (`PairingAppRestoreService`).
 * - `removed`: the Portal took the empty app list and released them.
 * - `not_paired`: the Hub had no tunnel registration, so there was nothing to tell.
 * - `failed`: the Portal couldn't be reached in time or refused. They are still listed.
 */
export type FactoryResetPortalApps = 'kept' | 'removed' | 'not_paired' | 'failed';

export interface FactoryResetOptions {
  /** Release every app the Portal lists for this device before the device key goes. Off by default. */
  removeAppsFromPortal?: boolean;
}

@Injectable()
export class FactoryResetService {
  /**
   * How long the reset waits for the Portal to take the empty app list. A Portal that is down or slow
   * must never hold the reset. The apps then stay listed and the result says so.
   */
  static readonly PORTAL_RELEASE_TIMEOUT_MS = 8_000;

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
  private async clearBearerOrgMembership(): Promise<void> {
    await this.forgetIn(BearerOrgMembershipCache, 'Bearer org-membership verdicts', (verdicts) => verdicts.clear());
  }

  /**
   * settings.json holds only the new host-local key now, but what was in it is still in memory: the
   * cloud provider keys in `CloudFallbackService` and the user settings in `ConfigurationService`.
   * Until a restart, apps were handed the old keys. The next provider saved wrote them all back to
   * the file.
   *
   * Resolved through `ModuleRef`, as the Bearer verdicts are, because `SystemModule` does not import
   * `InferenceModule`.
   */
  private async forgetSettingsInMemory(): Promise<void> {
    this.configuration.forgetPersistedUserSettings();
    await this.forgetIn(CloudFallbackService, 'the cloud provider keys in memory', (cloudFallback) => cloudFallback.forgetProviders());
  }

  /**
   * The model pins and the record of what each app was handed, kept in `state/` beside settings.json
   * and in memory. The pins came back after the reset and pinned the old Hub's models again.
   */
  private async forgetInferenceState(): Promise<void> {
    // The router also unloads the unpinned models from their engines, which hold them at `keep_alive: -1`.
    // Its unloads run in the background: they wait for any model load under way, and the page that asked
    // for the reset is signed out meanwhile and leaves before an answer that waited for them. The router
    // logs how they went.
    const forgot = await this.forgetIn(InferenceRouterService, 'the pinned models', (router) => router.forgetPinnedModels());
    if (!forgot) {
      await this.forgetIn(ModelRegistryService, 'the pinned models', (registry) => registry.forgetPins());
    }
    await this.forgetIn(AppCredentialsService, 'the record of what apps were handed', (credentials) => credentials.forgetHandouts());
  }

  /**
   * Put back the CI Marketplace store, which only boot writes (`registerCloudAppStore`). The reset empties
   * `app_store` and `repos/`, so until a restart no store downloaded the catalog. The restore after the
   * next pairing waited for it for good. An install from the App Store failed too. The marketplace is
   * then rebuilt from the table, which also drops the stores a person added from memory. The catalog
   * downloads in the background, as at boot, so the reset answers first. A failure costs a warning,
   * never the reset: the next boot registers the store again.
   */
  private async restoreCloudAppStore(): Promise<void> {
    try {
      const appStores = this.moduleRef.get(AppStoreService, { strict: false });
      const marketplace = this.moduleRef.get(MarketplaceService, { strict: false });
      if (!appStores || !marketplace) return;

      await appStores.registerCloudAppStore();
      await marketplace.initialize();
      void appStores
        .pullRepositories()
        .then(() => marketplace.initialize())
        .catch((error: unknown) => {
          this.logger.warn(`Factory reset could not download the app catalog: ${error instanceof Error ? error.message : String(error)}`);
        });
    } catch (error) {
      this.logger.warn(`Factory reset could not register the CI Marketplace store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run `forget` on a provider of another module, resolved through `ModuleRef` because `SystemModule`
   * imports none of them. One that is missing or fails costs a warning, never the rest of the reset.
   * Returns whether `forget` ran to the end.
   */
  private async forgetIn<T>(token: Type<T>, what: string, forget: (provider: T) => unknown): Promise<boolean> {
    try {
      const provider = this.moduleRef.get(token, { strict: false });
      if (provider) {
        await forget(provider);
        return true;
      }
    } catch (error) {
      this.logger.warn(`Factory reset could not clear ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }

  /**
   * Refuse to run when the Hub's data folder is the top of a disk or a home folder. The reset empties
   * `app-data`, `apps`, `repos`, `backups`, and `user-config` in it, so with
   * `ROOT_FOLDER_HOST=/home/<user>` it emptied `~/repos` and the rest. `cihub reset` refuses a root like
   * that too.
   *
   * The container sees neither that folder nor the host's home, so this goes by the shape of the path
   * (`isTopOrHomeFolder`): `ROOT_FOLDER_HOST` as compose passed it in, and the folder the data folders'
   * mounts come from (`mountedDataRoot`), which names a home folder that `ROOT_FOLDER_HOST` is a link
   * to. A mount from a Linux disk reads without the disk's mount point, so there a folder at the top of
   * the disk, or one `ROOT_FOLDER_HOST` ends in, is taken to be `ROOT_FOLDER_HOST` itself.
   */
  private async refuseHomeFolderRoot(): Promise<void> {
    const configured = this.configuration.get('rootFolderHost');
    const mounted = mountedDataRoot(await readMounts(), this.dataFolders(), configured);
    const root = [configured, mounted].find((folder) => folder !== undefined && isTopOrHomeFolder(folder));

    if (root) {
      this.logger.error(
        `Factory reset refused: the Hub's data folder ${root} is the top of a disk or a home folder, and the reset would empty folders in it`,
      );
      throw new TranslatableError('SETTINGS_FACTORY_RESET_DATA_ROOT_REFUSED', { root }, 409);
    }
  }

  public async execute(options: FactoryResetOptions = {}): Promise<{ success: true; message: string; portalApps: FactoryResetPortalApps }> {
    await this.refuseHomeFolderRoot();

    this.logger.warn('Factory reset requested — tearing down apps, wiping data mounts, and clearing Hub state');

    // Until the database goes, the Hub is still paired while its app rows go one by one. A sync then
    // released the apps from the Portal whatever the person chose.
    const resumeExposureSync = this.holdExposureSync();
    let portalApps: FactoryResetPortalApps;
    try {
      await this.tearDownApps();
      // Asked as this device, so before `wipeDatabase` takes the registration and `resetRegistration` the key.
      portalApps = options.removeAppsFromPortal ? await this.releaseAppsFromPortal() : 'kept';
      await this.wipeDataMounts();
      await this.wipeDatabase();
      await this.clearRegistrationArtifacts();
      // `resetSettings` takes the device key, so a pairing this stops keeps none that Portal issued it.
      await this.registrationService.resetRegistration({ reason: 'manual', removesDeviceKey: true });
      // After the pairing under way is stopped, which may have written its apps check meanwhile.
      await this.clearOldHubRequests();
      await this.resetSettings();
      await this.forgetSettingsInMemory();
      await this.forgetInferenceState();
      await this.restoreCloudAppStore();
      this.cache.clear();
      await this.clearBearerOrgMembership();
    } finally {
      resumeExposureSync();
    }

    this.logger.warn('Factory reset complete — Hub is ready for first-operator setup');

    return {
      success: true,
      message:
        portalApps === 'failed'
          ? "Factory reset complete, but Companion Portal still lists this Hub's apps. Delete the device in the Portal to remove them."
          : 'Factory reset complete. Sign in again to create the first operator account.',
      portalApps,
    };
  }

  /**
   * Hold the Cloudflare sync for the length of the reset (`ExposureSyncService.holdForFactoryReset`).
   * Returns the function that lifts the hold. A sync service that is missing costs a warning, never
   * the reset.
   */
  private holdExposureSync(): () => void {
    try {
      const resume = this.moduleRef.get(ExposureSyncService, { strict: false })?.holdForFactoryReset();
      if (resume) {
        return resume;
      }
    } catch (error) {
      this.logger.warn(`Factory reset could not hold the app sync: ${error instanceof Error ? error.message : String(error)}`);
    }
    return () => undefined;
  }

  /**
   * Tell the Portal this Hub serves no apps, so it releases every app it lists for the device. Only
   * when the person asked for it: by default the list stays, so pairing again restores the apps.
   * Never fails the reset. A Portal that is down, slow or refuses leaves the apps listed. The result
   * says so.
   */
  private async releaseAppsFromPortal(): Promise<FactoryResetPortalApps> {
    try {
      const exposureSync = this.moduleRef.get(ExposureSyncService, { strict: false });
      if (!exposureSync) {
        this.logger.warn('Factory reset could not take the apps off Companion Portal: the app sync service is not available');
        return 'failed';
      }
      const outcome = await withTimeout(
        exposureSync.releaseAllAppsFromPortal(),
        FactoryResetService.PORTAL_RELEASE_TIMEOUT_MS,
        `Companion Portal did not answer within ${FactoryResetService.PORTAL_RELEASE_TIMEOUT_MS / 1000} s`,
      );
      return outcome === 'released' ? 'removed' : 'not_paired';
    } catch (error) {
      this.logger.warn(
        `Factory reset could not take the apps off Companion Portal, which still lists them: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
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
      // `federated_identity` is named for the same reason: a binding that survived would sign its
      // Portal account in as the next person given that id.
      const tables = sql.join(
        FACTORY_RESET_TABLES.map((table) => sql.identifier(getTableName(table))),
        sql`, `,
      );
      await this.db.execute(sql`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
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
      // Here for the same reason: they cache rows of the tables above. The stable id forward auth
      // signs is cached by user id, which `RESTART IDENTITY` hands to the next account.
      await this.forgetIn(ForwardAuthIdentityResolver, 'the stable ids forward auth signs', (resolver) => resolver.forget());
      await this.forgetIn(HubPoolIdentityService, 'the Hub Pool identity in memory', (identity) => identity.forget());
      // A PIN the old operator minted would still let a node ask the reset Hub to pair for ten minutes.
      await this.forgetIn(HubPoolPairingPinService, 'the outstanding Hub Pool pairing PIN', (pins) => pins.cancel());
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
   * Docker followed. See `linkedMountSource`. So is one whose mount comes from a folder of the same
   * name in a home folder, such as `~/repos`, which holds the user's own files (`mountedFromFolder`).
   * A link to a folder of the same name anywhere else looks like a Hub folder kept there, and is
   * emptied.
   *
   * Throws when a folder still has something in it, or was left alone, before the database and the
   * registration are wiped, so the operator can still sign in and run the reset again. The page
   * shows that error, so it says how much is left, names the first few, and points to `cihub reset --yes`.
   */
  public async wipeDataMounts(): Promise<void> {
    // No mounts (outside a container, or not Linux) means every folder is emptied.
    const mounts = await readMounts();
    const rootFolderHost = this.configuration.get('rootFolderHost');
    const left: string[] = [];

    for (const { dir: target, name, mountPoint, names } of this.dataFolders()) {
      const linkedTo = linkedMountSource(mounts, mountPoint, names);

      if (linkedTo) {
        this.logger.error(
          `Factory reset left ${target} alone: it is mounted from ${linkedTo}, not from a folder named ${name}, so it is a link to a folder outside the Hub's data folder`,
        );
        left.push(`${path.basename(target)}/`);
        continue;
      }

      const mountedFrom = mountedFromFolder(mounts, mountPoint, names, rootFolderHost);

      if (mountedFrom && isHomeFolder(mountedFrom)) {
        this.logger.error(
          `Factory reset left ${target} alone: it is mounted from a folder of the same name in the home folder ${mountedFrom}, so it is a link to the user's own files`,
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

  /**
   * The folders the reset empties. `name` is the folder the compose files mount there,
   * `<ROOT_FOLDER_HOST>/<name>`, and `names` are the names its mount root may end in.
   */
  private dataFolders(): Array<{ dir: string; name: string; mountPoint: string; names: string[] }> {
    const { dataDir } = this.configuration.get('directories');

    return [
      { dir: APP_DATA_DIR, name: 'app-data' },
      { dir: path.join(dataDir, 'apps'), name: 'apps' },
      { dir: path.join(dataDir, 'repos'), name: 'repos' },
      { dir: path.join(dataDir, 'backups'), name: 'backups' },
      // Per-app env and compose overrides, which a reinstalled app would pick up again.
      { dir: path.join(dataDir, 'user-config'), name: 'user-config' },
    ].map((folder) => ({ ...folder, mountPoint: toMountPoint(folder.dir), names: [folder.name, path.basename(folder.dir)] }));
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

  /**
   * What the old Hub left in `state/` for its own operator and its last pairing.
   *
   * - `password-change-request`: a password change asked for on the box. Within its 15 minutes it
   *   would set the password of whoever becomes the reset Hub's first operator and turn off their 2FA.
   * - `pairing-app-check.json`: the apps check of the last pairing. It holds app sync and may name the
   *   old device's apps to restore. The next pairing writes its own.
   */
  public async clearOldHubRequests(): Promise<void> {
    const passwordChangeRequest = path.join(DATA_DIR, 'state', 'password-change-request');
    await fs.promises.rm(passwordChangeRequest, { force: true }).catch((error: unknown) => {
      this.logger.warn(`Factory reset could not remove ${passwordChangeRequest}: ${error instanceof Error ? error.message : String(error)}`);
    });
    await clearPairingAppCheck();
    await this.forgetIn(PairingAppRestoreService, 'the backoff of the last pairing apps check', (restore) => restore.forget());
  }

  /**
   * Empty settings.json but for a new host-local key, which the running Hub accepts from then on.
   * `cihub` and the desktop app read the key from this file, so an empty file left them none until
   * the next boot minted one, while the Hub went on accepting the old key, which anyone who copied
   * the file before the reset still holds.
   */
  public async resetSettings(): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    const hubLocalKey = newHubLocalKey();
    // After any save already under way, which would otherwise write the old settings back over these.
    await inSettingsFileTurn(async () => {
      await writeSettingsJsonFile(settingsPath, JSON.stringify({ hubLocalKey }, null, 2), this.logger);
      this.configuration.replaceHubLocalKey(hubLocalKey);
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
