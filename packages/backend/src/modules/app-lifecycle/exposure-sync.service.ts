import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, indexCustomDomainsByTarget } from '@ci-hub/common/types';
import type { TunnelCustomDomain } from '@ci-hub/common/types';
import { AppsRepository } from '../apps/apps.repository';
import { AppFilesManager } from '../apps/app-files-manager';
import { publishesCloudflarePublicRoute, type AppPublicRoutingSnapshot } from '../apps/app-public-routing.helpers';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { CloudflareClientService, AppInfo, type PublicDnsFailure, type PublicDnsFailureReason } from '../cloudflare/cloudflare-client.service';
import { DockerReadFacade } from '../docker/docker-read.facade';
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
 * Index entries by a string key, first occurrence winning — the same entry a
 * linear `find` would have returned, but O(1) per lookup instead of O(n).
 */
function indexByFirst<T>(entries: readonly T[], key: (entry: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of entries) {
    const entryKey = key(entry);
    if (!index.has(entryKey)) {
      index.set(entryKey, entry);
    }
  }
  return index;
}

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

  /**
   * HTTPS port the Hub itself is served on over the tailnet — 443, so the
   * resulting origin is a bare `https://<nodeFqdn>` (what
   * `buildHubTailnetOrigin` advertises). App serve ports are the apps' own
   * high ports, so a clash is a misconfiguration — resolved in the Hub's
   * favour: the tailnet origin is load-bearing for the whole connect
   * ceremony and is advertised without knowledge of serve state, so leaving
   * it unserved would hand every VPN caller a dead launcher, while the
   * evicted app just needs its port changed.
   */
  private static readonly HUB_VPN_PORT = 443;

  constructor(
    private readonly logger: LoggerService,
    private readonly appRepository: AppsRepository,
    private readonly config: ConfigurationService,
    private readonly sseService: SSEService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly registrationService: RegistrationService,
    private readonly dockerReadFacade: DockerReadFacade,
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
          /** Absent for the Hub's own entry — failures then log instead of raising a per-app toast. */
          appUrn?: AppUrn;
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
          const target = await this.dockerReadFacade.getAppNetworkTarget(appUrn);
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

      // The Hub itself is published at `https://<nodeFqdn>/` (port 443) whenever
      // the VPN is up — without this, the Private VPN exposes apps but not the
      // Hub, and the memory-connect/login ceremony has no tailnet origin to land
      // on (CI-Engineering#78). Registered like any other desired port so the
      // reconcile loop below keeps it alive and never garbage-collects it. An
      // app configured on 443 is evicted (see HUB_VPN_PORT for why the Hub
      // wins) — loudly, with the remedy, since its Private VPN URL stays dead
      // until its port changes.
      const clashingApp = desiredPorts.get(ExposureSyncService.HUB_VPN_PORT);
      if (clashingApp) {
        this.logger.error(
          `[Tailscale] ${clashingApp.appUrn}: port ${ExposureSyncService.HUB_VPN_PORT} is reserved for the Hub's own Private VPN entry; ` +
            'skipping this app — assign it a different port to publish it on the Private VPN',
        );
      }
      desiredPorts.set(ExposureSyncService.HUB_VPN_PORT, {
        appName: 'hub',
        port: ExposureSyncService.HUB_VPN_PORT,
        upstreamUrl: await tailscaleService.getHubServeUpstream(),
      });

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
            .catch((e) =>
              desired.appUrn
                ? this.surfaceTailscaleServeFailure(desired.appUrn, e)
                : this.logger.error(`[Tailscale] Failed to publish the Hub on the Private VPN: ${e instanceof Error ? e.message : String(e)}`),
            );
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

        const hubListenPort = Number.parseInt(process.env.API_PORT || '5002', 10) || 5002;
        exposedApps.unshift({
          name: 'OS Hub',
          subdomain: deviceName,
          publicDomain: defaultPublicDomain,
          localPort: 80,
          protocol: 'http' as const,
          hostname: 'traefik',
          originServerName: hubHostname,
          privilegedKind: 'hub',
          hubListenPort,
        });
      }

      const result = await this.cloudflareClientService.syncState(orgInfo.id, exposedApps, orgInfo.tunnelId || undefined);

      const appEntries = exposedApps.filter((entry) => entry.privilegedKind !== 'hub');

      // Both failure branches below map app names back to their DB row (and, in the
      // partial-failure branch, to their exposed entry and failure reason). Doing
      // that with `find` is a full scan per failed app; a Hub can run dozens of
      // apps, so index once and look up in O(1).
      const dbAppByName = indexByFirst(apps, (candidate: AppFromDb) => candidate.appName);

      // The DB row is all that is needed to name an app's public record. Both failure
      // branches and the failure log derive the hostname from here, so none of them
      // can drift on how a public record is named.
      const toPublicHostname = (dbApp: AppFromDb): string =>
        buildPublicHostname({
          appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
          hubSubdomain: orgInfo.hubSubdomain,
          orgSlug: orgInfo.slug,
          publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
        });

      const toToastTarget = (dbApp: AppFromDb): PublicDnsToastTarget => ({
        appUrn: `${dbApp.appName}:${dbApp.appStoreSlug}` as AppUrn,
        hostname: toPublicHostname(dbApp),
      });

      // Only a sync that COMPLETED may change bindings: a failed one delivered
      // nothing, and reading that as "no domains" would unbind every app that is
      // serving on one. The failure branches below own everything else.
      if (result.ok) {
        await this.reconcileCustomDomains({
          apps,
          syncedAppNames: new Set(appEntries.map((entry) => entry.name)),
          customDomains: result.customDomains,
          toPublicHostname,
        });
      }

      if (!result.ok) {
        // A full sync failure means none of the exposed apps were updated, so
        // raise a per-app toast for every exposed app — not only the partial
        // per-app failures handled below. Without this, full failures (e.g.
        // CI-Cloud unreachable / non-success response) would be silent in the
        // UI. Cooldowns in surfacePublicDnsFailure prevent flooding on repeated
        // syncs.
        const toastTargets = appEntries
          .map((entry) => {
            const dbApp = dbAppByName.get(entry.name);
            if (!dbApp) {
              return null;
            }
            return toToastTarget(dbApp);
          })
          .filter((target): target is PublicDnsToastTarget => target !== null);
        const cause = [result.errorStatus && `HTTP ${result.errorStatus}`, result.errorMessage].filter(Boolean).join(': ');
        this.surfacePublicDnsFailure(
          `[Cloudflare] State sync did not complete — public DNS was not updated for ${appEntries.length} exposed app(s).${
            cause ? ` Cause: ${cause}.` : ''
          }`,
          appEntries.map((entry) => entry.name),
          toastTargets,
        );
      } else if (result.failed.length > 0) {
        // Map CI-Cloud's failed app names back to their URN + hostname so the
        // frontend can raise a per-app toast (privileged Hub entry excluded — it is
        // absent from appEntries, so an unmatched name is skipped).
        const exposedByName = indexByFirst(appEntries, (entry) => entry.name);
        const failureByApp = indexByFirst(result.failures, (failure) => failure.app);

        const toastTargets = result.failed
          .map((name): PublicDnsToastTarget | null => {
            const dbApp = dbAppByName.get(name);
            if (!dbApp || !exposedByName.has(name)) {
              return null;
            }
            return {
              ...toToastTarget(dbApp),
              // Absent when CI-Cloud predates structured failures; the frontend
              // then falls back to the generic message.
              reason: failureByApp.get(name)?.reason,
            };
          })
          .filter((target): target is PublicDnsToastTarget => target !== null);

        // Name EVERY failed app: its hostname where we could rebuild one, else the
        // raw name CI-Cloud sent. Listing only the mapped hostnames dropped any app
        // that has no toast target — one with no DB row, or the privileged Hub entry,
        // which is deliberately absent from appEntries — so the log claimed N apps and
        // then named fewer, and the missing ones were exactly the ones an operator had
        // no other way to find. A message that hides which app broke is the failure
        // this PR exists to fix.
        const failedLabels = result.failed.map((name) => {
          const dbApp = dbAppByName.get(name);

          return dbApp ? toPublicHostname(dbApp) : name;
        });

        this.surfacePublicDnsFailure(
          `[Cloudflare] Public DNS records were NOT created for ${result.failed.length} app(s): ${failedLabels.join(', ')}. ` +
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

  /**
   * Mirror the custom hostnames CI-Cloud actually wired onto the app rows they
   * belong to, so env generation can emit the hostname the browser really
   * arrives on instead of the platform one.
   *
   * The join key is the app's own platform hostname: CI-Cloud composes
   * `targetHostname` with the same `<app>-<hub>-<org>.<root>` convention
   * `buildPublicWebIdentity` does, so no new identifier is needed on either side.
   *
   * ⚠ WHAT THIS DELIBERATELY DOES NOT DO IS RESTART ANYTHING. The bound hostname
   * is an env var, so the app's compose env is stale the moment it changes — but
   * recreating a running container underneath a user because a background
   * heartbeat came back is not an acceptable way to deliver that. The row is
   * flagged `pendingRestart` instead, which is the same badge a settings change
   * raises, and the restart the user chooses regenerates the env.
   */
  private async reconcileCustomDomains(params: {
    apps: Awaited<ReturnType<AppsRepository['getApps']>>;
    /** App names that were in THIS sync's payload — see the skip rule below. */
    syncedAppNames: Set<string>;
    customDomains: TunnelCustomDomain[] | undefined;
    toPublicHostname: (app: Awaited<ReturnType<AppsRepository['getApps']>>[number]) => string;
  }): Promise<void> {
    /*
     * ABSENT IS NOT EMPTY. A CI-Cloud predating custom domains sends no
     * `customDomains` field at all; treating that as "none delivered" would
     * unbind every app that is serving happily on a custom hostname the moment a
     * Hub talks to an older Portal. Only an array that was actually sent — even
     * an empty one — is allowed to change anything.
     */
    if (params.customDomains === undefined) {
      return;
    }

    const byTarget = indexCustomDomainsByTarget(params.customDomains);

    for (const app of params.apps) {
      const current = app.customDomain ?? null;
      let next: string | null;

      if (!publishesCloudflarePublicRoute(app as AppPublicRoutingSnapshot)) {
        // Not publicly routed at all any more. Its binding cannot be delivered
        // by definition, so drop it — this is durable configuration, not a
        // transient absence from one payload.
        next = null;
      } else if (params.syncedAppNames.has(app.appName)) {
        // Lowercased on both sides: DNS is case-insensitive, but the Hub composes
        // its hostname from an organization slug it stores verbatim, which a
        // rename can leave with uppercase in it.
        next = byTarget.get(params.toPublicHostname(app).trim().toLowerCase()) ?? null;
      } else {
        /*
         * Published, but absent from this payload — it is stopped, or was
         * deliberately excluded for a release pass. CI-Cloud only reports a
         * domain as delivered when it produced an ingress rule, and it cannot
         * produce one for an app it was not told about, so "not in the array"
         * here means "not asked about", NOT "unbound".
         *
         * Clearing on that would flap: stopping an app would unbind it, starting
         * it would generate its env without the custom hostname, and the sync
         * that follows the start would rebind and demand a second restart.
         */
        continue;
      }

      if (next === current) {
        continue;
      }

      const appUrn = `${app.appName}:${app.appStoreSlug}` as AppUrn;

      await this.appRepository.updateAppById(app.id, { customDomain: next, pendingRestart: true });
      this.logger.info(
        next
          ? `[Cloudflare] ${appUrn} is now served on custom domain ${next}; restart it to publish that hostname to the app.`
          : `[Cloudflare] Custom domain ${current} is no longer wired for ${appUrn}; restart it to revert to its platform hostname.`,
      );
      this.sseService.emit('app', { event: 'custom_domain_changed', appUrn }, appUrn);
    }
  }
}
