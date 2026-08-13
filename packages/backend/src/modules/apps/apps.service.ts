import { TranslatableError } from '@/common/error/translatable-error';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { App } from '@/core/database/drizzle/types';
import type { AppUrn } from '@ci-hub/common/types';
import { buildPublicWebIdentity } from '@ci-hub/common/types';
import axios from 'axios';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { RegistrationService } from '../registration/registration.service';
import { AppsRepository } from './apps.repository';
import { AppsReadService } from './apps-read.service';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
// Type-only: a value import here closes a require cycle
// (tunnel-health -> docker -> apps -> tunnel-health) that leaves the DI token
// undefined at decoration time and stops the whole backend booting. The class is
// pulled in dynamically at the one place it is used, as with AppLifecycleService.
import type { TunnelHealthService as TunnelHealthServiceType } from '../cloudflare/tunnel-health.service';
import { TailscaleService } from '../tailscale/tailscale.service';

/**
 * Verdict of an app-availability probe.
 *
 * `appUrl` is the app's PRIMARY route — the public tunnel address for an exposed
 * app, the LAN address for a locally-exposed one — and is what `available`
 * describes. `localUrl` is the app's direct LAN address when it has one, and is
 * deliberately independent of the verdict: it is present on failures too, because
 * a broken tunnel says nothing about whether the app answers on the local network.
 * Consumers use it as the fallback route when the primary one is unreachable.
 */
export interface AppAvailabilityResult {
  available: boolean;
  appUrl?: string;
  /** Direct LAN address, when the app publishes a reachable port. */
  localUrl?: string;
  httpStatus?: number;
  stage?: 'ready' | 'propagating' | 'error';
  reason?: string;
  detail?: string;
  errorCode?: string;
  resolvable?: boolean;
}

function buildTailscalePortUrl(nodeFqdn?: string | null, port?: number | null, suffix = ''): string | null {
  const cleanNodeFqdn = nodeFqdn?.trim();
  if (!cleanNodeFqdn || !port) {
    return null;
  }

  return `https://${cleanNodeFqdn}:${port}${suffix}`;
}

@Injectable()
export class AppsService {
  constructor(
    private readonly appsReadService: AppsReadService,
    private readonly appsRepository: AppsRepository,
    private readonly logger: LoggerService,
    private readonly marketplaceService: MarketplaceService,
    private readonly configurationService: ConfigurationService,
    @Inject(forwardRef(() => RegistrationService)) private readonly registrationService: RegistrationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  public populateAppInfo(...args: Parameters<AppsReadService['populateAppInfo']>) {
    return this.appsReadService.populateAppInfo(...args);
  }

  public getInstalledApps() {
    return this.appsReadService.getInstalledApps();
  }

  public getInstalledAppsLite() {
    return this.appsReadService.getInstalledAppsLite();
  }

  public getInstalledAppUrns() {
    return this.appsReadService.getInstalledAppUrns();
  }

  public countUpdatesAvailable() {
    return this.appsReadService.countUpdatesAvailable();
  }

  public getUpdatesAvailableCached() {
    return this.appsReadService.getUpdatesAvailableCached();
  }

  public peekUpdatesAvailableCached() {
    return this.appsReadService.peekUpdatesAvailableCached();
  }

  public invalidateUpdatesAvailableCache() {
    return this.appsReadService.invalidateUpdatesAvailableCache();
  }

  public getInstallQueueState() {
    return this.appsReadService.getInstallQueueState();
  }

  public getGuestDashboardApps() {
    return this.appsReadService.getGuestDashboardApps();
  }

  public getApp(appUrn: AppUrn) {
    return this.appsReadService.getApp(appUrn);
  }

  public getAppComposeDiff(appUrn: AppUrn) {
    return this.appsReadService.getAppComposeDiff(appUrn);
  }

  public getAppConfigDiff(appUrn: AppUrn) {
    return this.appsReadService.getAppConfigDiff(appUrn);
  }

  public async checkAppAvailability(appUrn: AppUrn): Promise<AppAvailabilityResult> {
    const { app, info } = await this.appsReadService.getApp(appUrn);

    if (!app || app.status !== 'running') {
      return { available: false, stage: 'error' };
    }

    // Resolved once, up front, and merged into whatever the probe concludes —
    // including its failure verdicts. A Cloudflare-exposed app whose tunnel is
    // down is very often still reachable on the LAN, and withholding that address
    // is what left the Open button disabled next to a working app
    // (CI-Engineering#75). It also widens the post-connect landing allowlist so a
    // LAN user is not relocated to the public origin.
    const localUrl = this.resolveDirectLocalUrl(app, info);
    const result = await this.probeAppAvailability(app, info);

    return localUrl ? { ...result, localUrl } : result;
  }

  /**
   * The app's direct LAN address (`http://<internalIp>:<port><url_suffix>`), or
   * undefined when it has no directly reachable port.
   *
   * Deliberately mirrors `hasDirectLocalAccess` in the frontend's
   * `app-access-points.tsx` rather than the looser test used by
   * {@link probeAppAvailability} below, because this value is offered to the user
   * as a route to click. The stricter rule is what keeps two cases from getting a
   * dead "Open on local network" button:
   *
   *  - **Tailscale installs** may skip publishing a host port entirely unless
   *    `openPort` was requested, so `exposedLocal` alone must not qualify.
   *  - **Pre-`exposureMode` installs** with a dynamic config bind no fixed host
   *    port, so they only qualify via `openPort` / `exposedLocal`.
   *
   * Offering an address that isn't served would reproduce the exact bug this
   * whole change set exists to remove, so this errs toward returning nothing.
   */
  private resolveDirectLocalUrl(app: App, info: AppInfo): string | undefined {
    if (!app.port) {
      return undefined;
    }

    const mode = app.exposureMode;
    let hasDirectLocalAccess: boolean;

    if (mode === 'tailscale') {
      hasDirectLocalAccess = Boolean(app.openPort);
    } else if (mode === 'cloudflare' || mode === 'local') {
      // Both bind the app port on the host, so the LAN address stays valid even
      // when the tunnel in front of it is not.
      hasDirectLocalAccess = true;
    } else {
      hasDirectLocalAccess = Boolean(app.openPort) || Boolean(app.exposedLocal) || !info.dynamic_config;
    }

    if (!hasDirectLocalAccess) {
      return undefined;
    }

    const { userSettings } = this.configurationService.getConfig();

    // Resolve the browser host once and reject a loopback result. `resolveBrowserHost`
    // is the single owner of the "unset / listen-all" set (it collapses 0.0.0.0/::
    // and unset to loopback), so testing its OUTPUT — rather than re-listing the
    // listen-all spellings here — keeps this in step automatically and also drops a
    // genuine `INTERNAL_IP=127.0.0.1`. Offering `http://127.0.0.1:<port>` as a route
    // to click points any non-loopback browser at its own machine: the dead button
    // this whole change set exists to remove.
    const host = resolveBrowserHost(userSettings.internalIp);
    if (host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return undefined;
    }

    return `http://${host}:${app.port}${info.url_suffix || ''}`;
  }

  /**
   * Probe the app's primary route and classify the answer. Split out of
   * {@link checkAppAvailability} so that method has a single exit point at which
   * the local address can be merged into every verdict.
   */
  private async probeAppAvailability(app: App, info: AppInfo): Promise<AppAvailabilityResult> {
    const config = this.configurationService.getConfig();
    const userSettings = config.userSettings;
    const org = await this.registrationService.getDeviceRegistrationInfo();
    const organizationSlug = org?.slug;
    const exposureMode = app.exposureMode || 'local';
    const baseSubdomain = app.localSubdomain;
    const urlSuffix = info.url_suffix || '';
    const hasDirectLocalAccess = exposureMode === 'local' || app.exposedLocal || app.openPort;

    // Build the app URL based on exposure mode
    let appUrl: string | undefined;
    if (exposureMode === 'local') {
      if (!app.port || !hasDirectLocalAccess) {
        return { available: false, appUrl: undefined, stage: 'error' };
      }

      const host = resolveBrowserHost(userSettings.internalIp);
      appUrl = `http://${host}:${app.port}${urlSuffix}`;
      return { available: true, appUrl, stage: 'ready' };
    }
    if (exposureMode === 'tailscale') {
      const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
      const tailscaleStatus = tailscaleService ? await tailscaleService.getStatus().catch(() => null) : null;
      const appPort = app.port ?? info.port ?? null;
      const vpnUrl =
        tailscaleStatus?.connected && tailscaleStatus.nodeFqdn ? buildTailscalePortUrl(tailscaleStatus.nodeFqdn, appPort, urlSuffix) : null;

      if (!vpnUrl) {
        return {
          available: false,
          appUrl: undefined,
          stage: 'error',
          errorCode: 'TAILSCALE_NOT_READY',
          detail: 'Tailscale is not connected or this app does not have a published Private VPN port yet.',
          resolvable: true,
        };
      }

      appUrl = vpnUrl;
    } else {
      const cloudflareClient = this.moduleRef.get(CloudflareClientService, { strict: false });
      const hasTunnelToken = Boolean(
        cloudflareClient && typeof cloudflareClient.getTunnelToken === 'function' ? cloudflareClient.getTunnelToken() : null,
      );
      if (!hasTunnelToken && app.port && hasDirectLocalAccess) {
        const host = resolveBrowserHost(userSettings.internalIp);
        appUrl = `http://${host}:${app.port}${urlSuffix}`;
        return { available: true, appUrl, stage: 'ready' };
      }

      const resolvedDomain = app.publicDomain?.trim() || userSettings.domain;
      if (!organizationSlug || !resolvedDomain) {
        return { available: false, appUrl, stage: 'error' };
      }

      if (!org?.hubSubdomain) {
        return {
          available: false,
          appUrl: undefined,
          stage: 'error',
          errorCode: 'NO_DEVICE_REGISTRATION',
          detail: 'Device not registered with an organization.',
          resolvable: false,
        };
      }

      const identity = buildPublicWebIdentity({
        appSubdomain: baseSubdomain || `${app.appName}-${app.appStoreSlug}`,
        hubSubdomain: org.hubSubdomain,
        orgSlug: organizationSlug,
        publicDomainRoot: resolvedDomain,
      });
      appUrl = `${identity.publicUrl}${urlSuffix}`;
    }

    // Helper to determine stage from error code
    const propagatingCodes = new Set(['DNS_NOT_FOUND', 'CF_TUNNEL_NOT_FOUND', 'CF_UPSTREAM_ERROR', 'CF_ORIGIN_DOWN']);

    try {
      const response = await axios.get(appUrl, { timeout: 5000, validateStatus: () => true });
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const isCloudflare = text.includes('Cloudflare Ray ID') || text.includes('cf-error-details');

      if (exposureMode === 'cloudflare' && isCloudflare) {
        const cfErrorMatch = text.match(/Error\s+(\d{3,4})/i);
        const cfCode = cfErrorMatch ? Number(cfErrorMatch[1]) : response.status;

        // Cloudflare 1033 = Argo Tunnel not found
        if (cfCode === 1033) {
          return {
            available: false,
            appUrl,
            stage: 'propagating',
            reason: 'CLOUDFLARE',
            errorCode: 'CF_TUNNEL_NOT_FOUND',
            detail: 'Tunnel route not configured for this app. DNS or tunnel config may be out of sync.',
            resolvable: true,
          };
        }

        // 502/503/504 = upstream unreachable
        if ([502, 503, 504].includes(cfCode) || [502, 503, 504].includes(response.status)) {
          return {
            available: false,
            appUrl,
            stage: 'propagating',
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
            appUrl,
            stage: 'propagating',
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
            appUrl,
            stage: 'error',
            reason: 'CLOUDFLARE',
            errorCode: 'CF_TIMEOUT',
            detail: 'Connection to the app timed out through Cloudflare. The tunnel or app may be overloaded.',
            resolvable: true,
          };
        }

        return {
          available: false,
          appUrl,
          stage: 'error',
          reason: 'CLOUDFLARE',
          errorCode: 'CF_UNKNOWN',
          detail: cfErrorMatch ? `Cloudflare Error ${cfErrorMatch[1]}` : `Cloudflare Error (HTTP ${response.status})`,
          resolvable: false,
        };
      }

      // Any non-Cloudflare HTTP response means the app is reachable
      return { available: true, appUrl, httpStatus: response.status, stage: 'ready' };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'UNKNOWN_ERROR';

      // DNS resolution failure
      if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
        const errorCode = 'DNS_NOT_FOUND';
        return {
          available: false,
          appUrl,
          stage: propagatingCodes.has(errorCode) ? 'propagating' : 'error',
          reason: 'NETWORK_ERROR',
          errorCode,
          detail:
            exposureMode === 'cloudflare'
              ? 'DNS record not found. The domain may not be synced with Cloudflare yet.'
              : exposureMode === 'tailscale'
                ? 'DNS resolution failed. Tailscale may not be serving this app yet.'
                : 'DNS resolution failed. The domain configuration may need updating.',
          resolvable: true,
        };
      }

      // Connection refused = nothing listening on that port
      if (message.includes('ECONNREFUSED')) {
        return {
          available: false,
          appUrl,
          stage: 'error',
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
          appUrl,
          stage: 'error',
          reason: 'NETWORK_ERROR',
          errorCode: 'CONNECTION_TIMEOUT',
          detail: 'Connection timed out reaching the app.',
          resolvable: false,
        };
      }

      return {
        available: false,
        appUrl,
        stage: 'error',
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

    const { app } = await this.appsReadService.getApp(appUrn);
    if (!app) {
      return { success: false, action: 'none', detail: 'App not found.' };
    }

    const exposureMode = app.exposureMode || 'local';
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

          // The sync may well have repaired the Hub's OWN public route, not just
          // this app's. Drop the cached tunnel verdict so the connect surfaces
          // re-evaluate immediately instead of serving up to a minute of stale
          // pessimism and needlessly offering the LAN fallback.
          //
          // Imported dynamically, like AppLifecycleService above: a static import
          // would close a require cycle through docker.service and leave this
          // module's DI tokens undefined at decoration time.
          //
          // Guarded: ModuleRef.get THROWS when a provider cannot be resolved (it
          // does not return undefined), and this is a best-effort cache hint — an
          // unresolvable TunnelHealthService must not abort the repair actions
          // that follow, nor turn a successful re-sync into an error verdict.
          try {
            const { TunnelHealthService } = await import('../cloudflare/tunnel-health.service');

            this.moduleRef.get<TunnelHealthServiceType>(TunnelHealthService, { strict: false }).invalidate();
          } catch (e) {
            this.logger.debug(`Could not invalidate the tunnel health cache after re-sync: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // For Tailscale errors: re-add serve entry
      if (exposureMode === 'tailscale' && (check.errorCode === 'CONNECTION_REFUSED' || check.errorCode === 'PROXY_UPSTREAM_ERROR')) {
        const { AppLifecycleService } = await import('../app-lifecycle/app-lifecycle.service');
        const lifecycleService = this.moduleRef.get(AppLifecycleService, { strict: false });
        if (lifecycleService) {
          await lifecycleService.syncExposurePublic();
          actions.push('Re-synced Private VPN publishing');
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
