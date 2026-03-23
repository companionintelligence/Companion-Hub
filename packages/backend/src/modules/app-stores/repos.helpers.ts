import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, Inject, forwardRef } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { RegistrationService } from '../registration/registration.service';

@Injectable()
export class ReposHelpers {
  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
    @Inject(forwardRef(() => RegistrationService)) private readonly registrationService: RegistrationService,
  ) {}

  /**
   * Given a repo url, return a hash of it to be used as a folder name
   *
   * @param {string} repoUrl
   */
  public getRepoHash(repoUrl: string) {
    const hash = crypto.createHash('sha256');
    hash.update(repoUrl);
    return hash.digest('hex');
  }

  /**
   * Extracts the base URL and branch from a repository URL.
   * @param repoUrl The repository URL.
   * @returns An array containing the base URL and branch, or just the base URL if no branch is found.
   */
  private getRepoBaseUrlAndBranch(repoUrl: string) {
    const treeIndex = repoUrl.indexOf('/tree/');

    if (treeIndex !== -1) {
      const baseUrl = repoUrl.substring(0, treeIndex);
      const branch = repoUrl.substring(treeIndex + '/tree/'.length);
      return [baseUrl, branch];
    }

    return [repoUrl, undefined];
  }

  /**
   * Error handler for repo operations
   * @param {unknown} err
   */
  private handleRepoError(err: unknown) {
    Sentry.captureException(err);

    if (err instanceof Error) {
      this.logger.error(err);
      return { success: false, message: err.message };
    }

    return { success: false, message: `An error occurred: ${String(err)}` };
  }

  /**
   * Ensure directory exists and has correct permissions
   * @param {string} dirPath
   */
  private async ensureDirectoryWithPermissions(dirPath: string): Promise<void> {
    if (!(await this.filesystem.pathExists(dirPath))) {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }

    await fs.promises.chmod(dirPath, 0o755);
    execFileSync('git', ['config', '--global', '--add', 'safe.directory', dirPath], {
      stdio: 'ignore',
    });
  }

  /**
   * Given a repo url, clone it to the repos folder if it doesn't exist
   *
   * @param {string} url
   */
  public async cloneRepo(url: string, id: string, type = 'git') {
    try {
      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', id);

      if (await this.filesystem.pathExists(repoPath)) {
        await this.ensureDirectoryWithPermissions(path.dirname(repoPath));
        this.logger.debug(`Repo ${url} already exists`);
        return { success: true, message: '' };
      }

      if (type === 'ci_cloud_api') {
        return this.fetchCiCloudRepo(url, id, repoPath);
      }

      // Validate URL before attempting to clone
      // Skip invalid URLs (like "migrated" from old migrations) gracefully
      if (!url || url.trim() === '' || (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git@'))) {
        this.logger.warn(`Skipping invalid repo URL for ${id}: ${url || '(empty)'}`);
        return { success: false, message: `Invalid repo URL: ${url || '(empty)'}` };
      }

      const [repoUrl, branch] = this.getRepoBaseUrlAndBranch(url);

      if (!repoUrl) {
        this.logger.warn(`Invalid repo URL format for ${id}: ${url}`);
        return { success: false, message: `Invalid repo URL: ${url}` };
      }

      this.logger.debug(`Cloning repo ${repoUrl}${branch ? ` on branch ${branch}` : ''} to ${repoPath}`);

      await this.ensureDirectoryWithPermissions(path.dirname(repoPath));
      await git.clone({
        fs,
        http,
        dir: repoPath,
        url: repoUrl,
        singleBranch: true,
        depth: 1,
        ref: branch || undefined,
      });

      this.logger.info(`Cloned repo ${repoUrl} to ${repoPath}`);
      return { success: true, message: '' };
    } catch (err) {
      return this.handleRepoError(err);
    }
  }

  private async fetchCiCloudRepo(url: string, _id: string, repoPath: string) {
    try {
      this.logger.debug(`Fetching CI Cloud Repo from ${url} to ${repoPath}`);

      if (!(await this.filesystem.pathExists(repoPath))) {
        await this.ensureDirectoryWithPermissions(repoPath);
      }

      const appsPath = path.join(repoPath, 'apps');
      await this.ensureDirectoryWithPermissions(appsPath);

      // Fetch metadata list
      const storeUrl = `${url}/store`;
      this.logger.debug(`Fetching store metadata from ${storeUrl}`);
      const response = await fetch(storeUrl); // Assuming url is base API url
      if (!response.ok) {
        throw new Error(`Failed to fetch store metadata from ${storeUrl}: ${response.status} ${response.statusText}`);
      }

      const apps = (await response.json()) as Array<{ id: string; slug?: string; [key: string]: unknown }>;

      for (const app of apps) {
        const appSlug = app.slug || app.id;
        const appDir = path.join(appsPath, appSlug);
        await this.ensureDirectoryWithPermissions(appDir);

        // Enrich app metadata with default required fields if missing
        const enrichedApp = {
          ...app,
          urn: `urn:app:${appSlug}`,
          name: typeof app.name === 'string' ? app.name : typeof app.title === 'string' ? app.title : appSlug,
          author: typeof app.author === 'string' ? app.author : 'Unknown Author',
          available: typeof app.available === 'boolean' ? app.available : true,
          short_desc:
            typeof app.short_desc === 'string'
              ? app.short_desc
              : (typeof app.shortDescription === 'string' ? app.shortDescription : null) || (app.description as string) || 'No description provided',
          title: typeof app.title === 'string' ? app.title : (app.name as string) || appSlug,
          description: typeof app.description === 'string' ? app.description : 'No full description.',
          categories: Array.isArray(app.categories) ? app.categories : ['utilities'],
          port: typeof app.port === 'number' ? app.port : 8080,
          version: typeof app.version === 'string' ? app.version : '0.0.1',
          tipi_version: typeof app.tipi_version === 'number' ? app.tipi_version : 1,
          source: typeof app.source === 'string' ? app.source : 'https://github.com/example/repo',
          supported_architectures: Array.isArray(app.supported_architectures) ? app.supported_architectures : ['amd64', 'arm64'],
        };

        await fs.promises.writeFile(path.join(appDir, 'config.json'), JSON.stringify(enrichedApp, null, 2));

        // Write docker-compose.json if available
        if (typeof app.compose === 'string') {
          await fs.promises.writeFile(path.join(appDir, 'docker-compose.json'), app.compose);
        }

        // Download app icon so getAppImage can serve it from metadata/logo.*
        const iconUrl = typeof app.icon === 'string' ? app.icon : null;
        if (iconUrl) {
          try {
            const fullIconUrl = iconUrl.startsWith('http') ? iconUrl : `${url}${iconUrl}`;
            const iconRes = await fetch(fullIconUrl);
            if (iconRes.ok) {
              const contentType = iconRes.headers.get('content-type') || 'image/png';
              const extMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
              const ext = extMap[contentType.split(';')[0]?.trim() ?? ''] ?? 'png';
              const metadataDir = path.join(appDir, 'metadata');
              await this.ensureDirectoryWithPermissions(metadataDir);
              const buffer = Buffer.from(await iconRes.arrayBuffer());
              await fs.promises.writeFile(path.join(metadataDir, `logo.${ext}`), buffer);
            }
          } catch {
            // Non-fatal: logo will fall back to generic thumbnail
          }
        }
      }

      // Also write a repo.json or config.json so Tipi sees it as a valid repo?
      // Tipi (CI-OS-Hub) expects `repo.json` in root of repo?
      // Existing `downloadZipRepo` unzips a file.
      // Let's check `downloadZipRepo` implementation to see what files are expected.

      return { success: true, message: 'CI Cloud Repo updated' };
    } catch (err) {
      return this.handleRepoError(err);
    }
  }

  public async downloadAppFiles(repoUrl: string, repoSlug: string, appSlug: string) {
    try {
      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', repoSlug);
      const appPath = path.join(repoPath, 'apps', appSlug);

      this.logger.debug(`Downloading app files for ${appSlug} from ${repoUrl}`);

      // Fetch full install data
      const deviceId = await this.registrationService.getDeviceId();
      const response = await fetch(`${repoUrl}/store/${appSlug}/install`, {
        headers: {
          'x-device-id': deviceId,
        },
      });
      if (!response.ok) {
        if (response.status === 402) {
          return { success: false, message: 'Payment Required' };
        }
        throw new Error(`Failed to fetch app files: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        files?: Record<string, string>;
      };

      await this.ensureDirectoryWithPermissions(appPath);

      const files = data.files || {};

      if (Object.keys(files).length > 0) {
        for (const [filename, content] of Object.entries(files)) {
          await fs.promises.writeFile(path.join(appPath, filename), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
        }
      } else {
        this.logger.warn(`No app files found in response for ${appSlug}`);
      }

      return { success: true, message: 'App files downloaded' };
    } catch (err) {
      return this.handleRepoError(err);
    }
  }

  /**
   * Given a repo url, pull it to the repos folder if it exists
   *
   * @param {string} repoUrl
   */
  public async pullRepo(repoUrl: string, slug: string, type = 'git') {
    try {
      if (type === 'ci_cloud_api') {
        const { dataDir } = this.configuration.get('directories');
        const repoPath = path.join(dataDir, 'repos', slug);
        return this.fetchCiCloudRepo(repoUrl, slug, repoPath);
      }

      await this.cloneRepo(repoUrl, slug, type);

      const [remoteUrl] = this.getRepoBaseUrlAndBranch(repoUrl);

      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', slug);

      if (!(await this.filesystem.pathExists(repoPath))) {
        this.logger.info(`Repo ${repoUrl} does not exist`);
        return { success: false, message: `Repo ${repoUrl} does not exist` };
      }

      this.logger.debug(`Pulling repo ${repoUrl} to ${repoPath}`);

      const currentBranch = await git.currentBranch({
        fs,
        dir: repoPath,
        fullname: false,
      });
      if (!currentBranch) {
        this.logger.warn(`No current branch found for repo ${repoUrl}. Deleting and re-cloning.`);
        await this.deleteRepo(slug);
        return this.cloneRepo(repoUrl, slug);
      }
      const remoteBranchRef = `origin/${currentBranch}`;

      const fetchResult = await git.fetch({
        fs,
        http,
        dir: repoPath,
        url: remoteUrl,
        ref: currentBranch,
        depth: 1,
        singleBranch: true,
        tags: false,
      });
      this.logger.debug('Fetch result:', fetchResult, 'Current branch:', currentBranch);
      const targetSha = await git.resolveRef({
        fs,
        dir: repoPath,
        ref: remoteBranchRef,
      });
      this.logger.debug('Target SHA:', targetSha);
      await git.branch({
        fs,
        dir: repoPath,
        ref: currentBranch,
        object: targetSha,
        force: true,
      });
      await git.checkout({
        fs,
        dir: repoPath,
        ref: currentBranch,
        force: true,
      });

      this.logger.debug(`Pulled repo ${repoUrl} to ${repoPath}`);
      return { success: true, message: '' };
    } catch (_) {
      if (this.configuration.get('__prod__')) {
        await this.deleteRepo(slug);
      }
      return this.cloneRepo(repoUrl, slug);
    }
  }

  /**
   * Given a repo id, delete it from the repos folder
   */
  public async deleteRepo(id: string) {
    try {
      const { dataDir } = this.configuration.get('directories');
      const repoPath = path.join(dataDir, 'repos', id);

      if (!(await this.filesystem.pathExists(repoPath))) {
        this.logger.info(`Repo ${id} does not exist`);
        return { success: false, message: `Repo ${id} does not exist` };
      }

      this.logger.info(`Deleting repo ${id} from ${repoPath}`);
      await this.filesystem.removeDirectory(repoPath);

      this.logger.info(`Deleted repo ${id} from ${repoPath}`);
      return { success: true, message: '' };
    } catch (err) {
      return this.handleRepoError(err);
    }
  }

  public async deleteAllRepos() {
    const { dataDir } = this.configuration.get('directories');
    const repos = await this.filesystem.listFiles(path.join(dataDir, 'repos'));

    for (const repo of repos) {
      await this.deleteRepo(repo);
    }

    return { success: true, message: '' };
  }
}
