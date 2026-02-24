import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { pLimit } from '@/common/helpers/file-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { CURRENT_SCHEMA_VERSION, parseComposeJson } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import axios from 'axios';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { PortAllocationRepository } from '../network/port-allocation.repository';
import { RegistrationService } from '../registration/registration.service';
import { AppFilesManager } from './app-files-manager';
import { AppsRepository } from './apps.repository';

type AppList = Awaited<ReturnType<AppsRepository['getApps']>>;

@Injectable()
export class AppsService {
  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly logger: LoggerService,
    private readonly marketplaceService: MarketplaceService,
    private readonly configurationService: ConfigurationService,
    private readonly portAllocationRepository: PortAllocationRepository,
    @Inject(forwardRef(() => RegistrationService)) private readonly registrationService: RegistrationService,
  ) {}

  private async populateAppInfo(apps: AppList) {
    const limit = pLimit(10);

    const populatedApps = await Promise.all(
      apps.map(async (app) => {
        return limit(async () => {
          const appUrn = createAppUrn(app.appName, app.appStoreSlug);
          const appInfo = await this.appFilesManager.getInstalledAppInfo(appUrn);

          const updateInfo = await this.marketplaceService.getAppUpdateInfo(appUrn).catch((_) => {
            return { latestVersion: 0, latestDockerVersion: '0.0.0' };
          });

          if (!appInfo) {
            this.logger.debug(`App ${app.id} not found in app files`);
            return null;
          }

          let composeSchemaVersion: number | undefined;
          try {
            const compose = await this.appFilesManager.getDockerComposeJson(appUrn);
            if (compose.content) {
              const parsed = parseComposeJson(compose.content) as unknown as { _schemaVersion: number };
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

    if (!info) {
      info = (await this.marketplaceService.getAppInfoFromAppStore(appUrn)) ?? null;
    }

    if (!info) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    let composeSchemaVersion: number | undefined;
    try {
      const compose = await this.appFilesManager.getDockerComposeJson(appUrn);
      if (compose.content) {
        const parsed = parseComposeJson(compose.content) as unknown as { _schemaVersion: number };
        composeSchemaVersion = parsed._schemaVersion;
      }
    } catch (error) {
      this.logger.debug(`Could not parse compose schema version for ${appUrn}:`, error);
    }

    const metadata = {
      hasCustomConfig,
      composeSchemaVersion: composeSchemaVersion ?? CURRENT_SCHEMA_VERSION,
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

    return { app: app ?? null, info, metadata, allocatedPort };
  }

  public async checkAppAvailability(appUrn: AppUrn): Promise<{ available: boolean; reason?: string }> {
    const { app, info } = await this.getApp(appUrn);

    if (!app || app.status !== 'running') {
      return { available: false };
    }

    const config = this.configurationService.getConfig();
    const userSettings = config.userSettings;
    const org = await this.registrationService.getDeviceRegistrationInfo();
    const organizationSlug = org?.slug;

    if (!organizationSlug || !userSettings.domain) {
      return { available: false }; // Should likely return check error, but boolean is fine for now
    }

    const subdomain = app.localSubdomain;
    const domainSuffix = `-${organizationSlug}.${userSettings.domain}`;
    const urlSuffix = info.url_suffix || '';
    const appUrl = `https://${subdomain}${domainSuffix}${urlSuffix}`;

    try {
      const response = await axios.get(appUrl, { timeout: 5000, validateStatus: () => true });
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const isCloudflare = text.includes('Cloudflare Ray ID') || text.includes('cf-error-details');

      if (isCloudflare) {
        // Extract Cloudflare error code if present (e.g. "Error 502", "Error 1033")
        const cfErrorMatch = text.match(/Error\s+(\d{3,4})/i);
        const cfDetail = cfErrorMatch ? `Cloudflare Error ${cfErrorMatch[1]}` : `Cloudflare Error (HTTP ${response.status})`;
        return { available: false, reason: 'CLOUDFLARE', detail: cfDetail };
      }

      const available = response.status >= 200 && response.status < 300;
      if (!available) {
        return { available: false, reason: 'APP_ERROR', detail: `HTTP ${response.status}` };
      }
      return { available };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'UNKNOWN_ERROR';
      return { available: false, reason: 'NETWORK_ERROR', detail: message };
    }
  }

  public async getRandomPort(tries = 3): Promise<number> {
    if (tries <= 0) {
      throw new Error('Failed to get random port after 3 tries');
    }

    const port = Math.floor(Math.random() * (65535 - 1025 + 1)) + 1025;
    const apps = await this.appsRepository.getAppsByPort(port);

    if (apps.length === 0) {
      return port;
    }

    return this.getRandomPort(tries - 1);
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

  public async ignoreAppVersion(appUrn: AppUrn) {
    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    const { latestVersion } = await this.marketplaceService.getAppUpdateInfo(appUrn);

    await this.appsRepository.updateAppById(app.id, { ignoredVersion: latestVersion });

    this.logger.info(`Ignored version ${latestVersion} for app ${appUrn}`);
  }

  public async unignoreAppVersion(appUrn: AppUrn) {
    const app = await this.appsRepository.getAppByUrn(appUrn);

    if (!app) {
      throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', {}, 404);
    }

    await this.appsRepository.updateAppById(app.id, { ignoredVersion: null });

    this.logger.info(`Unignored version for app ${appUrn}`);
  }
}
