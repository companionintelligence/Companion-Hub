import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { pLimit } from '@/common/helpers/file-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
    private readonly moduleRef: ModuleRef,
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

  public async checkAppAvailability(appUrn: AppUrn): Promise<{
    available: boolean;
    reason?: string;
    detail?: string;
    errorCode?: string;
    resolvable?: boolean;
  }> {
    const { app, info } = await this.getApp(appUrn);

    if (!app || app.status !== 'running') {
      return { available: false };
    }

    const config = this.configurationService.getConfig();
    const userSettings = config.userSettings;
    const org = await this.registrationService.getDeviceRegistrationInfo();
    const organizationSlug = org?.slug;

    if (!organizationSlug || !userSettings.domain) {
      return { available: false };
    }

    const exposureMode = ((app as Record<string, unknown>).exposureMode as string) || 'local';
    const subdomain = app.localSubdomain;
    const domainSuffix = `-${organizationSlug}.${userSettings.domain}`;
    const urlSuffix = info.url_suffix || '';
    const appUrl = `https://${subdomain}${domainSuffix}${urlSuffix}`;

    try {
      const response = await axios.get(appUrl, { timeout: 5000, validateStatus: () => true });
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const isCloudflare = text.includes('Cloudflare Ray ID') || text.includes('cf-error-details');

      if (isCloudflare) {
        const cfErrorMatch = text.match(/Error\s+(\d{3,4})/i);
        const cfCode = cfErrorMatch ? Number(cfErrorMatch[1]) : response.status;

        // Cloudflare 1033 = Argo Tunnel not found (tunnel config missing for this hostname)
        if (cfCode === 1033) {
          return {
            available: false,
            reason: 'CLOUDFLARE',
            errorCode: 'CF_TUNNEL_NOT_FOUND',
            detail: 'Tunnel route not configured for this app. DNS or tunnel config may be out of sync.',
            resolvable: true,
          };
        }

        // 502/503/504 = upstream unreachable (container down or tunnel can't reach Traefik)
        if ([502, 503, 504].includes(cfCode) || [502, 503, 504].includes(response.status)) {
          return {
            available: false,
            reason: 'CLOUDFLARE',
            errorCode: 'CF_UPSTREAM_ERROR',
            detail: `Cloudflare can't reach the app (HTTP ${response.status}). The container may need restarting or the tunnel config may be stale.`,
            resolvable: true,
          };
        }

        // 521 = Web server is down
        if (cfCode === 521 || response.status === 521) {
          return {
            available: false,
            reason: 'CLOUDFLARE',
            errorCode: 'CF_ORIGIN_DOWN',
            detail: 'Cloudflare reports the origin server is down. The tunnel may not be running.',
            resolvable: true,
          };
        }

        // 522/524 = Connection timed out
        if ([522, 524].includes(cfCode) || [522, 524].includes(response.status)) {
          return {
            available: false,
            reason: 'CLOUDFLARE',
            errorCode: 'CF_TIMEOUT',
            detail: 'Connection to the app timed out through Cloudflare. The tunnel or app may be overloaded.',
            resolvable: true,
          };
        }

        return {
          available: false,
          reason: 'CLOUDFLARE',
          errorCode: 'CF_UNKNOWN',
          detail: cfErrorMatch ? `Cloudflare Error ${cfErrorMatch[1]}` : `Cloudflare Error (HTTP ${response.status})`,
          resolvable: false,
        };
      }

      const available = response.status >= 200 && response.status < 300;
      if (!available) {
        // 502/503 without Cloudflare page = Traefik/reverse proxy can't reach the container
        if ([502, 503].includes(response.status)) {
          return {
            available: false,
            reason: 'APP_ERROR',
            errorCode: 'PROXY_UPSTREAM_ERROR',
            detail: `Reverse proxy returned HTTP ${response.status}. The app container may not be ready yet.`,
            resolvable: true,
          };
        }

        return {
          available: false,
          reason: 'APP_ERROR',
          errorCode: 'APP_HTTP_ERROR',
          detail: `HTTP ${response.status}`,
          resolvable: false,
        };
      }
      return { available };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'UNKNOWN_ERROR';

      // DNS resolution failure
      if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
        if (exposureMode === 'cloudflare') {
          return {
            available: false,
            reason: 'NETWORK_ERROR',
            errorCode: 'DNS_NOT_FOUND',
            detail: 'DNS record not found. The domain may not be synced with Cloudflare yet.',
            resolvable: true,
          };
        }
        return {
          available: false,
          reason: 'NETWORK_ERROR',
          errorCode: 'DNS_NOT_FOUND',
          detail: 'DNS resolution failed for the app domain.',
          resolvable: false,
        };
      }

      // Connection refused = nothing listening on that port
      if (message.includes('ECONNREFUSED')) {
        return {
          available: false,
          reason: 'NETWORK_ERROR',
          errorCode: 'CONNECTION_REFUSED',
          detail: 'Connection refused. The app or reverse proxy may not be listening.',
          resolvable: true,
        };
      }

      // Timeout
      if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
        return {
          available: false,
          reason: 'NETWORK_ERROR',
          errorCode: 'CONNECTION_TIMEOUT',
          detail: 'Connection timed out reaching the app.',
          resolvable: false,
        };
      }

      return {
        available: false,
        reason: 'NETWORK_ERROR',
        errorCode: 'UNKNOWN',
        detail: message,
        resolvable: false,
      };
    }
  }

  /**
   * Attempt to resolve an app availability issue based on the error code.
   * Returns what action was taken and whether it succeeded.
   */
  public async resolveAppAvailability(appUrn: AppUrn): Promise<{
    success: boolean;
    action: string;
    detail: string;
  }> {
    // First check what the current error is
    const check = await this.checkAppAvailability(appUrn);

    if (check.available) {
      return { success: true, action: 'none', detail: 'App is already available.' };
    }

    if (!check.resolvable) {
      return { success: false, action: 'none', detail: `This error is not automatically resolvable: ${check.detail}` };
    }

    const { app } = await this.getApp(appUrn);
    if (!app) {
      return { success: false, action: 'none', detail: 'App not found.' };
    }

    const exposureMode = ((app as Record<string, unknown>).exposureMode as string) || 'local';
    const actions: string[] = [];

    try {
      // For Cloudflare errors: re-sync state with CI-Cloud
      if (
        check.errorCode === 'DNS_NOT_FOUND' ||
        check.errorCode === 'CF_TUNNEL_NOT_FOUND' ||
        check.errorCode === 'CF_UPSTREAM_ERROR' ||
        check.errorCode === 'CF_ORIGIN_DOWN' ||
        check.errorCode === 'CF_TIMEOUT'
      ) {
        const { AppLifecycleService } = await import('../app-lifecycle/app-lifecycle.service');
        const lifecycleService = this.moduleRef.get(AppLifecycleService, { strict: false });
        if (lifecycleService) {
          // Trigger a full Cloudflare + Tailscale sync
          await lifecycleService.syncExposurePublic();
          actions.push('Re-synced tunnel and DNS configuration with CI-Cloud');
        }
      }

      // For Tailscale errors: re-add serve entry
      if (exposureMode === 'tailscale' && (check.errorCode === 'CONNECTION_REFUSED' || check.errorCode === 'PROXY_UPSTREAM_ERROR')) {
        const { TailscaleService } = await import('../tailscale/tailscale.service');
        const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
        if (tailscaleService && app.localSubdomain) {
          await tailscaleService.serveApp({ subdomain: app.localSubdomain, localPort: 80 });
          actions.push('Re-added Tailscale Serve entry');
        }
      }

      // For upstream/proxy errors: restart the app container
      if (check.errorCode === 'PROXY_UPSTREAM_ERROR' || check.errorCode === 'CONNECTION_REFUSED' || check.errorCode === 'CF_ORIGIN_DOWN') {
        const { DockerService } = await import('../docker/docker.service');
        const dockerService = this.moduleRef.get(DockerService, { strict: false });
        if (dockerService) {
          const appName = app.appName;
          try {
            await dockerService.restartContainer(appName);
            actions.push(`Restarted container: ${appName}`);
          } catch (e) {
            actions.push(`Failed to restart container: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (actions.length === 0) {
        return { success: false, action: 'none', detail: 'No resolution actions available for this error.' };
      }

      return {
        success: true,
        action: actions.join('; '),
        detail: `Attempted: ${actions.join('; ')}. The app may take a moment to become available.`,
      };
    } catch (e) {
      return {
        success: false,
        action: 'error',
        detail: `Resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
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
