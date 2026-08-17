import { TranslatableError } from '@/common/error/translatable-error';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { InstallPipelineTracker } from './install-pipeline.tracker';
import { pLimit } from '@/common/helpers/file-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { CURRENT_SCHEMA_VERSION, parseComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { PortAllocationRepository } from '../network/port-allocation.repository';
import { AppFilesManager } from './app-files-manager';
import { AppsRepository } from './apps.repository';

type AppList = Awaited<ReturnType<AppsRepository['getApps']>>;

@Injectable()
export class AppsReadService {
  private static readonly UPDATES_AVAILABLE_TTL_MS = 60_000;
  private updatesAvailableCache: { count: number; at: number } | null = null;
  private updatesAvailableInFlight: Promise<number> | null = null;

  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly logger: LoggerService,
    private readonly marketplaceService: MarketplaceService,
    private readonly configurationService: ConfigurationService,
    private readonly portAllocationRepository: PortAllocationRepository,
    private readonly installPipelineTracker: InstallPipelineTracker,
  ) {}

  public async populateAppInfo(apps: AppList) {
    const limit = pLimit(10);

    const populatedApps = await Promise.all(
      apps.map(async (app) => {
        return limit(async () => {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          let appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);

          const updateInfo = await this.marketplaceService.getAppUpdateInfo(appUrn).catch((_) => {
            return { latestVersion: 0, latestDockerVersion: '0.0.0' };
          });

          if (!appInfo) {
            appInfo = (await this.marketplaceService.getAppInfoFromAppStore(appUrn)) ?? null;
          }

          if (!appInfo) {
            this.logger.debug(`App ${app.id} not found in app files or marketplace`);
            return null;
          }

          let composeSchemaVersion: number | undefined;
          try {
            const compose = await this.appFilesManager.getDockerComposeJson(appUrn);
            if (compose.content) {
              const parsed = parseComposeJson(compose.content, { appName: app.appName }) as unknown as { _schemaVersion: number };
              composeSchemaVersion = parsed._schemaVersion;
            }
          } catch (error) {
            this.logger.debug(`Could not parse compose schema version for ${appUrn}:`, error);
          }

          const localSubdomain = app.localSubdomain || appUrn.split(':')[0];
          return {
            app,
            info: appInfo,
            metadata: { ...updateInfo, localSubdomain, composeSchemaVersion: composeSchemaVersion ?? CURRENT_SCHEMA_VERSION },
          };
        });
      }),
    );

    return populatedApps.filter((app) => app !== null);
  }

  /**
   * Get the installed apps
   */
  public async getInstalledApps() {
    const apps = await this.appsRepository.getApps();

    return this.populateAppInfo(apps);
  }

  /** DB-only installed app rows — no marketplace compose fan-out. */
  public async getInstalledAppsLite() {
    return this.appsRepository.getApps();
  }

  /** URN list for store badges — DB only, no compose/marketplace fan-out. */
  public async getInstalledAppUrns(): Promise<string[]> {
    const apps = await this.appsRepository.getApps();
    return apps.map((app) => createAppUrn(app.appName, app.appStoreSlug));
  }

  public async countUpdatesAvailable(): Promise<number> {
    const apps = await this.appsRepository.getApps();
    const limit = pLimit(5);
    const flags = await Promise.all(
      apps.map((app) =>
        limit(async () => {
          if (app.status === 'updating') return false;
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          const updateInfo = await this.marketplaceService.getAppUpdateInfo(appUrn).catch(() => null);
          return Boolean(updateInfo && Number(app.version) < Number(updateInfo.latestVersion ?? 0));
        }),
      ),
    );
    return flags.filter(Boolean).length;
  }

  /**
   * Single-flight + TTL cache for the expensive updates walk.
   * Concurrent callers share one marketplace FS pass.
   */
  public async getUpdatesAvailableCached(): Promise<number> {
    const now = Date.now();
    if (this.updatesAvailableCache && now - this.updatesAvailableCache.at < AppsReadService.UPDATES_AVAILABLE_TTL_MS) {
      return this.updatesAvailableCache.count;
    }
    if (this.updatesAvailableInFlight) {
      return this.updatesAvailableInFlight;
    }
    this.updatesAvailableInFlight = this.countUpdatesAvailable()
      .then((count) => {
        this.updatesAvailableCache = { count, at: Date.now() };
        return count;
      })
      .finally(() => {
        this.updatesAvailableInFlight = null;
      });
    return this.updatesAvailableInFlight;
  }

  /**
   * Non-blocking peek for `/api/app-context`: return last known count (or 0) and
   * kick a background refresh when the TTL has expired.
   */
  public peekUpdatesAvailableCached(): number {
    const now = Date.now();
    if (!this.updatesAvailableCache || now - this.updatesAvailableCache.at >= AppsReadService.UPDATES_AVAILABLE_TTL_MS) {
      void this.getUpdatesAvailableCached();
    }
    return this.updatesAvailableCache?.count ?? 0;
  }

  public invalidateUpdatesAvailableCache() {
    this.updatesAvailableCache = null;
  }

  /** Active install (Docker pipeline) and apps waiting in the install queue. */
  public async getInstallQueueState() {
    const installing = await this.appsRepository.getAppsByStatus('installing');
    const activeUrn = this.installPipelineTracker.getActive();

    const entries = await Promise.all(
      installing.map(async (app) => {
        const urn = createAppUrn(app.appName, app.appStoreSlug);
        let name = app.appName;
        const info = (await this.appFilesManager.getInstalledAppInfo(urn)) ?? (await this.marketplaceService.getAppInfoFromAppStore(urn));
        if (info?.name) name = info.name;
        return { urn, name, id: app.id };
      }),
    );

    entries.sort((a, b) => a.id - b.id);

    // Active = app currently holding the Docker install pipeline mutex only.
    // Everything else in `installing` is queued behind it (FIFO by app id).
    const active = activeUrn ? (entries.find((e) => e.urn === activeUrn) ?? null) : null;

    const queued = entries.filter((e) => e.urn !== active?.urn).map(({ urn, name }) => ({ urn, name }));

    return {
      active: active ? { urn: active.urn, name: active.name } : null,
      queued,
    };
  }

  public async getGuestDashboardApps() {
    this.logger.debug('Getting guest dashboard apps');
    const apps = await this.appsRepository.getGuestDashboardApps();
    this.logger.debug(`Got ${apps.length} guest dashboard apps`);

    return this.populateAppInfo(apps);
  }

  public async getApp(appUrn: AppUrn) {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    const updateInfo = await this.marketplaceService.getAppUpdateInfo(appUrn).catch((_) => {
      return { latestVersion: 0, latestDockerVersion: '0.0.0' };
    });

    let info = await this.appFilesManager.getInstalledAppInfo(appUrn);

    const userCompose = await this.appFilesManager.getUserComposeFile(appUrn);
    const userEnv = await this.appFilesManager.getUserEnv(appUrn);
    const hasCustomConfig = Boolean(userCompose.content) || Boolean(userEnv.content);

    if (info) {
      info = await this.marketplaceService.resolveAppDescription(appUrn, info);
    } else {
      info = (await this.marketplaceService.getAppInfoFromAppStore(appUrn)) ?? null;
    }

    if (!info) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    const iconUrl = await this.marketplaceService.getPortalIconUrl(appUrn);

    let composeSchemaVersion: number | undefined;
    try {
      const compose = await this.appFilesManager.getDockerComposeJson(appUrn);
      if (compose.content) {
        const { appName } = extractAppUrn(appUrn);
        const parsed = parseComposeJson(compose.content, { appName }) as unknown as { _schemaVersion: number };
        composeSchemaVersion = parsed._schemaVersion;
      }
    } catch (error) {
      this.logger.debug(`Could not parse compose schema version for ${appUrn}:`, error);
    }

    const metadata = {
      hasCustomConfig,
      composeSchemaVersion: composeSchemaVersion ?? CURRENT_SCHEMA_VERSION,
      iconUrl: iconUrl ?? undefined,
      ...updateInfo,
    };

    // Get allocated port from port_allocation table
    let allocatedPort: number | undefined;
    try {
      const allocations = await this.portAllocationRepository.getByAppUrn(appUrn);
      const mainAlloc = allocations.find((a) => a.label === 'main');
      if (mainAlloc) {
        allocatedPort = mainAlloc.hostPort;
      }
    } catch (err) {
      this.logger.debug(`Could not get port allocation for ${appUrn}: ${err}`);
    }

    // Resolve the host path of the app's data folder so the desktop app can
    // open it in the OS file explorer. Best-effort: never fail getApp over it.
    let appDataHostPath: string | null = null;
    try {
      const config = this.configurationService.getConfig();
      appDataHostPath = getAppDataHostPath(appUrn, {
        // Mirror the precedence used during compose generation (app.helpers.ts):
        // CI_HUB_APP_DATA_PATH env override → userSettings.appDataPath → ROOT_FOLDER_HOST.
        ciHubAppDataPath: process.env.CI_HUB_APP_DATA_PATH,
        appDataPath: config.userSettings.appDataPath,
        rootFolderHost: config.rootFolderHost,
      });
      this.logger.debug(`Resolved app data host path for ${appUrn}: ${appDataHostPath}`);
    } catch (err) {
      this.logger.warn(`Could not resolve app data host path for ${appUrn}: ${err}`);
    }

    return { app: app ?? null, info, metadata, allocatedPort, appDataHostPath };
  }

  public async getAppComposeDiff(appUrn: AppUrn) {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    const [currentCompose, storeCompose] = await Promise.all([
      this.appFilesManager.getDockerComposeJson(appUrn),
      this.marketplaceService.getDockerComposeJson(appUrn),
    ]);

    return {
      current: currentCompose.content ? JSON.stringify(currentCompose.content, null, 2) : null,
      new: storeCompose.content ? JSON.stringify(storeCompose.content, null, 2) : null,
    };
  }

  public async getAppConfigDiff(appUrn: AppUrn) {
    const app = await this.appsRepository.getAppByUrn(appUrn);
    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    const [currentConfig, storeConfig] = await Promise.all([
      this.appFilesManager.getConfigJson(appUrn),
      this.marketplaceService.getConfigJson(appUrn),
    ]);

    return {
      current: currentConfig.content ? JSON.stringify(currentConfig.content, null, 2) : null,
      new: storeConfig.content ? JSON.stringify(storeConfig.content, null, 2) : null,
    };
  }
}
