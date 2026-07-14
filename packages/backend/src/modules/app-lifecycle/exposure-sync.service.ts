import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity } from '@ci-hub/common/types';
import { AppsRepository } from '../apps/apps.repository';
import { AppFilesManager } from '../apps/app-files-manager';
import { publishesCloudflarePublicRoute, type AppPublicRoutingSnapshot } from '../apps/app-public-routing.helpers';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { CloudflareClientService, AppInfo, type PublicDnsFailure, type PublicDnsFailureReason } from '../cloudflare/cloudflare-client.service';
import { DockerService } from '../docker/docker.service';
import { RegistrationService } from '../registration/registration.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { hasRestoreIntent, readRehydrationState } from './registration-recovery-state';

function buildPublicHostname(params: { appSubdomain: string; hubSubdomain?: string | null; orgSlug?: string | null; publicDomainRoot: string }) {
  return buildPublicWebIdentity({
    appSubdomain: params.appSubdomain,
    hubSubdomain: params.hubSubdomain,
    orgSlug: params.orgSlug,
    publicDomainRoot: params.publicDomainRoot,
  }).hostname;
}

/** An app that failed public-DNS sync, plus why, so the toast can say which. */
type PublicDnsToastTarget = { appUrn: AppUrn; hostname: string; reason?: PublicDnsFailureReason };

/**
 * Turn CI-Cloud's per-app failure detail into an operator-facing explanation.
 *
 * Without it every failure read as a domain/zone problem, which is what sent the
 * investigation in CI-Portal#403 down the wrong path: the real cause was a DNS
 * record CI-Cloud refused to overwrite. Falls back to the old wording when the
 * Portal is older and sends no detail.
 */
function describePublicDnsFailures(failures: PublicDnsFailure[]): string {
  if (failures.length === 0) {
    return "verify the selected domain's zone is provisioned in CI-Cloud for this device.";
  }

  return failures
    .map((failure) => {
      switch (failure.reason) {
        case 'conflict':
          return `${failure.app}: the address is already claimed by another device or tunnel and CI-Cloud will not overwrite it (${failure.message ?? 'no detail'})`;
        case 'zone_unreachable':
          return `${failure.app}: the selected domain is not provisioned for this device in CI-Cloud (${failure.message ?? 'no detail'})`;
        case 'invalid_subdomain':
          return `${failure.app}: the requested subdomain is not a valid DNS label (${failure.message ?? 'no detail'})`;
        default:
          return `${failure.app}: Cloudflare rejected the DNS write, usually transient (${failure.message ?? 'no detail'})`;
      }
    })
    .join('; ');
}

@Injectable()
export class ExposureSyncService {
  private lastPublicDnsFailureReportAt = 0;
  private readonly lastPublicDnsToastAt = new Map<string, number>();
  private static readonly PUBLIC_DNS_FAILURE_COOLDOWN_MS = 5 * 60_000;

  private readonly lastTailscaleServeToastAt = new Map<string, number>();
  private static readonly TAILSCALE_SERVE_FAILURE_COOLDOWN_MS = 5 * 60_000;

  constructor(
    private readonly logger: LoggerService,
    private readonly appRepository: AppsRepository,
    private readonly config: ConfigurationService,
    private readonly sseService: SSEService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly registrationService: RegistrationService,
    private readonly dockerService: DockerService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly errorReportingService?: ErrorReportingService,
  ) {}

  /**
   * Sync exposure state for all apps — Cloudflare + Tailscale in parallel
   */
  private async syncExposure(options?: { excludeAppUrns?: AppUrn[] }) {
    await Promise.allSettled([this.triggerCloudflareSync(options), this.triggerTailscaleSync()]);
  }

  /**
   * When public routing identity changes, CI-Cloud only deletes stale DNS when the
   * app's previous slug disappears from the sync payload. Sync once without the
   * reconfigured app so the old record is released, then sync the full state.
   */
  async syncExposureAfterRoutingChange(appUrn: AppUrn, routingChanged: boolean) {
    if (routingChanged) {
      this.logger.info(`[Cloudflare] Public routing changed for ${appUrn} — releasing previous DNS before applying new hostname`);
      await this.syncExposure({ excludeAppUrns: [appUrn] });
    }
    await this.syncExposure();
  }

  /**
   * Public wrapper for syncExposure — used by AppsService.resolveAppAvailability
   */
  public async syncExposurePublic(options?: { excludeAppUrns?: AppUrn[] }) {
    return this.syncExposure(options);
  }

  /** Reconcile Tailscale Serve for all Private VPN apps (no Cloudflare sync). */
  public async syncTailscaleExposurePublic() {
    return this.triggerTailscaleSync();
  }

  /**
   * Sync Tailscale Serve state for apps with exposureMode='tailscale'
   */
  private async triggerTailscaleSync() {
    try {
      const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
      if (!tailscaleService) return;

      const status = await tailscaleService.getStatus().catch(() => null);
      if (!status?.connected) return;

      const apps = await this.appRepository.getApps();

      // Apps that should be Tailscale-served
      const shouldServe = apps.filter(
        (app) => (app as Record<string, unknown>).exposureMode === 'tailscale' && ['running', 'starting', 'restarting'].includes(app.status),
      );

      const serveStatus = await tailscaleService.getServeStatus();
      const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
      const desiredPorts = new Map<
        number,
        {
          appName: string;
          appUrn: AppUrn;
          port: number;
          upstreamUrl: string;
        }
      >();

      for (const app of shouldServe) {
        if (!app.port) {
          this.logger.error(`[Tailscale] Skipping ${app.appName}:${app.appStoreSlug}: missing app port for Private VPN publishing`);
          continue;
        }

        const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;
        const installedInfo = appFilesManager ? await appFilesManager.getInstalledAppInfo(appUrn) : null;

        let upstreamUrl: string | null = null;
        if (installedInfo && isPortExposeApp(installedInfo)) {
          const upstreamPort = installedInfo.upstreamPort ?? installedInfo.port ?? app.port;
          upstreamUrl = `http://host.docker.internal:${upstreamPort}`;
        } else {
          const target = await this.dockerService.getAppNetworkTarget(appUrn);
          if (!target) {
            this.logger.error(`[Tailscale] Skipping ${appUrn}: no running network target found for Private VPN publishing`);
            continue;
          }
          upstreamUrl = target.url;
        }

        desiredPorts.set(app.port, {
          appName: app.localSubdomain || app.appName,
          appUrn,
          port: app.port,
          upstreamUrl,
        });
      }

      const currentlyServedByPort = new Map(
        serveStatus.entries.filter((entry) => entry.listenPort).map((entry) => [entry.listenPort as number, entry]),
      );

      for (const desired of desiredPorts.values()) {
        const currentEntry = currentlyServedByPort.get(desired.port);
        if (!currentEntry || currentEntry.dest !== desired.upstreamUrl || currentEntry.mountPoint !== '/') {
          await tailscaleService
            .serveApp({
              appName: desired.appName,
              httpsPort: desired.port,
              upstreamUrl: desired.upstreamUrl,
            })
            .catch((e) => this.surfaceTailscaleServeFailure(desired.appUrn, e));
        }
      }

      for (const served of serveStatus.entries) {
        if (served.rawServiceName) {
          await tailscaleService
            .clearService(served.rawServiceName)
            .catch((e) => this.logger.error(`[Tailscale] Failed to clear ${served.rawServiceName}: ${e}`));
          continue;
        }

        const listenPort = served.listenPort;
        if (!listenPort || desiredPorts.has(listenPort)) {
          continue;
        }

        await tailscaleService.unservePort(listenPort).catch((e) => this.logger.error(`[Tailscale] Failed to unserve :${listenPort}: ${e}`));
      }

      this.logger.debug(`[Tailscale] Sync complete: ${desiredPorts.size} apps served`);
    } catch (error) {
      this.logger.error(`[Tailscale] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Surface a public-DNS sync failure so it is never silent: always logs an
   * error, reports to Sentry, and emits a per-app SSE event the frontend turns
   * into a toast. Sentry and toasts are cooldown-guarded to avoid flooding when
   * availability remediation re-triggers the sync for a still-broken app.
   */
  private surfacePublicDnsFailure(message: string, failedAppNames: string[], toastTargets: PublicDnsToastTarget[] = []): void {
    this.logger.error(message);

    const now = Date.now();
    if (now - this.lastPublicDnsFailureReportAt >= ExposureSyncService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
      this.lastPublicDnsFailureReportAt = now;
      this.errorReportingService?.captureMessage(message, 'error', { failedApps: failedAppNames });
    }

    for (const target of toastTargets) {
      const lastToast = this.lastPublicDnsToastAt.get(target.appUrn) ?? 0;
      if (now - lastToast < ExposureSyncService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
        continue;
      }
      this.lastPublicDnsToastAt.set(target.appUrn, now);
      // `errorCode` carries the failure class so the frontend can say what is
      // actually wrong rather than always blaming the domain (CI-Portal#403).
      this.sseService.emit(
        'app',
        { event: 'public_dns_error', appUrn: target.appUrn, error: target.hostname, errorCode: target.reason },
        target.appUrn,
      );
    }
  }

  /**
   * Surface a Tailscale Serve failure so Private VPN publishing is never silent.
   * Always logs the error; when the failure is because HTTPS/Serve is not enabled
   * on the tailnet (an account-wide setting the Hub cannot toggle), it also emits
   * a per-app SSE event the frontend turns into a toast with the enable link.
   * Cooldown-guarded so repeated syncs for a still-broken app don't flood toasts.
   */
  private surfaceTailscaleServeFailure(appUrn: AppUrn, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`[Tailscale] Failed to serve ${appUrn}: ${message}`);

    // Tailscale returns this when HTTPS Certificates / Serve are not enabled for
    // the tailnet. This is the only serve failure the user can fix themselves.
    const serveNotEnabled = /serve is not enabled|not enabled on your tailnet|HTTPS.*not enabled/i.test(message);
    if (!serveNotEnabled) {
      return;
    }

    const now = Date.now();
    const lastToast = this.lastTailscaleServeToastAt.get(appUrn) ?? 0;
    if (now - lastToast < ExposureSyncService.TAILSCALE_SERVE_FAILURE_COOLDOWN_MS) {
      return;
    }
    this.lastTailscaleServeToastAt.set(appUrn, now);
    this.sseService.emit('app', { event: 'tailscale_serve_error', appUrn }, appUrn);
  }

  public async triggerCloudflareSync(options?: { excludeAppUrns?: AppUrn[] }) {
    try {
      if (await hasRestoreIntent()) {
        const rehydrationState = await readRehydrationState();
        if (!rehydrationState?.completedAt) {
          this.logger.debug('[Cloudflare] Skipping sync during device restore until rehydration completes');
          return;
        }
      }

      const orgInfo = await this.registrationService.getDeviceRegistrationInfo();

      if (!orgInfo) {
        this.logger.debug('[Cloudflare] Skipping sync: Organization not registered');
        return;
      }

      if (!orgInfo.tunnelId) {
        this.logger.warn(
          `[Cloudflare] Skipping sync: Organization ${orgInfo.id} exists but has no tunnelId. Please complete device registration to provision tunnel.`,
        );
        return;
      }

      const apps = await this.appRepository.getApps();
      const userSettings = this.config.getConfig().userSettings;
      const defaultPublicDomain = userSettings.domain || this.config.getConfig().domain;
      const localDomain = userSettings.localDomain || this.config.getConfig().localDomain;

      type AppFromDb = Awaited<ReturnType<AppsRepository['getApps']>>[number];
      const exclude = new Set(options?.excludeAppUrns ?? []);

      const exposedApps: AppInfo[] = await Promise.all(
        apps
          .filter((app: AppFromDb) => {
            const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;
            if (exclude.has(appUrn)) {
              return false;
            }
            return publishesCloudflarePublicRoute(app as AppPublicRoutingSnapshot) && ['running', 'starting', 'restarting'].includes(app.status);
          })
          .map(async (app: AppFromDb) => {
            const subdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;
            const appPublicDomain = app.publicDomain || defaultPublicDomain;
            return {
              name: app.appName,
              subdomain,
              publicDomain: appPublicDomain,
              localPort: 80,
              protocol: 'http' as const,
              hostname: 'traefik',
              originServerName: buildOriginServerName({
                appSubdomain: subdomain,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                localDomain,
              }),
            };
          }),
      );

      // Include the Hub in every sync so CI-Cloud preserves its tunnel route.
      // `hubSubdomain` (from device_registration) is the canonical source for Hub route identity.
      // Do NOT use `DOMAIN` / `userSettings.domain` to derive the Hub subdomain — DOMAIN is the
      // root domain for app hostname construction, not the Hub prefix.
      // When hubSubdomain is null (e.g. pre-migration records), the Hub entry is omitted from sync.
      const hubSub = orgInfo.hubSubdomain;
      if (hubSub && defaultPublicDomain) {
        const orgSlug = orgInfo.slug;
        const orgSuffix = `-${orgSlug}`;
        const deviceName = hubSub.endsWith(orgSuffix) ? hubSub.slice(0, -orgSuffix.length) : hubSub;
        const hubHostname = `${hubSub}.${defaultPublicDomain}`;

        exposedApps.unshift({
          name: 'OS Hub',
          subdomain: deviceName,
          publicDomain: defaultPublicDomain,
          localPort: 80,
          protocol: 'http' as const,
          hostname: 'traefik',
          originServerName: hubHostname,
          privilegedKind: 'hub',
        });
      }

      const result = await this.cloudflareClientService.syncState(orgInfo.id, exposedApps, orgInfo.tunnelId || undefined);

      const appEntries = exposedApps.filter((entry) => entry.privilegedKind !== 'hub');

      if (!result.ok) {
        // A full sync failure means none of the exposed apps were updated, so
        // raise a per-app toast for every exposed app — not only the partial
        // per-app failures handled below. Without this, full failures (e.g.
        // CI-Cloud unreachable / non-success response) would be silent in the
        // UI. Cooldowns in surfacePublicDnsFailure prevent flooding on repeated
        // syncs.
        const toastTargets = appEntries
          .map((entry) => {
            const dbApp = apps.find((candidate: AppFromDb) => candidate.appName === entry.name);
            if (!dbApp) {
              return null;
            }
            return {
              appUrn: `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn,
              hostname: buildPublicHostname({
                appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
              }),
            };
          })
          .filter((target): target is { appUrn: AppUrn; hostname: string } => target !== null);
        this.surfacePublicDnsFailure(
          `[Cloudflare] State sync did not complete — public DNS was not updated for ${appEntries.length} exposed app(s).`,
          appEntries.map((entry) => entry.name),
          toastTargets,
        );
      } else if (result.failed.length > 0) {
        // Map CI-Cloud's failed app names back to their URN + hostname so the
        // frontend can raise a per-app toast (privileged Hub entry excluded).
        const toastTargets = result.failed
          .map((name): PublicDnsToastTarget | null => {
            const dbApp = apps.find((candidate: AppFromDb) => candidate.appName === name);
            const entry = exposedApps.find((candidate) => candidate.name === name && candidate.privilegedKind !== 'hub');
            if (!dbApp || !entry) {
              return null;
            }
            return {
              appUrn: `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn,
              hostname: buildPublicHostname({
                appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
                hubSubdomain: orgInfo.hubSubdomain,
                orgSlug: orgInfo.slug,
                publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
              }),
              // Absent when CI-Cloud predates structured failures; the frontend
              // then falls back to the generic message.
              reason: result.failures.find((failure) => failure.app === name)?.reason,
            };
          })
          .filter((target): target is PublicDnsToastTarget => target !== null);
        const failedHostnames = toastTargets.map((target) => target.hostname);
        this.surfacePublicDnsFailure(
          `[Cloudflare] Public DNS records were NOT created for ${result.failed.length} app(s): ${(failedHostnames.length > 0 ? failedHostnames : result.failed).join(', ')}. ` +
            `These apps will not resolve at their public domain — ${describePublicDnsFailures(result.failures)}`,
          result.failed,
          toastTargets,
        );
      } else if (appEntries.length > 0) {
        // Only log success once the sync fully completed (ok and no per-app
        // failures); otherwise the failure branches above own the messaging.
        this.logger.info(
          `[Cloudflare] Public hostnames synced: ${appEntries
            .map(
              (entry) =>
                `${entry.name} -> ${buildPublicHostname({
                  appSubdomain: entry.subdomain,
                  hubSubdomain: orgInfo.hubSubdomain,
                  orgSlug: orgInfo.slug,
                  publicDomainRoot: entry.publicDomain || defaultPublicDomain,
                })}`,
            )
            .join(', ')}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`[Cloudflare] Sync failed: ${error.message}`);
      } else {
        this.logger.error(`[Cloudflare] Sync failed: ${String(error)}`);
      }
    }
  }
}
