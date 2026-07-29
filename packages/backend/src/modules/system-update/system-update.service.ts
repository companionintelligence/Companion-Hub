import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Injectable, OnApplicationBootstrap, type OnApplicationShutdown, Optional } from '@nestjs/common';
import { DATA_DIR, HUB_STACK_IMAGE_REPO, HUB_STACK_REGISTRY_REPO, UPDATE_LISTENER_TOKEN_FILENAME } from '@/common/constants';
import { writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistryService } from '@/utils/registry/registry.service';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';

/** Prefer the live mounted compose file inside the running Hub container. */
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.prod.yml'] as const;

@Injectable()
export class SystemUpdateService implements OnApplicationBootstrap, OnApplicationShutdown {
  autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registryService: RegistryService,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  onApplicationBootstrap() {
    const { __prod__ } = this.config.getConfig();
    if (__prod__) {
      this.logger.info('Scheduling daily auto-update check');
      this.autoUpdateInterval = setInterval(() => this.autoUpdateCheck(), SystemUpdateService.CHECK_INTERVAL_MS);
    }
  }

  onApplicationShutdown() {
    if (this.autoUpdateInterval) {
      clearInterval(this.autoUpdateInterval);
      this.autoUpdateInterval = null;
    }
  }

  async checkForUpdates() {
    const { version: currentVersion } = this.config.getConfig();
    const releasesSince = await this.registryService.getTagsSinceWithHubFallback(HUB_STACK_REGISTRY_REPO, currentVersion);

    const releases = releasesSince.map((tag) => ({
      version: tag,
      body: `Release ${tag}`,
    }));

    const latest = releases[0]?.version ?? currentVersion;
    const updateAvailable = currentVersion !== latest && releases.length > 0;

    if (updateAvailable) {
      this.agentNotifyService?.notify('system.update_available', { current: currentVersion, latest }, 'low');
    }

    return {
      current: currentVersion,
      latest,
      releases,
      updateAvailable,
    };
  }

  private resolveComposeFile(dataDir: string): string {
    for (const name of COMPOSE_FILENAMES) {
      const candidate = path.join(dataDir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return path.join(dataDir, COMPOSE_FILENAMES[0]);
  }

  private upsertEnvLine(lines: string[], key: string, value: string): string[] {
    const line = `${key}=${value}`;
    let replaced = false;
    const next = lines.map((entry) => {
      if (entry.startsWith(`${key}=`)) {
        replaced = true;
        return line;
      }
      return entry;
    });
    if (!replaced) {
      next.push(line);
    }
    return next;
  }

  /** Pin the stack image + reported Hub version so UI and compose agree after restart. */
  private pinHubStackVersionInEnv(envFile: string, targetVersion?: string): string | undefined {
    if (!targetVersion || !fs.existsSync(envFile)) {
      return undefined;
    }

    const imageLine = `${HUB_STACK_IMAGE_REPO}:${targetVersion}`;
    const content = fs.readFileSync(envFile, 'utf8');
    let lines = content.split('\n');
    lines = this.upsertEnvLine(lines, 'CI_HUB_IMAGE', imageLine);
    lines = this.upsertEnvLine(lines, 'CI_HUB_VERSION', targetVersion);
    fs.writeFileSync(envFile, lines.join('\n'));
    this.logger.info(`Pinned stack update in ${envFile}: CI_HUB_IMAGE=${imageLine}, CI_HUB_VERSION=${targetVersion}`);
    return targetVersion;
  }

  private stackUpdateLogPath(dataDir: string): string {
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    return path.join(logsDir, 'hub-stack-update.log');
  }

  async performUpdate(targetVersion?: string) {
    const pinned = targetVersion ?? (await this.checkForUpdates()).latest;
    this.logger.info(`Hub stack update initiated${pinned ? ` to ${pinned}` : ''}`);

    const { dataDir } = this.config.get('directories');
    const envFile = path.join(dataDir, '.env');
    const composeFile = this.resolveComposeFile(dataDir);

    this.pinHubStackVersionInEnv(envFile, pinned);

    const composeBase = ['docker', 'compose', '--env-file', envFile, '--project-name', 'ci-hub', '-f', composeFile] as const;

    try {
      await this.runComposeCommand([...composeBase, 'pull', 'ci-os-hub']);
      this.logger.info(`Successfully pulled ci-os-hub:${pinned ?? 'latest'}`);
    } catch (error) {
      this.logger.error('Failed to pull new Hub image', error);
      throw error;
    }

    const updateLogPath = this.stackUpdateLogPath(dataDir);
    const logBanner = `\n[${new Date().toISOString()}] Hub stack update restart (target=${pinned ?? 'latest'})\n`;
    fs.appendFileSync(updateLogPath, logBanner);

    setTimeout(() => {
      this.logger.info(`Restarting Hub stack with new images (logging to ${updateLogPath})...`);
      const logFd = fs.openSync(updateLogPath, 'a');
      // composeBase already begins with the `docker` binary — don't prepend it
      // again, or docker sees `docker docker compose …` and rejects `--env-file`
      // (which silently killed every stack update since 0.2.44).
      const [dockerBin, ...composeArgs] = composeBase;
      const cmd = spawn(dockerBin, [...composeArgs, 'up', '-d', '--pull', 'always', '--force-recreate', '--no-deps', 'ci-os-hub'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      cmd.on('spawn', () => {
        try {
          fs.closeSync(logFd);
        } catch {
          // Parent may exit before close; child already inherited the fd.
        }
      });
      cmd.unref();
    }, 3000);

    return { success: true, message: 'Update initiated, hub will restart shortly' };
  }

  private async runComposeCommand(command: string[]): Promise<void> {
    const [bin, ...args] = command;
    if (!bin) {
      throw new Error('Empty command');
    }
    return new Promise((resolve, reject) => {
      const cmd = spawn(bin, args, { stdio: 'pipe' });
      const stderr: string[] = [];
      cmd.stderr.on('data', (data: Buffer) => {
        this.logger.debug(`compose: ${String(data).trim()}`);
        stderr.push(String(data).trim());
      });
      cmd.stdout.on('data', (data: Buffer) => {
        this.logger.debug(`compose: ${String(data).trim()}`);
      });
      cmd.on('error', reject);
      cmd.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker compose exited with code ${code}: ${stderr.join('\n')}`));
        }
      });
    });
  }

  getAutoUpdatesEnabled(): boolean {
    try {
      const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return settings.autoUpdates !== false; // default true
      }
    } catch {
      // ignore
    }
    return true;
  }

  async setAutoUpdatesEnabled(enabled: boolean): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
    } catch {
      // ignore
    }
    settings.autoUpdates = enabled;
    await writeSettingsJsonFile(settingsPath, JSON.stringify(settings, null, 2));
  }

  private async autoUpdateCheck() {
    this.logger.info('Running scheduled auto-update check...');
    try {
      const { updateAvailable, latest, current } = await this.checkForUpdates();
      this.logger.info(`Auto-update check: current=${current}, latest=${latest}, updateAvailable=${updateAvailable}`);

      if (updateAvailable && this.getAutoUpdatesEnabled()) {
        this.logger.info(`Auto-updating hub from ${current} to ${latest}`);
        await this.performUpdate(latest);
      }
    } catch (error) {
      this.logger.error('Auto-update check failed', error);
    }
  }

  /** Token for the desktop host update listener on 127.0.0.1:17400 (browser cannot reach it without auth). */
  getHostUpdateListenerToken(): string | null {
    const tokenPath = path.join(DATA_DIR, UPDATE_LISTENER_TOKEN_FILENAME);
    if (!fs.existsSync(tokenPath)) {
      return null;
    }
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }
}
