import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Injectable, OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DATA_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RegistryService } from '@/utils/registry/registry.service';

@Injectable()
export class SystemUpdateService implements OnApplicationBootstrap, OnApplicationShutdown {
  autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registryService: RegistryService,
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
    const releasesSince = await this.registryService.getTagsSince('ci-os-hub', currentVersion);

    const releases = releasesSince.map((tag) => ({
      version: tag,
      body: `Release ${tag}`,
    }));

    const latest = releases[0]?.version ?? currentVersion;
    const updateAvailable = currentVersion !== latest && releases.length > 0;

    return {
      current: currentVersion,
      latest,
      releases,
      updateAvailable,
    };
  }

  async performUpdate(targetVersion?: string) {
    this.logger.info(`Hub self-update initiated${targetVersion ? ` to ${targetVersion}` : ''}`);

    const { dataDir } = this.config.get('directories');
    const envFile = path.join(dataDir, '.env');
    const composeFile = path.join(dataDir, 'docker-compose.yml');

    // Pull the new image
    try {
      await this.runComposeCommand(['docker', 'compose', '--env-file', envFile, '--project-name', 'ci-hub', '-f', composeFile, 'pull', 'ci-os-hub']);
      this.logger.info('Successfully pulled new ci-os-hub image');
    } catch (error) {
      this.logger.error('Failed to pull new image', error);
      throw error;
    }

    // Schedule the restart after a delay so the HTTP response is sent first
    setTimeout(() => {
      this.logger.info('Restarting ci-os-hub container with new image...');
      const cmd = spawn('docker', ['compose', '--env-file', envFile, '--project-name', 'ci-hub', '-f', composeFile, 'up', '-d', 'ci-os-hub'], {
        stdio: 'ignore',
        detached: true,
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
    await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  }

  private async autoUpdateCheck() {
    this.logger.info('Running scheduled auto-update check...');
    try {
      const { updateAvailable, latest, current } = await this.checkForUpdates();
      this.logger.info(`Auto-update check: current=${current}, latest=${latest}, updateAvailable=${updateAvailable}`);

      if (updateAvailable && this.getAutoUpdatesEnabled()) {
        this.logger.info(`Auto-updating hub from ${current} to ${latest}`);
        await this.performUpdate();
      }
    } catch (error) {
      this.logger.error('Auto-update check failed', error);
    }
  }
}
