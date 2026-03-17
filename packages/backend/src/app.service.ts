import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { APP_DATA_DIR, DATA_DIR } from './common/constants';
import { CacheService, ONE_DAY_IN_SECONDS } from './core/cache/cache.service';
import { ConfigurationService } from './core/config/configuration.service';
import { DatabaseService } from './core/database/database.service';
import { FilesystemService } from './core/filesystem/filesystem.service';
import { LoggerService } from './core/logger/logger.service';
import { AppLifecycleService } from './modules/app-lifecycle/app-lifecycle.service';
import { AppStoreService } from './modules/app-stores/app-store.service';
import { MarketplaceService } from './modules/marketplace/marketplace.service';
import { RepoEventsQueue } from './modules/queue/entities/repo-events';
import { SystemEventsQueue } from './modules/queue/entities/system-events';
import { DOCKERODE } from './modules/docker/docker.module';
import Dockerode from 'dockerode';
import { RegistryService } from './utils/registry/registry.service';
import { PortManagerService } from './modules/network/port-manager.service';
import { AppsRepository } from './modules/apps/apps.repository';

@Injectable()
export class AppService implements OnApplicationShutdown {
  constructor(
    private readonly cache: CacheService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly repoQueue: RepoEventsQueue,
    private readonly systemEventsQueue: SystemEventsQueue,
    private readonly filesystem: FilesystemService,
    private readonly appStoreService: AppStoreService,
    private readonly marketplaceService: MarketplaceService,
    private readonly databaseService: DatabaseService,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly registryService: RegistryService,
    private readonly portManager: PortManagerService,
    private readonly appsRepository: AppsRepository,
    @Inject(DOCKERODE) private docker: Dockerode,
  ) {}

  onApplicationShutdown() {
    this.logger.stopPeriodicFlush();
  }

  public async bootstrap() {
    try {
      this.logger.info('Starting bootstrap...');
      await this.databaseService.migrate();
      this.logger.info('Database migration completed');

      // Validate data directory integrity
      await this.validateDataDirectories();

      await this.docker.pruneNetworks();
      this.logger.info('Docker networks pruned');

      const { version, userSettings, __prod__ } = this.configuration.getConfig();
      const config = this.configuration.getConfig();
      this.logger.info('Log level', config.userSettings.logLevel);
      this.logger.debug('Starting with configuration', config);

      this.configuration.initSentry({ release: version, allowSentry: userSettings.allowErrorMonitoring });
      this.logger.info('Sentry initialized');

      await this.logger.flush();
      this.logger.startPeriodicFlush();
      this.logger.info('Logger flushed, daily rotation scheduled');

      this.logger.info(`Running version: ${process.env.CI_HUB_VERSION || process.env.TIPI_VERSION}`);

      const buster = this.cache.get('buster');
      if (buster !== version) {
        this.logger.info('Clearing cache...');
        this.cache.clear();
        this.cache.set('buster', version, ONE_DAY_IN_SECONDS * 365);
        this.logger.info('Cache cleared');
      }

      await this.appStoreService.registerCloudAppStore();

      this.logger.info('Publishing clone_all command...');
      this.repoQueue.publish({ command: 'clone_all' });
      this.logger.info('Clone command published');

      this.logger.info('Initializing marketplace...');
      await this.marketplaceService.initialize();
      this.logger.info('Marketplace initialized');

      // Every 15 minutes, check for updates to the apps repo
      if (__prod__) {
        this.logger.info('Setting up repeatable repo update job...');
        this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
        this.logger.info('Repo update job scheduled');
      }
      this.logger.info('Setting up repeatable app status sync job...');
      this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');
      this.logger.info('App status sync job scheduled');

      this.logger.info('Copying assets...');
      await this.copyAssets();
      this.logger.info('Assets copied');

      // Backfill port allocations for apps installed before the port manager
      await this.migrateExistingPortAllocations();

      if (__prod__ && (buster !== version || version === 'nightly')) {
        this.logger.info('Restarting running apps...');
        await this.appLifecycleService.restartRunningApps();
        this.logger.info('Finished restarting running apps');
      }

      this.logger.info('Bootstrap completed successfully');
    } catch (e) {
      this.logger.error('Bootstrap error:', e);
      Sentry.captureException(e, { tags: { source: 'bootstrap' } });
      throw e; // Re-throw to ensure startup fails if bootstrap fails
    }
  }

  public async getVersion() {
    const { version: currentVersion } = this.configuration.getConfig();

    const [releasesSince] = await Promise.all([this.registryService.getTagsSince('ci-os-hub', currentVersion)]);

    const releases = releasesSince.map((tag) => ({
      version: tag,
      body: `Release ${tag}`,
    }));

    const latest = releases[0]?.version ?? currentVersion;

    return {
      current: currentVersion,
      latest,
      body: '',
      releases,
    };
  }

  public async copyAssets() {
    const { directories } = this.configuration.getConfig();
    const { dataDir, appDataDir } = directories;

    // Create base folders
    this.logger.info('Creating base folders');
    await this.filesystem.createDirectories([
      path.join(dataDir, 'apps'),
      path.join(dataDir, 'state'),
      path.join(dataDir, 'repos'),
      path.join(dataDir, 'backups'),
      path.join(appDataDir),
      path.join(dataDir, 'state', 'traefik', 'config'),
      path.join(dataDir, 'state', 'traefik', 'dynamic'),
      path.join(dataDir, 'state', 'traefik', 'tls'),
    ]);

    // Copy Traefik config files from assets to shared location
    try {
      this.logger.info('Copying Traefik config files...');
      const assetsTraefikDir = path.join(process.cwd(), 'assets', 'traefik');
      const traefikConfigDest = path.join(dataDir, 'state', 'traefik', 'config');

      // Ensure config directory exists
      await this.filesystem.createDirectory(traefikConfigDest);

      // Copy traefik.yml
      const traefikYmlSrc = path.join(assetsTraefikDir, 'traefik.yml');
      const traefikYmlDest = path.join(traefikConfigDest, 'traefik.yml');
      if (await this.filesystem.pathExists(traefikYmlSrc)) {
        let content = (await this.filesystem.readTextFile(traefikYmlSrc)) as string;
        content = content.replace('{{ACME_EMAIL}}', 'admin@companionintelligence.com');
        await this.filesystem.writeTextFile(traefikYmlDest, content);
        this.logger.info('Copied traefik.yml');
      } else {
        this.logger.warn(`Traefik config file not found at ${traefikYmlSrc}`);
      }

      // Copy dynamic config
      const dynamicSrc = path.join(assetsTraefikDir, 'dynamic', 'dynamic.yml');
      const dynamicDestDir = path.join(dataDir, 'state', 'traefik', 'dynamic');
      await this.filesystem.createDirectory(dynamicDestDir);
      const dynamicDest = path.join(dynamicDestDir, 'dynamic.yml');
      if (await this.filesystem.pathExists(dynamicSrc)) {
        const content = (await this.filesystem.readTextFile(dynamicSrc)) as string;
        await this.filesystem.writeTextFile(dynamicDest, content);
        this.logger.info('Copied dynamic.yml');
      } else {
        this.logger.warn(`Traefik dynamic config file not found at ${dynamicSrc}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to copy Traefik config files: ${error instanceof Error ? error.message : error}. Traefik may not start correctly.`);
    }

    // Create media folders (with timeout to prevent hanging)
    this.logger.info('Creating media folders');
    try {
      await Promise.race([
        this.filesystem.createDirectories([
          path.join(dataDir, 'media', 'torrents', 'watch'),
          path.join(dataDir, 'media', 'torrents', 'complete'),
          path.join(dataDir, 'media', 'torrents', 'incomplete'),
          path.join(dataDir, 'media', 'usenet', 'watch'),
          path.join(dataDir, 'media', 'usenet', 'complete'),
          path.join(dataDir, 'media', 'usenet', 'incomplete'),
          path.join(dataDir, 'media', 'downloads', 'watch'),
          path.join(dataDir, 'media', 'downloads', 'complete'),
          path.join(dataDir, 'media', 'downloads', 'incomplete'),
          path.join(dataDir, 'media', 'data', 'books'),
          path.join(dataDir, 'media', 'data', 'comics'),
          path.join(dataDir, 'media', 'data', 'movies'),
          path.join(dataDir, 'media', 'data', 'music'),
          path.join(dataDir, 'media', 'data', 'tv'),
          path.join(dataDir, 'media', 'data', 'podcasts'),
          path.join(dataDir, 'media', 'data', 'images'),
          path.join(dataDir, 'media', 'data', 'roms'),
        ]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media folder creation timed out after 10 seconds')), 10000)),
      ]);
      this.logger.info('Media folders created successfully');
    } catch (error) {
      // Don't fail startup if media folder creation times out or fails
      // They'll be created on-demand when needed
      this.logger.warn(`Media folder creation failed or timed out: ${error instanceof Error ? error.message : error}. Continuing startup...`);
    }
  }

  /**
   * Validate that critical data directories exist and are writable.
   * Creates missing directories and logs warnings for potential data loss.
   */
  private async validateDataDirectories(): Promise<void> {
    const criticalDirs = [
      { name: 'data', path: DATA_DIR },
      { name: 'app-data', path: APP_DATA_DIR },
      { name: 'state', path: path.join(DATA_DIR, 'state') },
      { name: 'apps', path: path.join(DATA_DIR, 'apps') },
      { name: 'user-config', path: path.join(DATA_DIR, 'user-config') },
    ];

    for (const dir of criticalDirs) {
      try {
        await fs.promises.access(dir.path, fs.constants.F_OK);
      } catch {
        this.logger.warn(`Critical directory missing: ${dir.path} — creating it`);
        await fs.promises.mkdir(dir.path, { recursive: true });
      }

      try {
        await fs.promises.access(dir.path, fs.constants.W_OK);
      } catch {
        this.logger.error(`Critical directory not writable: ${dir.path}`);
      }
    }

    // Check for data loss: sentinel file in app-data
    const sentinelPath = path.join(APP_DATA_DIR, '.ci-hub-initialized');
    try {
      await fs.promises.access(sentinelPath);
      this.logger.info('Data integrity check passed — app-data volume intact');
    } catch {
      // Check if this is a fresh install or data loss
      const appsDir = path.join(DATA_DIR, 'apps');
      try {
        const entries = await fs.promises.readdir(appsDir);
        if (entries.length > 0) {
          this.logger.error(
            'POTENTIAL DATA LOSS: App definitions exist but app-data sentinel is missing. ' +
              'This may indicate the app-data volume was recreated. ' +
              'Check that app databases and configs are intact.',
          );
        }
      } catch {
        // apps dir empty or missing — fresh install
      }

      // Create sentinel for future checks
      try {
        await fs.promises.writeFile(
          sentinelPath,
          JSON.stringify({
            createdAt: new Date().toISOString(),
            version: process.env.CI_HUB_VERSION || process.env.TIPI_VERSION || 'unknown',
          }),
        );
        this.logger.info('Created app-data sentinel file (first run or volume reset)');
      } catch (err) {
        this.logger.error(`Failed to create sentinel file: ${err}`);
      }
    }

    this.logger.info('Data directory validation completed');
  }

  /**
   * Backfill port allocations for apps that were installed before the port manager existed.
   * Scans all installed apps and creates port_allocation records for any that are missing.
   */
  private async migrateExistingPortAllocations() {
    try {
      const apps = await this.appsRepository.getApps();
      let migrated = 0;

      for (const installedApp of apps) {
        if (!installedApp.port) continue;

        const appUrn = `${installedApp.appName}:${installedApp.appStoreSlug}` as import('@ci-hub/common/types').AppUrn;
        try {
          await this.portManager.migrateExistingApp(appUrn, installedApp.port, installedApp.port);
          migrated++;
        } catch (err) {
          this.logger.warn(`Failed to migrate port allocation for ${appUrn}: ${err}`);
        }
      }

      if (migrated > 0) {
        this.logger.info(`Port allocation migration: checked ${apps.length} apps, backfilled ${migrated}`);
      }
    } catch (err) {
      this.logger.warn(`Port allocation migration failed (non-fatal): ${err}`);
    }
  }
}
