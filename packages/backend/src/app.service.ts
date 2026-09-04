import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_DATA_DIR, DATA_DIR, HUB_STACK_REGISTRY_REPO, hubContainerName } from './common/constants';
import { withTimeout } from './common/helpers/with-timeout';
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
import { SESSION_KEY_PREFIX } from './modules/auth/session.manager';

@Injectable()
export class AppService implements OnApplicationShutdown {
  private isDockerBootstrapPermissionIssue(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const err = error as NodeJS.ErrnoException;
    const message = error.message.toLowerCase();
    return (
      err.code === 'EACCES' ||
      err.code === 'EPERM' ||
      message.includes('connect eacces') ||
      message.includes('permission denied') ||
      message.includes('docker.sock')
    );
  }

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
      // #933: wait for Postgres before touching it. `depends_on: service_healthy` only gates the
      // FIRST stack start — a Hub container restarting alone (update, crash, OOM) races a DB that
      // may itself be restarting or waiting on Docker DNS. Bounded wait, then fail loudly.
      await this.databaseService.waitUntilReady();
      await this.databaseService.migrate();
      this.logger.info('Database migration completed');

      // No key is seeded at boot. Every MCP key is created deliberately by an operator (Settings →
      // Security) or provisioned to an app; the appliance ships with none. The previous "Default"
      // key was derived from the appliance seed, which made it the one credential here that could
      // not be rotated and that anyone with read access to the state directory already held.

      // Validate data directory integrity
      await this.validateDataDirectories();

      // Do not block listen on Docker prune — a hung dockerode call on Desktop can
      // starve the event loop before /api/health/live is reachable.
      void Promise.race([
        this.docker.pruneNetworks(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Docker network prune timed out after 15s')), 15_000);
        }),
      ])
        .then(() => this.logger.info('Docker networks pruned'))
        .catch((error) => {
          if (this.isDockerBootstrapPermissionIssue(error)) {
            this.logger.warn(
              `Skipping Docker network prune during bootstrap because the Docker socket is not accessible yet: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
          this.logger.warn(`Docker network prune skipped: ${error instanceof Error ? error.message : String(error)}`);
        });

      const { version, __prod__ } = this.configuration.getConfig();
      const config = this.configuration.getConfig();
      this.logger.info('Log level', config.userSettings.logLevel);
      this.logger.debug('Starting with configuration', config);

      await this.logger.flush();
      this.logger.startPeriodicFlush();
      this.logger.info('Logger flushed, daily rotation scheduled');

      this.logger.info(`Running version: ${process.env.CI_HUB_VERSION}`);

      const buster = this.cache.get('buster');
      if (buster !== version) {
        this.logger.info('Clearing cache...');
        // Sessions live in the same store but are not cache: wiping them here signed
        // every user out of every device on each upgrade (#944). The prefix comes from
        // the session store itself so a change to its key shape cannot silently
        // re-introduce that.
        this.cache.clear([SESSION_KEY_PREFIX]);
        this.cache.set('buster', version, ONE_DAY_IN_SECONDS * 365);
        this.logger.info('Cache cleared');
      }

      await this.appStoreService.registerCloudAppStore();

      this.logger.info('Initializing marketplace...');
      await this.marketplaceService.initialize();
      this.logger.info('Marketplace initialized');

      // Refresh app store catalogs in the background so CI Marketplace and legacy
      // git stores pick up newly published versions without waiting for the cron job.
      void this.appStoreService
        .pullRepositories()
        .then(() => this.marketplaceService.initialize())
        .catch((error) => {
          this.logger.warn(`Background app store catalog sync failed: ${error instanceof Error ? error.message : String(error)}`);
        });

      // Every 15 minutes, check for updates to the apps repo
      if (__prod__) {
        this.logger.info('Setting up repeatable repo update job...');
        this.repoQueue.publishRepeatable({ command: 'update_all' }, '*/15 * * * *');
        this.logger.info('Repo update job scheduled');
      }
      this.logger.info('Setting up repeatable app status sync job...');
      this.systemEventsQueue.publishRepeatable({ command: 'sync_app_statuses' }, '*/5 * * * *');
      this.logger.info('App status sync job scheduled');

      this.logger.info('Setting up repeatable orphan network reconcile job...');
      this.systemEventsQueue.publishRepeatable({ command: 'reconcile_orphan_networks' }, '*/30 * * * *');
      this.logger.info('Orphan network reconcile job scheduled');

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
      throw e; // Re-throw to ensure startup fails if bootstrap fails
    }
  }

  private static readonly VERSION_TTL_MS = 30_000;
  private static readonly VERSION_LOOKUP_TIMEOUT_MS = 2_500;
  private versionCache: {
    value: { current: string; latest: string; body: string; releases: { version: string; body: string }[] };
    at: number;
  } | null = null;
  private versionInFlight: Promise<{ current: string; latest: string; body: string; releases: { version: string; body: string }[] }> | null = null;

  /** Current version from config plus any already-fetched latest. Never hits the network. */
  public peekLocalVersion() {
    const { version: currentVersion } = this.configuration.getConfig();
    if (this.versionCache) {
      return { ...this.versionCache.value, current: currentVersion };
    }
    return {
      current: currentVersion,
      latest: currentVersion,
      body: '',
      releases: [] as { version: string; body: string }[],
    };
  }

  /** Warm the version cache without blocking bootstrap. */
  public refreshVersionInBackground() {
    void this.getVersion().catch(() => undefined);
  }

  public async getVersion() {
    const now = Date.now();
    if (this.versionCache && now - this.versionCache.at < AppService.VERSION_TTL_MS) {
      return this.versionCache.value;
    }
    if (this.versionInFlight) {
      return this.versionInFlight;
    }

    this.versionInFlight = (async () => {
      const local = this.peekLocalVersion();
      try {
        const releasesSince = await withTimeout(
          this.registryService.getTagsSinceWithHubFallback(HUB_STACK_REGISTRY_REPO, local.current),
          AppService.VERSION_LOOKUP_TIMEOUT_MS,
          'version lookup timed out',
        );

        const releases = releasesSince.map((tag) => ({
          version: tag,
          body: `Release ${tag}`,
        }));

        const latest = releases[0]?.version ?? local.current;
        const value = {
          current: local.current,
          latest,
          body: '',
          releases,
        };
        this.versionCache = { value, at: Date.now() };
        return value;
      } catch {
        this.versionCache = { value: local, at: Date.now() };
        return local;
      }
    })().finally(() => {
      this.versionInFlight = null;
    });

    return this.versionInFlight;
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

      await this.copyTraefikConfigFile(path.join(assetsTraefikDir, 'traefik.yml'), path.join(traefikConfigDest, 'traefik.yml'), (content) => {
        // Prefer operator email; avoid example.com (LetsEncrypt rejects it). localhost is for local ACME only.
        let next = content.replace('{{ACME_EMAIL}}', process.env.ACME_EMAIL ?? 'admin@localhost');
        // SECURITY: the Traefik dashboard/API is shipped fail-closed (`insecure: false`
        // in assets/traefik/traefik.yml). Only opt back into the unauthenticated
        // dashboard for explicit local development — never in production/staging/test,
        // where the prod compose publishes :8080 to the host.
        if (process.env.NODE_ENV === 'development') {
          next = next.replace(/^(\s*)insecure:\s*false\s*$/m, '$1insecure: true');
        }
        return next;
      });

      // Copy dynamic config
      const dynamicDestDir = path.join(dataDir, 'state', 'traefik', 'dynamic');
      await this.filesystem.createDirectory(dynamicDestDir);
      await this.copyTraefikConfigFile(path.join(assetsTraefikDir, 'dynamic', 'dynamic.yml'), path.join(dynamicDestDir, 'dynamic.yml'), (content) =>
        content.replaceAll('{{HUB_CONTAINER_NAME}}', hubContainerName()),
      );
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

  private async copyTraefikConfigFile(src: string, dest: string, transform?: (content: string) => string): Promise<void> {
    const fileName = path.basename(dest);

    if (!(await this.filesystem.pathExists(src))) {
      this.logger.warn(`Traefik config file not found at ${src}`);
      return;
    }

    if ((await this.filesystem.pathExists(dest)) && (await this.filesystem.isDirectory(dest))) {
      this.logger.warn(`Traefik config destination is a directory, removing it before rewriting ${fileName}: ${dest}`);
      const removed = await this.filesystem.removeDirectory(dest);
      if (!removed) {
        this.logger.warn(`Failed to remove directory at Traefik config destination ${dest}. ${fileName} was not restored.`);
        return;
      }
    }

    const rawContent = await this.filesystem.readTextFile(src);
    if (rawContent == null) {
      this.logger.warn(`Failed to read Traefik config source file at ${src}`);
      return;
    }

    const content = transform ? transform(rawContent) : rawContent;
    const wrote = await this.filesystem.writeTextFile(dest, content);

    if (wrote) {
      this.logger.info(`Copied ${fileName}`);
      return;
    }

    this.logger.warn(`Failed to copy ${fileName} to ${dest}`);
  }

  /**
   * Validate that critical data directories exist and are writable.
   * Creates missing directories and logs warnings for potential data loss.
   */
  private async validateDataDirectories(): Promise<void> {
    // Bind-mounted subtrees must be writable; /data itself is often root-owned in the image.
    const criticalDirs = [
      { name: 'app-data', path: APP_DATA_DIR },
      { name: 'cache', path: path.join(DATA_DIR, 'cache') },
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
            version: process.env.CI_HUB_VERSION || 'unknown',
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
