import fs from 'node:fs';
import path from 'node:path';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { supportsPosixPermissions } from '@/common/helpers/bind-mount-helpers';
import { execAsync } from '@/common/helpers/exec-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { parseInstalledAppInfo, parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

/** What was last logged as left out of each app's installed manifest. */
const loggedLeftOut = new Map<string, string>();

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

    if (!(await supportsPosixPermissions(this.configuration.getConfig().directories.appDataDir))) {
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
    for (const [target, mode] of [[appEnvPath, 0o600] as const, ...privateRoots.map((root) => [root, 0o700] as const)]) {
      try {
        await fs.promises.chmod(target, mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.debug(`Could not set mode ${mode.toString(8)} on ${target}: ${error instanceof Error ? error.message : String(error)}`);
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
