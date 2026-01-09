import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import AdmZip from 'adm-zip';
import { RegistrationService } from '../registration/registration.service';

@Injectable()
export class ReposHelpers {
  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly registrationService: RegistrationService,
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

      if (type === 'http_zip') {
        return this.downloadZipRepo(url, repoPath);
      }

      const [repoUrl, branch] = this.getRepoBaseUrlAndBranch(url);

      if (!repoUrl) {
        this.logger.error(`Invalid repo URL: ${url}`);
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

  private async downloadZipRepo(url: string, repoPath: string) {
    try {
      await this.ensureDirectoryWithPermissions(path.dirname(repoPath));

      const uuid = await this.registrationService.getDeviceId();
      this.logger.debug(`Downloading zip repo from ${url} to ${repoPath} with \`UUID: ${uuid}\` (Env: ${process.env.NODE_ENV})`);
      console.log(`Downloading zip repo from ${url} to ${repoPath} with \`UUID: ${uuid}\` (Env: ${process.env.NODE_ENV})`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_id: uuid }),
      });

      if (response.url && response.url !== url) {
        this.logger.warn(`Request redirected from ${url} to ${response.url}. Headers may have been lost.`);
      }

      this.logger.debug(`Response status: ${response.status}, Content-Type: ${response.headers.get('content-type')}`);

      if (!response.ok) {
        this.logger.error(`Failed to download repo: ${response.statusText} ${response.status}`);
        return { success: false, message: `Failed to download repo: ${response.statusText} ${response.status}` };
      }

      const buffer = await response.arrayBuffer();
      const zip = new AdmZip(Buffer.from(buffer));

      // Create directory if it doesn't exist
      if (!fs.existsSync(repoPath)) {
        fs.mkdirSync(repoPath, { recursive: true });
      }

      zip.extractAllTo(repoPath, true);

      // Handle GitHub-style zip (single root directory)
      const entries = fs.readdirSync(repoPath);
      if (entries.length === 1) {
        const rootItemPath = path.join(repoPath, entries[0]);
        if (fs.statSync(rootItemPath).isDirectory()) {
             // It's a directory, move content up
             this.logger.debug(`Detected single root folder in ZIP: ${entries[0]}. Flattening...`);
             const children = fs.readdirSync(rootItemPath);
             for (const child of children) {
                 fs.renameSync(path.join(rootItemPath, child), path.join(repoPath, child));
             }
             fs.rmdirSync(rootItemPath);
        }
      }

      this.logger.info(`Downloaded and extracted zip repo from ${url}`);
      return { success: true, message: '' };
    } catch (err) {
      this.logger.error(`Error downloading zip repo from ${url}:`, err);
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
      if (type === 'http_zip') {
        // For zip repos, we just re-download and overwrite
        const { dataDir } = this.configuration.get('directories');
        const repoPath = path.join(dataDir, 'repos', slug);

        // Clean existing directory first to ensure clean state
        if (await this.filesystem.pathExists(repoPath)) {
          await this.filesystem.removeDirectory(repoPath);
        }

        return this.downloadZipRepo(repoUrl, repoPath);
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
