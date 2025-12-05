import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
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
import { GithubService } from './utils/github/github.service';

@Injectable()
export class AppService {
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
    private readonly githubService: GithubService,
    @Inject(DOCKERODE) private docker: Dockerode,
  ) {}

  public async bootstrap() {
    try {
      await this.databaseService.migrate();
      await this.docker.pruneNetworks();

      const { version, userSettings, __prod__ } = this.configuration.getConfig();
      const config = this.configuration.getConfig();
      this.logger.info('Log level', config.userSettings.logLevel);
      this.logger.debug('Starting with configuration', config);

      this.configuration.initSentry({ release: version, allowSentry: userSettings.allowErrorMonitoring });

      await this.logger.flush();

      this.logger.info(`Running version: ${process.env.TIPI_VERSION}`);

      const buster = this.cache.get('buster');
      if (buster !== version) {
        this.logger.info('Clearing cache...');
        this.cache.clear();
        this.cache.set('buster', version, ONE_DAY_IN_SECONDS * 365);
      }

      await this.appStoreService.migrateLegacyRepo();

      this.repoQueue.publish({ command: 'clone_all' });

      await this.marketplaceService.initialize();

      // Every 15 minutes, check for updates to the apps repo
      if (__prod__) {
        this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
      }
      this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');

      await this.copyAssets();
      await this.generateTlsCertificates({ localDomain: userSettings.localDomain });

      if (__prod__ && (buster !== version || version === 'nightly')) {
        this.appLifecycleService.restartRunningApps();
      }
    } catch (e) {
      this.logger.error(e);
      Sentry.captureException(e, { tags: { source: 'bootstrap' } });
    }
  }

  public async getVersion() {
    const { version: currentVersion } = this.configuration.getConfig();

    const [githubRelease, releasesSince] = await Promise.all([
      this.githubService.getLatestRelease('runtipi', 'runtipi'),
      this.githubService.getReleasesSince('runtipi', 'runtipi', currentVersion),
    ]);

    return {
      current: currentVersion,
      latest: githubRelease?.version || currentVersion,
      body: githubRelease?.body ?? '',
      releases: releasesSince,
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
    ]);

    // Create media folders
    this.logger.info('Creating media folders');
    await this.filesystem.createDirectories([
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
    ]);
  }

  /**
   * TLS certificate generation - no longer needed as Cloudflare handles TLS
   * Kept as a no-op for backwards compatibility
   */
  public generateTlsCertificates = async (_data: { localDomain?: string }) => {
    // TLS is handled by Cloudflare Tunnel - no local certificate generation needed
  };
}
