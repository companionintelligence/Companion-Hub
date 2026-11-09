import fs from 'node:fs';
import path from 'node:path';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { mergeArchitectureOverrides, oneShotServiceNames } from '@/common/helpers/compose-helpers';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { supportsPosixPermissions } from '@/common/helpers/bind-mount-helpers';
import { execAsync } from '@/common/helpers/exec-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { Injectable } from '@nestjs/common';
import { securityGrantsFor } from './security-grants';
import { parseInstalledAppInfo, parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** What an app's pulls, or those of an app that handed them over, brought onto this computer, as its record holds it. */
export type PulledImages = {
  imageIds: string[];
  /** The tags those images had when they arrived. Any other tag came from something else: see `DockerService.removeAppImages`. */
  imageTags: string[];
};

/** What was last logged as left out of each app's installed manifest. */
const loggedLeftOut = new Map<string, string>();

/** Store folders the Hub could not close, so every prepare of every app in one does not warn again. */
const storeDirsLeftOpen = new Set<string>();

/**
 * Logs what `parseInstalledAppInfo` left out of an app's installed manifest, once until that changes.
 * The manifest is read on every app list, status check and env build, and it says the same thing
 * until the app is updated.
 */
export function warnHubOwnedEnvLeftOut(logger: Pick<LoggerService, 'warn'>, appUrn: AppUrn, leftOut: readonly string[], file: string): void {
  if (leftOut.length === 0) {
    return;
  }
  const said = leftOut.join(', ');
  if (loggedLeftOut.get(appUrn) === said) {
    return;
  }
  loggedLeftOut.set(appUrn, said);
  logger.warn(`App ${appUrn}: its ${file} names values the Hub sets for every app, read without ${said}`);
}

/** Single-quote a path for `sh`. */
function shellQuotePath(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The shell that makes an app's data tree writable by every uid, minus the
 * paths in `excluded` and everything under them. With nothing excluded it is
 * the historical `chmod -Rf a+rwx`; otherwise `find` prunes each excluded
 * path (so a private volume's whole subtree is skipped, not just its root)
 * and chmods the rest. Exported for its tests.
 *
 * `hubUid` is the uid the Hub runs as. When it is not root, the sweep only
 * changes what that uid owns, because chmod refuses everything else. It also
 * does not walk into a folder that belongs to another user and is closed to
 * others (`-perm -005` is "others may list and enter"). Those are a
 * database's own folders (MariaDB keeps its schemas at 700 under uid 999) and
 * whatever a container running as root made: walking or chmodding them could
 * only fail. Every such failure made the whole sweep report an error for an
 * app that works. A root Hub can change everything, so it gets the sweep as
 * it always was.
 *
 * Symbolic links are never handed to chmod (`! -type l`). chmod follows a
 * link named on its command line, so a link an app's container left in its
 * data (`data/x -> /data/state/settings.json`) made that file, outside the
 * app's folder, world-writable. `chmod -R` already skips the links it meets.
 */
export function buildPermissionsCommand(appDataDir: string, excluded: readonly string[], hubUid?: number): string {
  const dir = shellQuotePath(appDataDir);
  const ownedOnly = hubUid !== undefined && Number.isInteger(hubUid) && hubUid > 0;
  if (excluded.length === 0 && !ownedOnly) {
    return `chmod -Rf a+rwx ${dir}`;
  }
  const prune = excluded.map((target) => `-path ${shellQuotePath(target)}`);
  if (!ownedOnly) {
    return `find ${dir} \\( ${prune.join(' -o ')} \\) -prune -o ! -type l -exec chmod -f a+rwx {} +`;
  }
  prune.push(`-type d ! -user ${hubUid} ! -perm -005`);
  return `find ${dir} \\( ${prune.join(' -o ')} \\) -prune -o ! -type l -user ${hubUid} -exec chmod -f a+rwx {} +`;
}

@Injectable()
export class AppFilesManager {
  private readonly pulledImagesMutex = new AsyncMutex();

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
  ) {}

  private getInstalledAppsFolder() {
    const { directories } = this.configuration.getConfig();

    return path.resolve(directories.dataDir, 'apps');
  }

  public getAppPaths(appUrn: AppUrn) {
    const { directories } = this.configuration.getConfig();

    const { appStoreId, appName } = extractAppUrn(appUrn);

    return {
      appDataDir: path.resolve(directories.appDataDir, appStoreId, appName),
      appInstalledDir: path.resolve(this.getInstalledAppsFolder(), appStoreId, appName),
    };
  }

  /**
   * Get the app info from the installed apps apps
   * @param id - The app id
   */
  public async getInstalledAppInfo(appUrn: AppUrn) {
    try {
      const { appInstalledDir } = this.getAppPaths(appUrn);

      if (await this.filesystem.pathExists(path.join(appInstalledDir, 'config.json'))) {
        const configFile = await this.filesystem.readTextFile(path.join(appInstalledDir, 'config.json'));

        const config = JSON.parse(configFile ?? '{}');
        const { parsed: parsedConfig, leftOut } = parseInstalledAppInfo({ ...config, urn: appUrn });
        warnHubOwnedEnvLeftOut(this.logger, appUrn, leftOut, 'config.json');

        if (!parsedConfig.success) {
          this.logger.error(`App ${appUrn} config error:`);
          this.logger.error(parsedConfig.error.message);
          return null;
        }

        if (parsedConfig.data.available) {
          let description = '';
          try {
            const fileExists = await this.filesystem.pathExists(path.join(appInstalledDir, 'metadata', 'description.md'));
            if (fileExists) {
              description = (await this.filesystem.readTextFile(path.join(appInstalledDir, 'metadata', 'description.md'))) ?? '';
            }
          } catch {
            // Ignore missing description
          }

          return { ...parsedConfig.data, description };
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * The defaults the installed manifest gave its fields that write `APP_BASE_URL`, by the field's
   * variable, which `getInstalledAppInfo` reads it without (`parseInstalledAppInfo`). Empty when the
   * manifest gives none or can't be read.
   */
  public async getInstalledBaseUrlDefaults(appUrn: AppUrn): Promise<ReadonlyMap<string, string>> {
    try {
      const configPath = path.join(this.getAppPaths(appUrn).appInstalledDir, 'config.json');
      if (await this.filesystem.pathExists(configPath)) {
        const config = JSON.parse((await this.filesystem.readTextFile(configPath)) ?? '{}');
        return new Map(Object.entries(parseInstalledAppInfo({ ...config, urn: appUrn }).baseUrlDefaults));
      }
    } catch {
      // Read as having none, as `getInstalledAppInfo` reads a manifest it can't parse as no manifest.
    }
    return new Map();
  }

  /**
   * Get the docker-compose.json file content from the installed app
   * @param appUrn - The app id
   * @returns The content of docker-compose.yml as a string, or null if not found
   */
  public async getDockerComposeYaml(appUrn: AppUrn) {
    const { appInstalledDir } = this.getAppPaths(appUrn);

    // Check for both yml and json
    let dockerComposePath = path.join(appInstalledDir, 'docker-compose.yml');

    if (!(await this.filesystem.pathExists(dockerComposePath))) {
      const jsonPath = path.join(appInstalledDir, 'docker-compose.json');
      if (await this.filesystem.pathExists(jsonPath)) {
        dockerComposePath = jsonPath;
      }
    }

    let content = null;
    try {
      if (await this.filesystem.pathExists(dockerComposePath)) {
        content = await this.filesystem.readTextFile(dockerComposePath);
      }
    } catch (error) {
      this.logger.error(`Error getting docker-compose file for installed app ${appUrn}:`, error);
    }

    return { path: dockerComposePath, content };
  }

  /**
   * Get the docker-compose.json file content from the installed app
   * @param appUrn - The app id
   * @returns The content of docker-compose.json as a string, or null if not found
   */
  public async getDockerComposeJson(appUrn: AppUrn) {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    const dockerComposePath = path.join(appInstalledDir, 'docker-compose.json');

    let content = null;
    try {
      if (await this.filesystem.pathExists(dockerComposePath)) {
        content = await this.filesystem.readJsonFile(dockerComposePath);
      }
    } catch (error) {
      this.logger.error(`Error getting docker-compose.json for installed app ${appUrn}:`, error);
    }

    return { path: dockerComposePath, content };
  }

  /**
   * Which services of the installed app are one-shots (see `oneShotServiceNames`), read as
   * `compose-preparation.ts` runs them. None when the app has no docker-compose.json or it can't be read:
   * a failed service then counts as it always has.
   */
  public async getOneShotServiceNames(appUrn: AppUrn): Promise<Set<string>> {
    try {
      const composeJson = await this.getDockerComposeJson(appUrn);
      if (!composeJson.content) {
        return new Set();
      }
      const { services, overrides } = parseInstalledComposeJson(composeJson.content, securityGrantsFor(appUrn));
      return oneShotServiceNames(mergeArchitectureOverrides(services, overrides, this.configuration.get('architecture')));
    } catch (error) {
      this.logger.warn(`Could not read which services of ${appUrn} are one-shots: ${error instanceof Error ? error.message : String(error)}`);
      return new Set();
    }
  }

  /**
   * Write the docker-compose.yml file to the installed app folder
   * @param appUrn - The app id
   * @param composeFile - The content of the docker-compose.yml file
   */
  public async writeDockerComposeYml(appUrn: AppUrn, composeFile: string) {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    const dockerComposePath = path.join(appInstalledDir, 'docker-compose.yml');

    await this.filesystem.writeTextFile(dockerComposePath, composeFile);
  }

  /** Returns whether the app's install folder was fully removed (false on a partial/failed delete). */
  public async deleteAppFolder(appUrn: AppUrn): Promise<boolean> {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    return this.filesystem.removeDirectory(appInstalledDir);
  }

  /**
   * The folder holding each app's record of the image IDs its pulls brought in. It sits in `state/` because a
   * packaged Hub mounts only the folders under `/data`: `/data` itself belongs to root and goes with the container.
   * So the record can be written and it outlives a Hub update, a reset of the app and an app update, which replaces
   * the install folder.
   */
  private getPulledImagesDir(): string {
    const { directories } = this.configuration.getConfig();

    return path.resolve(directories.dataDir, 'state', 'pulled-images');
  }

  private getPulledImagesPath(appUrn: AppUrn): string {
    const { appStoreId, appName } = extractAppUrn(appUrn);

    return path.join(this.getPulledImagesDir(), appStoreId, `${appName}.json`);
  }

  /**
   * What the record holds for the app, or nothing. A record that is missing or unreadable records nothing, so an
   * uninstall then removes no image rather than one the Hub cannot show it pulled. Only an image ID counts: Docker
   * takes a name just as well. A name removes whichever image has that name by then.
   */
  public async readPulledImages(appUrn: AppUrn): Promise<PulledImages> {
    return this.parsePulledImages(appUrn, await this.filesystem.readTextFile(this.getPulledImagesPath(appUrn)));
  }

  private parsePulledImages(appUrn: AppUrn, text: string | null): PulledImages {
    if (!text) {
      return { imageIds: [], imageTags: [] };
    }

    try {
      const { imageIds, imageTags } = JSON.parse(text) as { imageIds?: unknown; imageTags?: unknown };
      const entries: unknown[] = Array.isArray(imageIds) ? imageIds : [];
      const ids = entries.filter((id): id is string => typeof id === 'string' && IMAGE_ID_PATTERN.test(id));
      if (ids.length !== entries.length) {
        this.logger.warn(`The record of the images pulled for ${appUrn} holds entries that are not image IDs; they are ignored`);
      }
      return { imageIds: ids, imageTags: Array.isArray(imageTags) ? imageTags.filter((tag): tag is string => typeof tag === 'string') : [] };
    } catch {
      this.logger.warn(`The record of the images pulled for ${appUrn} is not valid JSON; it records none`);
      return { imageIds: [], imageTags: [] };
    }
  }

  /** Replaces the app's record of the images its pulls brought in. Returns false when it could not be written. */
  public async writePulledImages(appUrn: AppUrn, { imageIds, imageTags }: PulledImages): Promise<boolean> {
    const content = JSON.stringify({ imageIds: [...new Set(imageIds)], imageTags: [...new Set(imageTags)] }, null, 2);
    return this.filesystem.writeTextFile(this.getPulledImagesPath(appUrn), content);
  }

  /**
   * Adds to the app's record what its own pull brought in or what another app's uninstall hands over. One at a time for
   * each record, since these run side by side and a second one reading it before the first writes would lose the first's.
   * Returns false when it could not be written. A record that exists and can't be read counts as that too: `readTextFile`
   * answers null for any failure. Writing then would lose what the record holds.
   */
  public async addPulledImages(appUrn: AppUrn, added: PulledImages): Promise<boolean> {
    const release = await this.pulledImagesMutex.acquire(appUrn);
    try {
      const recordPath = this.getPulledImagesPath(appUrn);
      const text = await this.filesystem.readTextFile(recordPath);
      if (text === null && (await this.filesystem.pathExists(recordPath))) {
        this.logger.warn(`Could not read the record of the images pulled for ${appUrn}, so it is left as it is`);
        return false;
      }

      const { imageIds, imageTags } = this.parsePulledImages(appUrn, text);
      return await this.writePulledImages(appUrn, { imageIds: [...imageIds, ...added.imageIds], imageTags: [...imageTags, ...added.imageTags] });
    } finally {
      release();
    }
  }

  /**
   * Forgets the app's record of the images it pulled. Called once an uninstall has removed what it could. Having no
   * record is normal, for an app whose images were all here before it or one installed before records were kept, so
   * only a record that exists is removed and only a failure to remove it is logged as one.
   */
  public async deletePulledImages(appUrn: AppUrn): Promise<void> {
    const recordPath = this.getPulledImagesPath(appUrn);
    if (await this.filesystem.pathExists(recordPath)) {
      await this.filesystem.removeFile(recordPath);
    }
  }

  /** Forgets every app's record. For a factory reset: a record left behind would claim images for the next Hub's apps. */
  public async deleteAllPulledImages(): Promise<void> {
    await this.filesystem.removeDirectory(this.getPulledImagesDir());
  }

  /** Returns whether the app's data dir was fully removed (false on a partial/failed delete). */
  public async deleteAppDataDir(appUrn: AppUrn): Promise<boolean> {
    const { appDataDir } = this.getAppPaths(appUrn);
    return this.filesystem.removeDirectory(appDataDir);
  }

  /**
   * Like {@link deleteAppDataDir} but reports whether a failure was a permission
   * error, so the uninstall path can escalate to a privileged (root) cleanup when
   * a container left root-owned files behind.
   */
  public async deleteAppDataDirDetailed(appUrn: AppUrn): Promise<{ removed: boolean; permissionDenied: boolean }> {
    const { appDataDir } = this.getAppPaths(appUrn);
    return this.filesystem.removeDirectoryDetailed(appDataDir);
  }

  /**
   * The HOST path of the app's data dir (`{base}/app-data/{store}/{app}`) — the path
   * Docker actually bind-mounts, and the one to show a user for a manual `rm`. Mirrors
   * the precedence compose generation uses (see app.helpers.ts / getAppDataHostPath).
   */
  public getAppDataHostDir(appUrn: AppUrn): string {
    const config = this.configuration.getConfig();
    return getAppDataHostPath(appUrn, {
      ciHubAppDataPath: process.env.CI_HUB_APP_DATA_PATH,
      appDataPath: config.userSettings.appDataPath,
      rootFolderHost: config.rootFolderHost,
    });
  }

  public async createAppDataDir(appUrn: AppUrn) {
    const { appDataDir } = this.getAppPaths(appUrn);
    await this.filesystem.createDirectory(appDataDir);
  }

  /**
   * Host paths of the app's volumes declared `private: true`, resolved to this
   * process's view of the app data dir. Only paths INSIDE the app data dir
   * count; anything else is ignored rather than trusted from the manifest.
   * A manifest that cannot be read or parsed yields none.
   */
  public async getPrivateVolumePaths(appUrn: AppUrn): Promise<string[]> {
    const { appDataDir } = this.getAppPaths(appUrn);
    const mounts = await this.getAppDataBindMounts(appUrn);
    const roots = new Set(mounts.filter((mount) => mount.private && mount.target !== appDataDir).map((mount) => mount.target));
    return [...roots].sort();
  }

  /**
   * The app's bind mounts that point into its data folder (or are that folder), resolved to this
   * process's view of it. Anything outside it is ignored rather than trusted from the manifest. A
   * manifest that cannot be read or parsed yields none.
   */
  private async getAppDataBindMounts(appUrn: AppUrn): Promise<Array<{ target: string; private: boolean }>> {
    const { appDataDir } = this.getAppPaths(appUrn);
    const { content } = await this.getDockerComposeJson(appUrn);
    if (!content) {
      return [];
    }
    let services: ReturnType<typeof parseInstalledComposeJson>['services'];
    try {
      ({ services } = parseInstalledComposeJson(content));
    } catch (error) {
      this.logger.debug(`Could not read the volumes of ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const mounts: Array<{ target: string; private: boolean }> = [];
    for (const service of services) {
      for (const volume of service.volumes ?? []) {
        // Named volumes carry no host path.
        if (typeof volume.hostPath !== 'string') {
          continue;
        }
        const target = path.resolve(volume.hostPath.replace(/\$\{APP_DATA_DIR\}/g, appDataDir));
        if (target === appDataDir || target.startsWith(`${appDataDir}${path.sep}`)) {
          mounts.push({ target, private: volume.private === true });
        }
      }
    }
    return mounts;
  }

  /**
   * Create the host folders the app's bind mounts point at, as the Hub, before its containers start.
   *
   * Docker creates a missing bind-mount source itself, as root:root 755. A Hub that runs as the host
   * user can then neither open it up for a container of another uid nor delete what the app writes
   * into it, so every later Reset, restore or backup needed the root helper. Install has always made
   * these folders first; Reset, a restore and an update rollback delete the data folder, so they make
   * them again the same way. A folder that exists is left as it is, and so is a file a mount names
   * (`data/nginx/nginx.conf`). A path outside the app's data folder is ignored, and a `private: true`
   * one starts at 700 (see {@link setAppDataDirPermissions}).
   */
  public async createVolumeHostDirs(appUrn: AppUrn): Promise<void> {
    const { appDataDir } = this.getAppPaths(appUrn);

    for (const mount of await this.getAppDataBindMounts(appUrn)) {
      // The containment check reads the path as written. A link on the way (a restored backup may hold
      // `data/secrets -> /data/state`) would have the mkdir and the chmod act wherever it points.
      const found = await this.inspectVolumeTarget(appDataDir, mount.target);
      if (found === 'file') {
        continue;
      }
      if (found === 'blocked') {
        this.logger.warn(`Not creating the folder of a volume of ${appUrn}: ${mount.target} runs through a symbolic link or a file`);
        continue;
      }
      await fs.promises.mkdir(mount.target, { recursive: true }).catch(() => {
        /* a path the app data mount refuses is Docker's to report at compose up */
      });
      // A `private: true` mount is the app's own root-written directory (Memory's secrets); it
      // starts, and stays, unreadable to other local accounts. The permissions sweep prunes it.
      if (mount.private && process.platform !== 'win32') {
        await fs.promises.chmod(mount.target, 0o700).catch(() => {
          /* a mount that rejects chmod is the drvfs case handled elsewhere */
        });
      }
    }
  }

  /**
   * What is on the way from `root` to `target`: `blocked` when a part of it that exists is a symbolic
   * link, or a file before the end; `file` when `target` itself is a regular file (a mount of one file,
   * nothing to create); `folders` when every part that exists is a folder.
   */
  private async inspectVolumeTarget(root: string, target: string): Promise<'blocked' | 'file' | 'folders'> {
    const segments = path.relative(root, target).split(path.sep).filter(Boolean);
    let current = root;

    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.promises.lstat(current).catch(() => null);

      if (!stat) {
        return 'folders';
      }

      if (stat.isFile() && index === segments.length - 1) {
        return 'file';
      }

      if (!stat.isDirectory()) {
        return 'blocked';
      }
    }

    return 'folders';
  }

  /**
   * Set the permissions for the app data directory.
   *
   * App containers run as whatever user their image picks, the Hub cannot know
   * the uid, and their bind-mounted data has to be writable by it — so the
   * data tree is made writable by everyone. That is the standing debt this
   * method carries (a real fix chowns each mount to its service's user, which
   * few manifests declare). What it must NOT do is extend that to things no
   * container reads from disk:
   *
   *  - `app.env`, which the Hub writes for compose and which carries the app's
   *    credentials (for Memory: the Hub's own device key, the forward-auth
   *    secret, database and object-store passwords). World-readable AND
   *    world-writable let any local account read them or inject environment.
   *  - volumes the manifest marks `private: true` — a directory only the app's
   *    own root-running service writes (Memory's secrets). Left at 0700 so no
   *    local account can read or replace what is under it. Bind mounts do not
   *    need traversal permission on the host's ancestors, so a non-root
   *    service can still mount and read a subdirectory the root service
   *    created.
   *
   * Nor may "writable by everyone" reach the other accounts on the computer.
   * The folder that holds the store's apps (`app-data/<store>`) is set to 0700,
   * so no other local account can reach any app's data, however open the sweep
   * leaves it below. That costs the containers nothing, for the reason above:
   * Docker resolves a bind mount's host path as root, and a container only sees
   * the folder that is mounted. That takes a Docker whose root is root on the
   * app-data file system: on an NFS export with root_squash it is not, and no
   * app in the store could mount its data, as Memory's private folder already
   * could not.
   *
   * See {@link buildPermissionsCommand} for the exact shell.
   *
   * Skipped when the app-data mount cannot carry POSIX permissions (a Windows
   * drive under WSL2), where every uid already has full access and walking a
   * large tree over 9p took minutes per prepare. The sweep's one effect there
   * was clearing the Windows read-only attribute, so a file a container makes
   * read-only now stays read-only, to root too. The probe asks about the
   * app-data root, the folder the compose builder already probes, so the
   * answer comes from its cache.
   */
  public async setAppDataDirPermissions(appUrn: AppUrn) {
    const { appDataDir } = this.getAppPaths(appUrn);

    if (process.platform === 'win32') {
      return;
    }

    const appDataRoot = this.configuration.getConfig().directories.appDataDir;
    if (!(await supportsPosixPermissions(appDataRoot))) {
      this.logger.debug(`Skipped the permission sweep for ${appUrn}: the app-data mount cannot carry POSIX permissions`);
      return;
    }

    const privateRoots = await this.getPrivateVolumePaths(appUrn);
    const appEnvPath = path.join(appDataDir, 'app.env');
    const hubUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const { stderr } = await execAsync(buildPermissionsCommand(appDataDir, [...privateRoots, appEnvPath], hubUid));
    if (stderr) {
      this.logger.error(`Error setting permissions for app ${appUrn}: ${stderr}`);
    }

    // Best effort, and only for what exists: a missing app.env is normal before
    // the first env generation, and a mount that rejects chmod (drvfs) is the
    // case `supportsPosixPermissions` already routes around.
    // The store folder is closed only when it sits directly under the app-data root, so a URN that
    // resolves elsewhere can never close the root or a folder above it.
    const storeDir = path.dirname(appDataDir);
    const closesStore = path.dirname(storeDir) === path.resolve(appDataRoot);
    const targets = [[appEnvPath, 0o600] as const, ...privateRoots.map((root) => [root, 0o700] as const)];
    if (closesStore) {
      targets.push([storeDir, 0o700] as const);
    }
    for (const [target, mode] of targets) {
      try {
        // chmod follows a link, and a container that mounts the whole data folder can put one where
        // app.env or a private folder was. The store folder is above every mount, so no container can.
        if (target !== storeDir && (await fs.promises.lstat(target)).isSymbolicLink()) {
          this.logger.warn(`Not setting mode ${mode.toString(8)} on ${target}: it is a symbolic link`);
          continue;
        }
        await fs.promises.chmod(target, mode);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        if (target === storeDir && !storeDirsLeftOpen.has(storeDir)) {
          storeDirsLeftOpen.add(storeDir);
          this.logger.warn(
            `Could not close ${storeDir} to other local accounts (${reason}). The data of every app in it stays reachable by them until the Hub's user owns the folder.`,
          );
        } else {
          this.logger.debug(`Could not set mode ${mode.toString(8)} on ${target}: ${reason}`);
        }
      }
    }
  }

  public async getAppEnv(appUrn: AppUrn) {
    const { appDataDir } = this.getAppPaths(appUrn);

    const envPath = path.join(appDataDir, 'app.env');

    let env = '';
    if (await this.filesystem.pathExists(envPath)) {
      env = (await this.filesystem.readTextFile(envPath)) ?? '';
    }

    return { path: envPath, content: env };
  }

  public async writeAppEnv(appUrn: AppUrn, env: string) {
    const { appDataDir } = this.getAppPaths(appUrn);

    const envPath = path.join(appDataDir, 'app.env');

    await this.filesystem.writeTextFile(envPath, env);
    // Credentials, read by the Hub and compose only — never by a container.
    // `setAppDataDirPermissions` keeps it out of the a+rwx sweep; this makes a
    // freshly written file private from the start rather than after the next
    // sweep.
    if (process.platform !== 'win32') {
      try {
        await fs.promises.chmod(envPath, 0o600);
      } catch (error) {
        this.logger.debug(`Could not set mode 600 on ${envPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Get the user env file content
   * @param appUrn - The app id
   */
  public async getUserEnv(appUrn: AppUrn) {
    const { directories } = this.configuration.getConfig();

    const { appStoreId, appName } = extractAppUrn(appUrn);

    const userEnvFile = path.join(directories.dataDir, 'user-config', appStoreId, appName, 'app.env');
    let content = null;

    if (await this.filesystem.pathExists(userEnvFile)) {
      content = await this.filesystem.readTextFile(userEnvFile);
    }

    return { path: userEnvFile, content };
  }

  /**
   * Get the user compose file content
   * @param appUrn - The app id
   */
  public async getUserComposeFile(appUrn: AppUrn) {
    const { directories } = this.configuration.getConfig();

    const { appStoreId, appName } = extractAppUrn(appUrn);

    const userComposeFile = path.join(directories.dataDir, 'user-config', appStoreId, appName, 'docker-compose.yml');
    let content = null;

    if (await this.filesystem.pathExists(userComposeFile)) {
      content = await this.filesystem.readTextFile(userComposeFile);
    }

    return { path: userComposeFile, content };
  }

  /**
   * Get the config.json file content from the installed app
   * @param appUrn - The app id
   * @returns The content of config.json as a string, or null if not found
   */
  public async getConfigJson(appUrn: AppUrn) {
    const { appInstalledDir } = this.getAppPaths(appUrn);
    const configPath = path.join(appInstalledDir, 'config.json');

    let content = null;
    try {
      if (await this.filesystem.pathExists(configPath)) {
        content = await this.filesystem.readJsonFile(configPath);
      }
    } catch (error) {
      this.logger.error(`Error getting config.json for installed app ${appUrn}:`, error);
    }

    return { path: configPath, content };
  }

  /**
   * Read-only inventory of an app's data directory for the web UI (no native
   * file manager). Depth/entry caps keep the response bounded when an app has
   * written a large tree.
   */
  public async listAppDataListing(appUrn: AppUrn): Promise<{
    entries: Array<{ name: string; path: string; kind: 'file' | 'directory'; sizeBytes: number | null }>;
    truncated: boolean;
    rootExists: boolean;
  }> {
    const maxEntries = 500;
    const maxDepth = 8;
    const { appDataDir } = this.getAppPaths(appUrn);

    if (!(await this.filesystem.pathExists(appDataDir))) {
      return { entries: [], truncated: false, rootExists: false };
    }

    const entries: Array<{ name: string; path: string; kind: 'file' | 'directory'; sizeBytes: number | null }> = [];
    let truncated = false;

    const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) {
        if (depth > maxDepth) truncated = true;
        return;
      }

      let names: string[];
      try {
        names = await this.filesystem.listFiles(dir);
      } catch (error) {
        this.logger.debug(`Could not list app data dir ${dir}:`, error);
        return;
      }

      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }

        const full = path.join(dir, name);
        const rel = relative ? `${relative}/${name}` : name;
        try {
          /*
           * ⚠ `lstat`, NOT `stat`, AND A SYMLINK IS NOT FOLLOWED.
           *
           * `stat` reports the TARGET's kind, so a link planted in the app's own
           * data directory — which the app itself can write — looked like an
           * ordinary directory and this walk recursed through it. `ln -s /
           * /app-data/<store>/<app>/x` turned a read-only inventory of one app's
           * files into a listing of the whole host, eight levels deep, through
           * `GET /api/apps/:urn/data-files`.
           *
           * The path fence does not help: it is applied to the path handed in,
           * which is inside the app's directory, and the escape happens in the
           * kernel afterwards.
           *
           * Links are reported rather than hidden — an operator looking at this
           * dialog should see what is actually in the folder — but never
           * descended, and never sized from their target.
           */
          const stats = await this.filesystem.getLinkStats(full);

          if (stats.isSymbolicLink()) {
            entries.push({ name, path: rel, kind: 'file', sizeBytes: null });
            continue;
          }

          if (stats.isDirectory()) {
            entries.push({ name, path: rel, kind: 'directory', sizeBytes: null });
            await walk(full, rel, depth + 1);
          } else if (stats.isFile()) {
            entries.push({ name, path: rel, kind: 'file', sizeBytes: stats.size });
          }
        } catch (error) {
          this.logger.debug(`Skipping unreadable app data path ${full}:`, error);
        }
      }
    };

    await walk(appDataDir, '', 0);
    return { entries, truncated, rootExists: true };
  }
}
