import path from 'node:path';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { execAsync } from '@/common/helpers/exec-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { appInfoSchema } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

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
        const parsedConfig = appInfoSchema.safeParse({ ...config, urn: appUrn });

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
   * Set the permissions for the app data directory
   * @param appUrn - The app id
   */
  public async setAppDataDirPermissions(appUrn: AppUrn) {
    const { appDataDir } = this.getAppPaths(appUrn);

    if (process.platform !== 'win32') {
      const escapedPath = appDataDir.replace(/'/g, "'\\''");
      const { stderr } = await execAsync(`chmod -Rf a+rwx '${escapedPath}'`);
      if (stderr) {
        this.logger.error(`Error setting permissions for app ${appUrn}: ${stderr}`);
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
