import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SSEService } from '@/core/sse/sse.service';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import {
  buildOriginServerName,
  buildPublicWebIdentity,
  collectAmbiguousCustomDomains,
  indexCustomDomainsByTarget,
  normalizeHostname,
  normalizeStoredHostname,
  selectCustomDomain,
} from '@ci-hub/common/types';
import type { TunnelCustomDomain } from '@ci-hub/common/types';
import { AppsRepository } from '../apps/apps.repository';
import { AppFilesManager } from '../apps/app-files-manager';
import {
  canServeOnCustomDomain,
  publishesCloudflarePublicRoute,
  resolveRoutingSubdomain,
  type AppPublicRoutingSnapshot,
} from '../apps/app-public-routing.helpers';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { CloudflareClientService, AppInfo, type PublicDnsFailure, type PublicDnsFailureReason } from '../cloudflare/cloudflare-client.service';
import { DockerReadFacade } from '../docker/docker-read.facade';
import { RegistrationService } from '../registration/registration.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { hasRestoreIntent, readRehydrationState } from './registration-recovery-state';

/** Options shared by every entry point into an exposure sync. */
export interface ExposureSyncOptions {
  /**
   * Apps to omit from this pass so Companion Portal releases their previous DNS.
   */
  excludeAppUrns?: AppUrn[];
  /**
   * Apps whose restart the caller has already taken responsibility for.
   *
   * `reconcileCustomDomains` recreates an app that lost its bound hostname,
   * because nothing else would. A caller that is mid-save is the exception: it
   * awaits this sync and then restarts the app itself, and a subdomain rename
   * reads here as a lost hostname — CI-Cloud still reports the binding against
   * the app's previous platform name. Without this the save would recreate the
   * container twice.
   */
  skipAutoRestartAppUrns?: AppUrn[];
}

function buildPublicHostname(params: { appSubdomain: string; hubSubdomain?: string | null; orgSlug?: string | null; publicDomainRoot: string }) {
  return buildPublicWebIdentity({
    appSubdomain: params.appSubdomain,
    hubSubdomain: params.hubSubdomain,
    orgSlug: params.orgSlug,
    publicDomainRoot: params.publicDomainRoot,
  }).hostname;
}

/** Identifies an app whose public DNS sync failed and the reason for its toast. */
type PublicDnsToastTarget = { appUrn: AppUrn; hostname: string; reason?: PublicDnsFailureReason };

/**
 * Indexes entries by a string key and retains the first occurrence.
 *
 * This ordering matches a linear `find` while reducing each lookup from O(n)
 * to O(1).
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
 * Converts Companion Portal's per-app failure details into an operator-facing
 * explanation.
 *
 * Distinguishing a DNS conflict from a domain or zone problem prevents operators
 * from investigating the wrong cause (CI-Portal#403). The generic wording remains
 * available when an older Portal sends no details.
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

  private readonly lastCustomDomainRestartAt = new Map<AppUrn, number>();
  /**
   * Floor on how often a single app may be recreated to follow its custom domain.
   *
   * The reconcile writes the row before it restarts, so a settled Portal cannot
   * ask twice — the second pass sees no change. This bounds the damage if one
   * ever does not settle: with exposure now re-synced on a timer, an alternating
   * answer would otherwise recreate the container on every tick. Ten minutes
   * still repairs the app well inside the window a person would take to notice,
   * while making a stuck flap cost one restart rather than a loop.
   */
  private static readonly CUSTOM_DOMAIN_RESTART_COOLDOWN_MS = 10 * 60_000;

  /**
   * Reverts whose restart could not be dispatched, to retry on a later pass.
   *
   * The reconcile settles the row before it asks for the restart, so once a
   * dispatch fails nothing else will ever notice that app: every later pass sees
   * `next === current` and returns early, leaving the container forwarding a
   * hostname the Hub has stopped serving.
   */
  private readonly failedCustomDomainReverts = new Set<AppUrn>();

  /** Cloudflare passes currently running. See {@link isCloudflareSyncInFlight}. */
  private cloudflareSyncDepth = 0;

  /**
   * Reserves HTTPS port 443 for the Hub on the tailnet.
   *
   * The resulting origin is the bare `https://<nodeFqdn>` advertised by
   * `buildHubTailnetOrigin`. Apps normally use their own high ports, so a clash
   * indicates a misconfiguration. The Hub wins because the tailnet origin
   * supports the entire connect flow and is advertised without serve-state
   * awareness. Leaving it unserved would give every VPN caller a dead launcher,
   * while the conflicting app can move to another port.
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
   * Synchronizes Cloudflare and Tailscale exposure for all apps in parallel.
   *
   * `Promise.allSettled` keeps one control plane available when the other fails;
   * each trigger owns its own diagnostics and recovery behavior.
   */
  private async syncExposure(options?: ExposureSyncOptions) {
    await Promise.allSettled([this.triggerCloudflareSync(options), this.triggerTailscaleSync()]);
  }

  /**
   * Synchronizes exposure after an app's public routing identity changes.
   *
   * Companion Portal deletes stale DNS only after the app's previous slug
   * disappears from the sync payload. A first sync without the reconfigured app
   * releases the old record, and a full sync applies the new identity.
   */
  async syncExposureAfterRoutingChange(appUrn: AppUrn, routingChanged: boolean) {
    /*
     * The caller restarts this app itself once the save completes, so the
     * custom-domain reconcile must not dispatch a second one. A rename moves the
     * app's platform hostname out from under a binding CI-Cloud still reports
     * against the old target, which reads there as "the hostname went away" —
     * true, but owned by the save rather than by this sync.
     */
    const callerOwnsRestart: ExposureSyncOptions = { skipAutoRestartAppUrns: [appUrn] };

    if (routingChanged) {
      this.logger.info(`[Cloudflare] Public routing changed for ${appUrn} — releasing previous DNS before applying new hostname`);
      await this.syncExposure({ ...callerOwnsRestart, excludeAppUrns: [appUrn] });
    }
    await this.syncExposure(callerOwnsRestart);
  }

  /**
   * Exposes full synchronization to `AppsService.resolveAppAvailability`.
   *
   * Keep this wrapper aligned with `syncExposure` so availability remediation can
   * release stale routes through the same exclusion option.
   */
  public async syncExposurePublic(options?: ExposureSyncOptions) {
    return this.syncExposure(options);
  }

  /**
   * Reconciles Tailscale Serve for all Private VPN apps without contacting
   * Companion Portal.
   *
   * Callers use this path when only local VPN state changed.
   */
  public async syncTailscaleExposurePublic() {
    return this.triggerTailscaleSync();
  }

  /**
   * Synchronizes Tailscale Serve for apps in `tailscale` exposure mode.
   *
   * A disconnected tailnet has no desired Serve state to apply, so this pass
   * returns without changing the last configuration.
   */
  private async triggerTailscaleSync() {
    try {
      const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
      if (!tailscaleService) return;

      const status = await tailscaleService.getStatus().catch(() => null);
      if (!status?.connected) return;

      const apps = await this.appRepository.getApps();

      // Publish only apps whose lifecycle state can accept traffic. Stopped apps
      // remain absent from the desired map so the cleanup loop removes their
      // obsolete Serve entries.
      const shouldServe = apps.filter(
        (app) => (app as Record<string, unknown>).exposureMode === 'tailscale' && ['running', 'starting', 'restarting'].includes(app.status),
      );

      const serveStatus = await tailscaleService.getServeStatus();
      const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
      const desiredPorts = new Map<
        number,
        {
          appName: string;
          /** Omitted for the Hub entry so failures log without raising an app toast. */
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

        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
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

      // Publish the Hub at `https://<nodeFqdn>/` on port 443 whenever the VPN is
      // connected. Otherwise, the Private VPN exposes apps without exposing the
      // Hub, leaving the Companion Memory connect and sign-in flow without a
      // tailnet return origin (CI-Engineering#78). Register the Hub like any
      // desired port so reconciliation keeps it alive. An app configured on 443
      // is evicted with a diagnostic because its Private VPN URL remains
      // unavailable until its port changes. See `HUB_VPN_PORT` for precedence.
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
   * Reports a public DNS sync failure through logs, Sentry, and per-app SSE.
   *
   * The frontend converts the SSE event into a toast. Cooldowns prevent Sentry
   * and toast floods when availability remediation repeats the sync for an app
   * that remains unavailable.
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
      // `errorCode` lets the frontend describe the actual failure class instead
      // of attributing every failure to the domain (CI-Portal#403).
      this.sseService.emit(
        'app',
        { event: 'public_dns_error', appUrn: target.appUrn, error: target.hostname, errorCode: target.reason },
        target.appUrn,
      );
    }
  }

  /**
   * Reports a Tailscale Serve failure for Private VPN publishing.
   *
   * Every failure reaches the log. If the tailnet has not enabled HTTPS or Serve,
   * an account-wide setting the Hub cannot change, a per-app SSE event also gives
   * the frontend enough context to show an enable link. A cooldown prevents
   * repeated syncs from flooding toasts while the app remains unavailable.
   */
  private surfaceTailscaleServeFailure(appUrn: AppUrn, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`[Tailscale] Failed to serve ${appUrn}: ${message}`);

    // Tailscale returns these messages when the tailnet has not enabled HTTPS
    // certificates or Serve. Users can resolve this class of Serve failure.
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
    // Omit the third `appUrn` argument because it publishes to `app:<urn>`, while
    // `sse.controller.ts` subscribes only to `getTopicObservable('app')`. Using
    // the per-app topic would prevent the browser from receiving the toast.
    this.sseService.emit('app', { event: 'tailscale_serve_error', appUrn });
  }

  /**
   * Whether a Cloudflare pass — and so a custom-domain reconcile — is running.
   *
   * Lets the background poll stand down while any other trigger is mid-pass,
   * rather than letting two reconciliations race for the same row.
   */
  public isCloudflareSyncInFlight(): boolean {
    return this.cloudflareSyncDepth > 0;
  }

  public async triggerCloudflareSync(options?: ExposureSyncOptions) {
    this.cloudflareSyncDepth += 1;
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

      const syncedDbApps = apps.filter((app: AppFromDb) => {
        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
        if (exclude.has(appUrn)) {
          return false;
        }
        return publishesCloudflarePublicRoute(app as AppPublicRoutingSnapshot) && ['running', 'starting', 'restarting'].includes(app.status);
      });

      /*
       * Track the apps this payload asks Companion Portal about, keyed by URN.
       *
       * Do not key this set by `appName`. The `app` table is unique on
       * `(app_name, app_store_slug)`, so two stores can ship an app named
       * `comfyui`, while the sync entries below carry only the name. A name-keyed
       * set would let a running app represent a stopped app from another store.
       * Custom-domain reconciliation would then treat the stopped app as queried
       * but absent from the response and incorrectly remove its binding.
       */
      const syncedAppUrns = new Set(syncedDbApps.map((app: AppFromDb) => createAppUrn(app.appName, app.appStoreSlug)));

      const exposedApps: AppInfo[] = syncedDbApps.map((app: AppFromDb) => {
        const subdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;
        return {
          name: app.appName,
          subdomain,
          publicDomain: app.publicDomain || defaultPublicDomain,
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
      });

      // Include the Hub in every sync so Companion Portal preserves its tunnel
      // route. `device_registration.hubSubdomain` is the canonical route identity.
      // `DOMAIN` and `userSettings.domain` provide the app-hostname root, not the
      // Hub prefix. Omit the Hub entry when older records have no `hubSubdomain`.
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

      // Both failure branches map app names to database rows. The partial-failure
      // branch also needs each exposed entry and failure reason. Index once to
      // avoid a full scan for every failure on Hubs that run many apps.
      const dbAppByName = indexByFirst(apps, (candidate: AppFromDb) => candidate.appName);

      // Derive each public record name from its database row in one place so both
      // failure branches and the failure log remain consistent.
      const toPublicHostname = (dbApp: AppFromDb): string =>
        buildPublicHostname({
          appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
          hubSubdomain: orgInfo.hubSubdomain,
          orgSlug: orgInfo.slug,
          publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
        });

      const toToastTarget = (dbApp: AppFromDb): PublicDnsToastTarget => ({
        appUrn: createAppUrn(dbApp.appName, dbApp.appStoreSlug),
        hostname: toPublicHostname(dbApp),
      });

      if (!result.ok) {
        // A full sync failure updates none of the exposed apps, so raise a toast
        // for each one instead of limiting notifications to the partial failures
        // below. Portal outages and unsuccessful responses must remain visible in
        // the UI. `surfacePublicDnsFailure` applies cooldowns to repeated syncs.
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
        // Map Companion Portal's failed app names to URNs and hostnames so the
        // frontend can raise per-app toasts. The privileged Hub entry is absent
        // from `appEntries`, so unmatched names are skipped.
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
              // Older Companion Portal versions omit structured failures, so the
              // frontend falls back to a generic message.
              reason: failureByApp.get(name)?.reason,
            };
          })
          .filter((target): target is PublicDnsToastTarget => target !== null);

        // Name every failed app by its reconstructed hostname or the raw name from
        // Companion Portal. Apps without a toast target include entries with no
        // database row and the privileged Hub entry, which `appEntries` excludes.
        // Listing only mapped hostnames would make the log count more failures
        // than it names and hide the entries operators cannot identify elsewhere.
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
        // Log success only after the request and every per-app operation complete.
        // The failure branches own all other messaging.
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

      /*
       * Reconcile bindings last and isolate the operation in its own try/catch.
       *
       * The preceding code reports the sync result. A database error during
       * reconciliation must not unwind through the per-app toasts and relabel a
       * partial sync as a total failure, because that would overstate the impact.
       *
       * Reconcile only after the request completes. A failed sync delivers no
       * domain state, and interpreting that absence as an empty set would unbind
       * every app using a custom hostname. An `ok` result with nonempty `failed`
       * remains valid: Companion Portal builds `customDomains` from generated
       * ingress rules before the DNS writes that populate `failed`. An app can
       * therefore retain a serving custom hostname even when its DNS write fails.
       */
      if (result.ok) {
        let deferredRevertAppUrns: AppUrn[] = [];
        try {
          deferredRevertAppUrns = await this.reconcileCustomDomains({
            apps,
            syncedAppUrns,
            customDomains: result.customDomains,
            toPublicHostname,
            skipAutoRestartAppUrns: new Set(options?.skipAutoRestartAppUrns ?? []),
          });
        } catch (error) {
          this.logger.error(`[Cloudflare] Custom-domain reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        /*
         * Ask Companion Portal about unfulfilled install-time choices only after
         * reconciliation.
         *
         * Reconciliation first recognizes intents the Portal has already
         * delivered and avoids redundant requests. Synchronization must also
         * precede binding because Companion Portal cannot wire a domain to an app
         * it has not learned about. The Hub records the choice during installation
         * and acts on it only after the sync registers the app.
         */
        try {
          await this.bindCustomDomainIntents({
            // Re-read because `reconcileCustomDomains` has updated `custom_domain`
            // on these rows. A stale snapshot would ask Companion Portal to wire
            // a domain it reported as delivered moments earlier.
            apps: await this.appRepository.getApps(),
            syncedAppUrns,
            organizationId: orgInfo.id,
            toPublicHostname,
            deferredRevertAppUrns: new Set(deferredRevertAppUrns),
          });
        } catch (error) {
          this.logger.error(`[Cloudflare] Custom-domain bind pass failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`[Cloudflare] Sync failed: ${error.message}`);
      } else {
        this.logger.error(`[Cloudflare] Sync failed: ${String(error)}`);
      }
    } finally {
      this.cloudflareSyncDepth -= 1;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * STOP SERVING A DOMAIN, ON BEHALF OF SOMEBODY WHO JUST SAID TO
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The counterpart to {@link bindCustomDomainIntents}. CI-Cloud PARKS the
   * domain — it clears the routing and the Cloudflare origin and leaves the row,
   * the ownership proof and the certificate alone — so the organization keeps
   * the domain and another bind points it somewhere else. Nothing here needs a
   * person in the Entri modal, and disconnecting a domain remains a portal act
   * no Hub path reaches.
   *
   * ⚠ STILL RUN WHERE THE INSTRUCTION WAS GIVEN, and not from the heartbeat.
   * Not because it is dangerous — it is reversible — but because it is an
   * ANSWER, not a convergence: only the save that cleared the picker knows the
   * operator asked for it, and the person who asked should be told whether it
   * worked. That is also why it takes the app row rather than scanning for
   * candidates; there is no such thing as a park this service should discover on
   * its own.
   *
   * Reports failure rather than throwing so the caller can leave the app exactly
   * as it was: a park that did not happen must not clear the binding locally, or
   * the app would stop publishing a hostname CI-Cloud is still serving.
   */
  public async releaseCustomDomain(
    app: Awaited<ReturnType<AppsRepository['getApps']>>[number],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const appUrn = createAppUrn(app.appName, app.appStoreSlug);
    const current = normalizeStoredHostname(app.customDomain);

    if (!current) {
      // Nothing is bound, so there is nothing to give up. Not an error: this is
      // the ordinary case of clearing a picker that was never satisfied.
      return { ok: true };
    }

    const orgInfo = await this.registrationService.getDeviceRegistrationInfo();

    if (!orgInfo?.id) {
      return { ok: false, message: 'This Hub is not registered with CI-Cloud, so it cannot stop serving a custom domain.' };
    }

    /*
     * CI-Cloud names domains by row id and the Hub stores only the hostname, so
     * the listing is how the two are joined. It is also the check that the
     * domain is still the organization's at all.
     */
    const available = await this.cloudflareClientService.fetchOrganizationCustomDomains(orgInfo.id);

    if (!available) {
      return { ok: false, message: 'CI-Cloud did not answer, so the domain was left as it is. Try again.' };
    }

    const entry = available.find((candidate) => candidate.domain === current);

    if (!entry) {
      /*
       * ⚠ REFUSED, NOT TREATED AS DONE — AND THAT IS A DELIBERATE REVERSAL.
       *
       * "The listing does not contain it" is tempting to read as "the
       * organization no longer holds it, so it has already stopped serving".
       * That reading is unsafe, because the listing drops rows it cannot parse:
       * `parseAvailableCustomDomains` requires a non-empty STRING `id`, and this
       * codebase already records that CI-Cloud's ids "arrive as numbers on a
       * sibling endpoint, so the shape is not guaranteed". A single malformed row
       * among well-formed ones is dropped silently, and the whole-payload guard
       * does not fire.
       *
       * So a wire hiccup would have produced a success toast and a cleared
       * binding while CI-Cloud went on serving the domain — precisely what this
       * method's own contract forbids, and it would then self-heal WRONGLY: the
       * next reconcile re-adopts the domain and raises another restart badge, so
       * the operator watches the thing they released come back.
       *
       * The genuinely-already-gone case still resolves, one sync later and
       * safely: reconciliation clears `custom_domain` when CI-Cloud stops
       * reporting it delivered, after which there is nothing left to release and
       * the branch above returns early.
       */
      this.logger.warn(`[Cloudflare] ${appUrn} asked to release ${current}, but CI-Cloud did not list that domain; leaving it alone.`);

      return {
        ok: false,
        message: `CI-Cloud did not list ${current} among this organization's domains, so it was left as it is. Try again.`,
      };
    }

    /*
     * ⚠ ASK WHOSE IT IS BEFORE DESTROYING IT, WITH THE ANSWER ALREADY IN HAND.
     *
     * `custom_domain` is a mirror of what CI-Cloud last reported delivered, and a
     * mirror goes stale: an operator who moves the domain to a sibling app and
     * then opens THIS app's settings before the next sync is still shown it as
     * the current domain, and clearing the picker would unpoint a domain that
     * now serves something else.
     *
     * CI-Cloud would refuse — `DOMAIN_NOT_BOUND_HERE` checks the application, not
     * only the device — but relying on that means the safety of an irreversible
     * act rests on a round trip whose answer is already sitting in the listing
     * this method just read. `boundAppSlug` is set only for an app on this
     * device, so a mismatch is decisive locally.
     */
    const appSubdomain = resolveRoutingSubdomain(app.localSubdomain, app.appName, app.appStoreSlug);

    if (entry.boundElsewhere || (entry.boundAppSlug !== null && entry.boundAppSlug !== appSubdomain)) {
      this.logger.warn(
        `[Cloudflare] ${appUrn} asked to release ${current}, but CI-Cloud reports it serving ` +
          `${entry.boundAppSlug ?? 'an app on another Hub'}; leaving it alone.`,
      );

      return {
        ok: false,
        message: `CI-Cloud reports ${current} is serving something else now, so it was left alone. Reload and try again.`,
      };
    }

    const released = await this.cloudflareClientService.unbindCustomDomain(entry.id, appSubdomain, orgInfo.id);

    if (!released.ok) {
      this.logger.warn(`[Cloudflare] Could not release ${current} from ${appUrn}: ${released.message}${released.code ? ` (${released.code})` : ''}.`);

      /*
       * `DOMAIN_NOT_BOUND_HERE` is the one refusal worth its own sentence. It
       * means CI-Cloud holds the domain against a different device or app than
       * this Hub believes, so the local row is stale — and telling the operator
       * "try again" would be wrong, because a retry cannot change CI-Cloud's mind.
       */
      if (released.code === 'DOMAIN_NOT_BOUND_HERE') {
        return {
          ok: false,
          message: `CI-Cloud reports ${current} is not currently serving this app, so it was left alone. Check the domain in CI-Cloud.`,
        };
      }

      return { ok: false, message: `Could not release ${current}: ${released.message}` };
    }

    this.logger.info(
      `[Cloudflare] ${appUrn} stopped serving ${current} at the operator's request. ` +
        'The organization still holds that domain in CI-Cloud and can point it at another app.',
    );

    return { ok: true };
  }

  /**
   * Asks Companion Portal to wire an install-time custom-domain choice after the
   * app is available as a routing target.
   *
   * Why binding does not happen during installation
   *
   * The install dialog is where a person chooses which app should use a hostname
   * such as `comfy.acme.com`. At that point, Companion Portal has no `application`
   * row for the app because the tunnel sync cannot register an app that does not
   * exist yet. Binding immediately would require the Portal to trust a routing
   * target supplied by the caller rather than one established through sync.
   *
   * The Hub therefore records `app.custom_domain_intent` and acts on it after a
   * sync reports the apps on this device. The sequence is: record intent, sync the
   * app, request the binding, receive `customDomains` on the next sync, persist
   * `custom_domain` in `reconcileCustomDomains`, mark `pendingRestart`, and
   * regenerate the environment when the user restarts. Companion Portal confirms
   * each routing step before the app receives the hostname.
   *
   * The intent is not the binding. This method must not write `custom_domain`.
   * The Hub cannot prove that a hostname resolves to its tunnel, and setting
   * `APP_PUBLIC_URL` from an unconfirmed intent would create OAuth redirects to
   * an unreachable address.
   */
  private async bindCustomDomainIntents(params: {
    apps: Awaited<ReturnType<AppsRepository['getApps']>>;
    /** URNs of the apps included in this sync payload. See the skip rule below. */
    syncedAppUrns: Set<AppUrn>;
    /**
     * Identifies the organization this Hub represents in both Portal calls.
     *
     * Companion Portal verifies this value against `device_registration`, so it
     * disambiguates rather than establishes trust. If an incomplete organization
     * transfer leaves a device registered to multiple organizations, the Portal
     * refuses the request instead of returning an arbitrary tenant's domains.
     */
    organizationId: string;
    toPublicHostname: (app: Awaited<ReturnType<AppsRepository['getApps']>>[number]) => string;
    /**
     * Apps that just lost a bound hostname this Hub is still asking for, whose
     * revert `reconcileCustomDomains` deferred to this pass.
     *
     * They are still forwarding that hostname. If the request below puts them
     * back on it, nothing needs recreating. If the choice turns out to be
     * nonviable and this pass clears it, they are stranded on a name the Hub has
     * stopped serving, and only recreating the container fixes that
     * (CI-Hub#1207).
     */
    deferredRevertAppUrns: Set<AppUrn>;
  }): Promise<void> {
    /*
     * Resolve candidates once into the shape both loops need. Re-deriving intent
     * in each loop would duplicate normalization and allow the supported
     * representations to drift. It would also require `!intent` guards after the
     * filter had already made that branch unreachable.
     */
    const candidates = params.apps.flatMap((app) => {
      const intent = normalizeStoredHostname(app.customDomainIntent);

      if (!intent) {
        return [];
      }

      /*
       * Skip satisfied intents. `custom_domain` contains only values that
       * Companion Portal reported as delivered, so an equal intent is already
       * fulfilled. This is the common state on every later heartbeat.
       */
      if (normalizeStoredHostname(app.customDomain) === intent) {
        return [];
      }

      /*
       * Apply the same two gates as delivery reconciliation. An app without a
       * public identity gives a domain nothing to alias. An app absent from this
       * sync payload was not reported to Companion Portal, so a binding request
       * for that app can only be refused.
       */
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);

      if (!canServeOnCustomDomain(app as AppPublicRoutingSnapshot) || !params.syncedAppUrns.has(appUrn)) {
        return [];
      }

      return [{ app, appUrn, intent }];
    });

    if (candidates.length === 0) {
      return;
    }

    /*
     * Enforce one app per domain again at this boundary.
     *
     * `claimCustomDomainIntent` makes each choice exclusive when written, but
     * older rows, manual database changes, or a failed clear can still create
     * duplicates. Acting on both would bind the domain to the last app in each
     * pass. Delivery reconciliation would then unbind the other app, make it a
     * candidate again, and leave both apps with recurring restart badges.
     *
     * Act on a domain once per pass and always choose the lowest app ID. This
     * choice remains stable across syncs and independent of row order, allowing
     * the binding to settle. Log and retain the duplicate intent because an
     * inactive stale choice is safer than an oscillating route.
     */
    const byIntent = new Map<string, (typeof candidates)[number]>();

    for (const candidate of candidates) {
      const held = byIntent.get(candidate.intent);

      if (!held) {
        byIntent.set(candidate.intent, candidate);
        continue;
      }

      const [winner, loser] = held.app.id <= candidate.app.id ? [held, candidate] : [candidate, held];

      byIntent.set(candidate.intent, winner);
      this.logger.warn(
        `[Cloudflare] ${loser.appUrn} also requests ${candidate.intent}, which is already claimed by ${winner.appUrn}. ` +
          'A domain serves one app; leaving the duplicate choice unacted on.',
      );
    }

    const claimed = [...byIntent.values()];

    const available = await this.cloudflareClientService.fetchOrganizationCustomDomains(params.organizationId);

    /*
     * Treat "could not ask" differently from "not connected." An older or
     * unreachable Companion Portal, or an invalid payload, produces `undefined`.
     * Retain every intent in that case. Clearing after a failed read would discard
     * the person's choice and remove the state needed for a later retry.
     */
    if (!available) {
      this.logger.debug(`[Cloudflare] ${candidates.length} custom-domain choice(s) still pending; CI-Cloud did not answer the listing`);

      return;
    }

    const byDomain = new Map(available.map((entry) => [entry.domain, entry]));

    /*
     * Apps this pass gave up on that are still forwarding the hostname they gave
     * up. Collected rather than restarted inline so one slow container cannot
     * delay the remaining bind requests.
     */
    const strandedAppUrns: AppUrn[] = [];

    for (const { app, appUrn, intent } of claimed) {
      try {
        const entry = byDomain.get(intent);

        /*
         * The organization no longer holds this domain because it was disconnected
         * or released in Companion Portal. The listing is the organization's
         * complete set, so this absence is authoritative rather than a data gap.
         * Clear the nonviable choice, keep the app on its working platform
         * hostname, and log the reason.
         */
        if (!entry) {
          await this.appRepository.updateAppById(app.id, { customDomainIntent: null, customDomainTakeover: false });
          this.logger.warn(
            `[Cloudflare] ${appUrn} was set up to serve on ${intent}, but that domain is no longer connected to this organization; clearing the choice and leaving the app on its platform hostname.`,
          );

          /*
           * "Leaving the app on its platform hostname" is only true once the
           * container is recreated. An app whose revert the reconcile deferred to
           * this pass was serving on `intent` moments ago and is still injecting
           * it as `X-Forwarded-Host`, so it is broken on the platform hostname
           * until it restarts. Now that the choice is provably nonviable, take the
           * revert the reconcile held back.
           */
          if (params.deferredRevertAppUrns.has(appUrn)) {
            strandedAppUrns.push(appUrn);
          }

          continue;
        }

        const target = normalizeHostname(params.toPublicHostname(app));
        /*
         * The subdomain this device synchronizes, not a hostname or a local guess
         * at Companion Portal's slug — the Portal canonicalizes it with the same
         * function that created the row. `resolveRoutingSubdomain` matches the
         * tunnel-state payload and trims whitespace, where an inline `||` would
         * send `" comfy "` verbatim and match no `application` row.
         *
         * Resolved here rather than at the bind call because the ownership check
         * below compares it against `boundAppSlug`, which is the same value read
         * back off CI-Cloud.
         */
        const appSubdomain = resolveRoutingSubdomain(app.localSubdomain, app.appName, app.appStoreSlug);

        /*
         * Companion Portal already points the domain here but has not reported it
         * as delivered. The ingress clone arrives on the next sync. Repeating the
         * request would spend a Cloudflare call on every heartbeat without
         * changing the asserted target.
         *
         * ⚠ SAID OUT LOUD, because this skip used to be where a stuck move went
         * to die. An app already serving a sibling domain kept the sticky pick,
         * so `custom_domain` never became the intent, the intent stayed a
         * candidate forever, and every pass landed here and returned in silence —
         * no log line anywhere naming a choice that could not land
         * (CI-Engineering#208, defect 2). The selection now prefers a delivered
         * intent, so this is once again what it claims to be: a short wait for
         * the next sync. A line that persists across many passes says otherwise.
         */
        if (normalizeStoredHostname(entry.targetHostname) === target) {
          this.logger.debug(`[Cloudflare] ${appUrn} is waiting for CI-Cloud to report ${intent} delivered; it is already pointed here.`);

          continue;
        }

        /*
         * ── IT IS SERVING SOMETHING ELSE, AND ONLY A PERSON MAY MOVE IT ──────
         *
         * A non-null `targetHostname` that is not ours means CI-Cloud currently
         * delivers this domain to another app — on this Hub or, worse, on a
         * sibling Hub in the organization. `bindCustomDomain` would move it
         * without asking anyone: the bind route retargets happily, the other Hub
         * holds no intent for the domain so nothing puts it back, and a customer's
         * production hostname changes device on a background heartbeat with
         * nothing in the log to tell it from a fresh bind (CI-Engineering#208,
         * defect 4).
         *
         * So the pass acts only on an answer a person gave in the dialog. Without
         * one the intent is CLEARED rather than retained — three reasons, and the
         * third is a separate defect:
         *
         *   * Retaining it would re-ask this question on every heartbeat forever,
         *     for a move that will never be authorized by anything a background
         *     pass can reach.
         *   * The choice is not merely unfulfillable, it is REFUSED. Leaving it on
         *     the row would show the operator a picker still claiming a domain the
         *     Hub has decided not to take.
         *   * It is what makes CI-Cloud authoritative over its own data. An
         *     operator re-pointing a domain in the portal used to be reverted on
         *     the Hub's next sync, indefinitely, because nothing ever cleared the
         *     intent that had been satisfied before the move (defect 3). Now the
         *     portal's change stands and the Hub stops arguing with it.
         */
        const currentTarget = normalizeStoredHostname(entry.targetHostname);

        /*
         * ⚠ ASKED OF WHOSE IT IS, NOT OF WHICH HOSTNAME IT POINTS AT.
         *
         * `targetHostname` alone is the wrong question, and getting it wrong
         * breaks the most ordinary operation there is. `toPublicHostname` is
         * composed from the app's local subdomain, its public domain, the hub
         * subdomain and the org slug — so RENAMING an app moves its own target.
         * The domain still points at the app's OLD hostname for one sync, which
         * reads as "serving something else", and an unconfirmed intent would be
         * cleared: the operator renames a subdomain and silently loses the custom
         * domain that app has served for months, with a log line accusing the app
         * of stealing from itself.
         *
         * CI-Cloud already answers the real question. `boundAppSlug` is set only
         * for an app on THIS device, and `boundElsewhere` is derived from the
         * row's `device_id` — so the pair says whether this is a move at all, and
         * the picker decides with exactly the same predicate. Divergence between
         * the two is not academic: a state the dialog does not warn about but the
         * pass refuses is a choice that evaporates after a success toast.
         */
        const servesAnotherApp = entry.boundElsewhere || (entry.boundAppSlug !== null && entry.boundAppSlug !== appSubdomain);

        if (currentTarget && servesAnotherApp && !app.customDomainTakeover) {
          await this.appRepository.updateAppById(app.id, { customDomainIntent: null, customDomainTakeover: false });
          this.logger.warn(
            `[Cloudflare] ${intent} is currently serving ${entry.boundAppSlug ?? (entry.boundElsewhere ? 'an app on another Hub' : 'another app')}; ` +
              `moving it to ${appUrn} was not confirmed, so the choice has been cleared and the domain left where it is.`,
          );

          continue;
        }

        /*
         * A connected but unverified domain requires no Hub action. Verification
         * waits for a person to complete a DNS change in their own zone, and the
         * intent remains pending. Use debug instead of warning because this normal
         * state can last for hours, and a warning on every heartbeat would create
         * noise.
         */
        if (!entry.bindable) {
          /*
           * `pending` represents that user-controlled verification. The state
           * clears after the DNS change, so warning on each sync would add noise.
           * Other states that Companion Portal cannot bind do not necessarily
           * clear themselves: another Hub can hold the domain, the zone can leave
           * the account, or an entitlement can lapse. Report those states as
           * warnings so operators can explain a choice that never takes effect.
           */
          if (entry.state === 'pending') {
            this.logger.debug(`[Cloudflare] ${appUrn} is waiting for ${intent} to finish verifying before it can be bound`);
          } else {
            this.logger.warn(
              `[Cloudflare] CI-Cloud will not currently bind ${intent} (state: ${entry.state}); ${appUrn} stays on its platform hostname.`,
            );
          }

          continue;
        }

        const bound = await this.cloudflareClientService.bindCustomDomain(entry.id, appSubdomain, params.organizationId);

        if (bound.ok) {
          /*
           * ⚠ THE CONFIRMATION IS SPENT HERE, not left standing on the row.
           *
           * It authorized ONE move, the one the person was shown. Leaving it set
           * would make it standing permission: an operator re-pointing the domain
           * in the portal later would be overruled by an answer given to a
           * different question, weeks earlier — which is defect 3 wearing defect
           * 4's clothes, and the exact case the guard above cannot tell apart
           * once the flag outlives its move.
           */
          if (app.customDomainTakeover) {
            await this.appRepository.updateAppById(app.id, { customDomainTakeover: false });
          }

          this.logger.info(
            currentTarget
              ? `[Cloudflare] ${intent} has been MOVED from ${currentTarget} to ${appUrn} at the operator's request; ` +
                  'it will be published to the app once the next sync reports it delivered.'
              : `[Cloudflare] ${intent} is now wired to ${appUrn}; it will be published to the app once the next sync reports it delivered.`,
          );

          continue;
        }

        /*
         * Retain the intent after a refusal that can clear itself and retry on the
         * next sync. The app's first registration sync can land after this pass,
         * and a domain under verification can become bindable without another Hub
         * action. Only a missing or unowned domain is terminal, matching the
         * missing-entry case above.
         */
        if (bound.code === 'DOMAIN_NOT_FOUND') {
          await this.appRepository.updateAppById(app.id, { customDomainIntent: null, customDomainTakeover: false });
          this.logger.warn(`[Cloudflare] CI-Cloud does not recognise ${intent} for this organization; clearing the choice on ${appUrn}.`);

          // Terminal in the same way as the missing-entry case above, so the
          // deferred revert applies here too.
          if (params.deferredRevertAppUrns.has(appUrn)) {
            strandedAppUrns.push(appUrn);
          }

          continue;
        }

        this.logger.warn(
          `[Cloudflare] Could not wire ${intent} to ${appUrn}: ${bound.message}${bound.code ? ` (${bound.code})` : ''}. Retrying on the next sync.`,
        );
      } catch (error) {
        // Isolate each app so one failure does not abandon the remaining pass.
        this.logger.error(`[Cloudflare] Custom-domain bind failed for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (strandedAppUrns.length > 0) {
      await this.restartRevertedApps(strandedAppUrns);
    }
  }

  /**
   * Mirrors custom hostnames that Companion Portal wired onto their app rows so
   * environment generation emits the hostname used by the browser.
   *
   * The app's platform hostname is the join key. Companion Portal composes
   * `targetHostname` with the same `<app>-<hub>-<org>.<root>` convention as
   * `buildPublicWebIdentity`, so neither side needs another identifier.
   *
   * Restarts are asymmetric. A *first* bind only raises `pendingRestart`, the
   * same badge a settings change shows: the app still works on its platform
   * hostname, so a background heartbeat has no reason to take a running
   * container down for a hostname nothing depends on yet. *Losing* a bound
   * hostname is different — the container keeps injecting it as
   * `X-Forwarded-Host` until it is recreated — so that direction restarts the
   * app itself. See the `restartingNow` predicate below for the exact rule.
   *
   * @returns the apps whose revert this pass handed to `bindCustomDomainIntents`
   * because the Hub is still asking CI-Cloud for the hostname they just lost.
   */
  private async reconcileCustomDomains(params: {
    apps: Awaited<ReturnType<AppsRepository['getApps']>>;
    /** URNs of the apps included in this sync payload. See the skip rule below. */
    syncedAppUrns: Set<AppUrn>;
    customDomains: TunnelCustomDomain[] | undefined;
    toPublicHostname: (app: Awaited<ReturnType<AppsRepository['getApps']>>[number]) => string;
    /** See {@link ExposureSyncOptions.skipAutoRestartAppUrns}. */
    skipAutoRestartAppUrns: Set<AppUrn>;
  }): Promise<AppUrn[]> {
    /*
     * Treat an absent field differently from an empty array. A Companion Portal
     * version that predates custom domains sends no `customDomains` field.
     * Interpreting that as "none delivered" would unbind every app using a custom
     * hostname as soon as the Hub contacts an older Portal. Only a received array,
     * including an empty one, can change bindings.
     */
    if (params.customDomains === undefined) {
      return [];
    }

    const byTarget = indexCustomDomainsByTarget(params.customDomains);
    const ambiguousDomains = collectAmbiguousCustomDomains(params.customDomains);
    const matchedTargets = new Set<string>();
    /** Reverts to dispatch, with the hostname each app lost. See the filter below. */
    const revertedApps: { appUrn: AppUrn; lostHostname: string }[] = [];
    /** Reverts the bind pass must decide on. See `stillPursuingCurrent` below. */
    const deferredRevertAppUrns: AppUrn[] = [];

    for (const app of params.apps) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      // Normalize reads and writes so a value stored with different casing settles
      // instead of triggering another change on every sync.
      const current = normalizeStoredHostname(app.customDomain);
      let next: string | null;

      /*
       * Attribute the delivered target before deciding whether to apply it. The
       * unmatched warning below means Companion Portal wired a hostname that no
       * app on this Hub answers. A stopped app, an app excluded from this pass, or
       * an app using an open host port still has a matching identity even though
       * it declines the binding. Recording matches only in the binding branch
       * would warn on every release pass and for every stopped app despite valid
       * settings.
       *
       * Lowercase both sides because DNS is case-insensitive. The Hub composes
       * hostnames from organization slugs stored verbatim, and a rename can leave
       * uppercase characters in that value.
       */
      const target = normalizeHostname(params.toPublicHostname(app));
      if (byTarget.has(target)) {
        matchedTargets.add(target);
      }

      /*
       * Whether CI-Cloud drove this change, as opposed to the app's own settings.
       *
       * Only the former is unowned. A local exposure change already restarts the
       * app itself, and dispatching a second restart from here would recreate the
       * container twice for one save. See the restart below.
       */
      let cloudDrivenChange = false;

      if (!canServeOnCustomDomain(app as AppPublicRoutingSnapshot)) {
        // The app is no longer publicly routed or uses an open host port, which
        // `generateEnvFile` treats as unexposed and gives no public identity.
        // Either state makes the binding undeliverable, so clear this durable
        // configuration rather than treating it as a transient payload absence.
        next = null;
      } else if (params.syncedAppUrns.has(appUrn)) {
        /*
         * The app's current hostname is mid-rebind. Companion Portal reported it
         * against multiple targets, so `indexCustomDomainsByTarget` removes it
         * from both and leaves this app without a delivered-domain match.
         *
         * Do not interpret ambiguity as an instruction to unbind. That would
         * remove a live customer hostname on the app's next restart because a
         * sibling app briefly claimed the same name. Since neither target is
         * authoritative, retain the current binding and let a later sync decide
         * after Companion Portal settles on one target.
         */
        if (current && ambiguousDomains.has(current)) {
          this.logger.warn(`[Cloudflare] CI-Cloud reports ${current} wired to more than one app; keeping ${appUrn} on it until that resolves.`);
          continue;
        }
        /*
         * The intent is passed so a deliberate move can land. It can only ever
         * choose between hostnames CI-Cloud has already reported delivered for
         * this target — see `selectCustomDomain` — so this does not let an
         * unconfirmed choice reach the app's env, which is the whole reason
         * `custom_domain` and `custom_domain_intent` are separate columns.
         */
        next = selectCustomDomain(byTarget.get(target), current, normalizeStoredHostname(app.customDomainIntent));
        cloudDrivenChange = true;
      } else {
        /*
         * The app is published but absent from this payload because it is stopped
         * or deliberately excluded during a release pass. Companion Portal
         * reports a domain as delivered only after producing an ingress rule, and
         * it cannot produce one for an omitted app. Absence therefore means "not
         * queried," not "unbound."
         *
         * Clearing here would cause a flap: stopping would remove the binding,
         * starting would generate an environment without the custom hostname, and
         * the following sync would restore the binding and require another restart.
         */
        continue;
      }

      if (next === current) {
        continue;
      }

      /*
       * A lifecycle command is active and has already regenerated the environment.
       * Start and restart both do that before the container becomes available, and
       * this sync runs within the same command. Persisting the binding now would
       * be lost when `settleCommandOutcome` clears `pendingRestart`: the row would
       * hold the new binding, the environment would retain the old hostname, and
       * `next === current` would prevent another restart badge.
       *
       * Deferring by one sync leaves the row unchanged, allowing the next pass to
       * derive the binding again while preserving the badge.
       */
      if (app.status === 'starting' || app.status === 'restarting') {
        continue;
      }

      /*
       * The status above is a snapshot, so the check alone cannot prevent races.
       *
       * The sync reads `apps` before the Companion Portal request, whose retries
       * and backoff can take several seconds. A restart that begins during that
       * window still appears as `running` in this array and can pass the guard.
       * `settleCommandOutcome` would then clear the resulting write, creating the
       * stale environment state that the guard prevents. The `next === current`
       * check would ensure that no later pass raises the badge again.
       *
       * Make the write conditional on an unchanged status. If a command claims
       * the app after the snapshot, the update does not apply, and the next sync
       * derives the binding again from current state.
       */
      let persisted: boolean;
      try {
        persisted = await this.appRepository.updateAppByIdIfStatus(app.id, app.status, { customDomain: next, pendingRestart: true });
      } catch (error) {
        // Isolate each row so one write failure does not abandon reconciliation.
        this.logger.error(`[Cloudflare] Failed to persist custom domain for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (!persisted) {
        this.logger.debug(`[Cloudflare] Deferred custom-domain write for ${appUrn}: a lifecycle command claimed it during this sync`);
        continue;
      }

      /*
       * Act when the app is already publishing a hostname CI-Cloud has stopped
       * wiring; keep waiting for the user on a first bind.
       *
       * A first bind can wait. The app still works on its platform hostname
       * while the badge asks for a restart, so taking a running container down
       * from a background heartbeat would be the more disruptive choice for a
       * hostname nothing depends on yet.
       *
       * Losing one is not symmetric. The container's Traefik middleware still
       * injects `X-Forwarded-Host: <the hostname that went away>`, and apps are
       * told to build absolute URLs from that header, so every redirect, asset
       * and form post it emits now points somewhere the Hub has stopped serving
       * and DNS no longer resolves. The app is broken on the very URL it was
       * supposed to fall back to, and it stays broken until someone notices a
       * banner. That header comes from the container's labels, so no amount of
       * rewriting Traefik's generated config can clear it — only recreating the
       * container can (CI-Hub#1207).
       *
       * This covers a re-point as well as a disconnect: `current` non-null means
       * the app is publishing a hostname that is no longer the bound one, and
       * whether CI-Cloud replaced it or removed it, that hostname is gone.
       *
       * Restricted to cloud-driven changes because those are the ones nothing
       * else owns. When the binding falls away because the app stopped being
       * publicly routed, that came from a settings save, and `updateAppConfig`
       * awaits this very sync before firing its own restart — so restarting here
       * would recreate the container twice for one save.
       *
       * A hostname this Hub is still asking for is not lost yet. The choice the
       * user made lives in `custom_domain_intent`, which only `bindCustomDomainIntents`
       * clears — and that pass runs immediately after this one, on the rows this
       * loop just wrote. So when the intent still names the hostname that went
       * away, the very next thing this sync does is ask CI-Cloud to wire it back
       * (the ordinary case for a domain unbound from the app in the Portal while
       * it stays connected to the organization). Recreating the container here
       * would bounce an app that is about to be served on that exact hostname
       * again, and leave it needing a second, manual restart to get back onto it.
       * When the domain is genuinely gone the bind pass clears the intent and
       * performs this revert from there instead.
       */
      const revertIsOurs = cloudDrivenChange && current !== null && app.status === 'running' && !params.skipAutoRestartAppUrns.has(appUrn);
      const stillPursuingCurrent = normalizeStoredHostname(app.customDomainIntent) === current;
      const restartingNow = revertIsOurs && !stillPursuingCurrent;
      if (restartingNow) {
        revertedApps.push({ appUrn, lostHostname: current });
      } else if (revertIsOurs) {
        // Hand the revert to the bind pass, which is the only thing that can tell
        // "CI-Cloud will wire this back" from "the domain is gone for good".
        deferredRevertAppUrns.push(appUrn);
      }

      let message: string;
      if (current === null) {
        message = `[Cloudflare] ${appUrn} is now served on custom domain ${next}; restart it to publish that hostname to the app.`;
      } else {
        const destination = next ? `custom domain ${next}` : 'its platform hostname';
        message = restartingNow
          ? `[Cloudflare] ${appUrn} no longer serves ${current}; restarting it to move to ${destination}.`
          : `[Cloudflare] ${appUrn} no longer serves ${current}; it will move to ${destination} when it next starts.`;
      }
      this.logger.info(message);
      // Omit the third `appUrn` argument because it would publish to `app:<urn>`.
      // The frontend opens only `/api/sse/app`, so a per-app topic would not
      // trigger the required cache invalidation.
      this.sseService.emit('app', { event: 'custom_domain_changed', appUrn });
    }

    /*
     * Report hostnames that Companion Portal wired but the Hub cannot attribute.
     *
     * The join can miss because each side composes its key independently.
     * Companion Portal falls back to its own root domain when an app's requested
     * `publicDomain` lacks approval, entitlement, or a reachable zone. Renaming a
     * subdomain can also move the Hub identity away from a target already stored
     * by the Portal. In each case, a customer domain is serving while the Hub
     * withholds it from the app, so operators need a direct warning.
     */
    const unmatched = [...byTarget.keys()].filter((target) => !matchedTargets.has(target));
    if (unmatched.length > 0) {
      this.logger.warn(
        `[Cloudflare] CI-Cloud reports custom domains wired to ${unmatched.length} hostname(s) that match no app on this Hub: ${unmatched.join(', ')}. ` +
          `Those domains are serving but their apps will keep emitting their platform hostname — check the apps' public domain and subdomain settings.`,
      );
    }

    /*
     * Tell a disconnect apart from this Hub's own identity moving.
     *
     * The join key is composed from `hubSubdomain`, the organization slug and the
     * default public domain, so when any of those changes every app on a custom
     * domain misses `byTarget` in the same pass and reads as unbound. Recreating
     * every public container at once over that would be far more damaging than
     * the drift it repairs.
     *
     * A count threshold cannot separate the two — disconnecting two domains in
     * one five-minute window is ordinary — but the delivered payload can. CI-Cloud
     * keeps reporting a domain whose target moved out from under it, just against
     * a hostname no app here answers: the `unmatched` set above. A domain that was
     * genuinely disconnected is not reported at all. So an app whose lost hostname
     * is still being delivered against an unmatched target has not lost anything —
     * the Hub stopped recognising it — and belongs on a badge, not in a restart.
     *
     * Deliberately NOT keyed on `unmatched` being non-empty on its own: a domain
     * re-pointed to a sibling app on this Hub is delivered against that sibling's
     * target, which is matched, so this app really is stranded and does restart.
     */
    const unmatchedTargets = new Set(unmatched);
    const domainsOnMovedTargets = new Set(
      params.customDomains.filter((entry) => unmatchedTargets.has(entry.targetHostname)).map((entry) => entry.domain),
    );

    const identityMoved = revertedApps.filter((entry) => domainsOnMovedTargets.has(entry.lostHostname));
    if (identityMoved.length > 0) {
      this.logger.warn(
        `[Cloudflare] ${identityMoved.map((entry) => entry.appUrn).join(', ')} still have a custom domain wired, but to a hostname this Hub no longer composes. ` +
          "That is this Hub's public identity changing rather than a disconnect, so they were left for a user-selected restart. " +
          'Check the organization slug, Hub subdomain and default public domain.',
      );
    }

    /*
     * Restart last: every row is settled and every diagnostic is out before a
     * container is recreated, so a slow or failing restart cannot delay
     * reconciling another app or swallow this pass's reporting.
     */
    const revertedAppUrns = revertedApps.filter((entry) => !domainsOnMovedTargets.has(entry.lostHostname)).map((entry) => entry.appUrn);
    if (revertedAppUrns.length > 0) {
      await this.restartRevertedApps(revertedAppUrns);
    }

    // Re-attempt reverts whose dispatch failed earlier. Their rows are already
    // settled, so this is the only thing that will ever look at them again.
    const retries = [...this.failedCustomDomainReverts].filter((appUrn) => !revertedAppUrns.includes(appUrn));
    if (retries.length > 0) {
      await this.restartRevertedApps(retries);
    }

    return deferredRevertAppUrns;
  }

  /**
   * Recreates apps whose custom domain was just removed so their public identity
   * returns to the platform hostname.
   *
   * A restart is the whole repair: it regenerates `app.env`, rebuilds the Compose
   * file — and with it the Traefik `X-Forwarded-Host` middleware, which is
   * derived from the container's labels and so cannot be corrected in place —
   * and regenerates Traefik's dynamic config. That is exactly what
   * `cihub public-web repair` performs for this state; the only thing missing was
   * anything that ran it without a human.
   *
   * `restartApp` resolves once the command is queued, so a slow container does
   * not hold the sync open, and the app event queue serializes the restart
   * against any lifecycle command that claims the app first.
   *
   * A dispatch that fails is remembered and retried on the next pass. The row was
   * already written before the restart was asked for, so every later reconcile
   * computes `next === current` and returns early — nothing would ever notice the
   * app again, and it would sit forwarding a hostname the Hub has stopped serving
   * until a person ran `cihub public-web repair`.
   */
  private async restartRevertedApps(appUrns: AppUrn[]): Promise<void> {
    /*
     * Imported dynamically. `AppLifecycleService` injects this service, so a
     * static import would close the cycle and leave this module's DI tokens
     * undefined at decoration time — the same reason `AppsService` reaches for
     * it this way.
     */
    let lifecycleService: { restartApp(params: { appUrn: AppUrn; skipPull?: boolean }): Promise<unknown> } | undefined;
    try {
      const { AppLifecycleService } = await import('./app-lifecycle.service');
      // `ModuleRef.get` throws when a provider cannot be resolved; it does not
      // return undefined.
      lifecycleService = this.moduleRef.get(AppLifecycleService, { strict: false });
    } catch (error) {
      this.logger.debug(
        `[Cloudflare] Lifecycle service unavailable for custom-domain revert: ${error instanceof Error ? error.message : String(error)}`,
      );
      lifecycleService = undefined;
    }

    if (!lifecycleService) {
      for (const appUrn of appUrns) {
        this.failedCustomDomainReverts.add(appUrn);
      }
      this.logger.warn(
        `[Cloudflare] Could not revert ${appUrns.join(', ')} to the platform hostname automatically. ` +
          'Those apps are still forwarding a hostname that no longer resolves — the next sync will try again, ' +
          'or run `cihub public-web repair` to apply it now.',
      );
      return;
    }

    const now = Date.now();
    for (const appUrn of appUrns) {
      const lastRestart = this.lastCustomDomainRestartAt.get(appUrn) ?? 0;
      if (now - lastRestart < ExposureSyncService.CUSTOM_DOMAIN_RESTART_COOLDOWN_MS) {
        this.logger.warn(
          `[Cloudflare] ${appUrn} changed public hostname again within the restart cooldown — leaving it alone. ` +
            'Its restart badge is still raised, so it can be applied by hand.',
        );
        continue;
      }

      try {
        // Skip the pull: nothing about the image changed, and a registry round
        // trip would extend the outage this restart exists to end.
        await lifecycleService.restartApp({ appUrn, skipPull: true });
        // Recorded only once the command is queued. A dispatch that threw
        // restarted nothing, so it must not spend the cooldown.
        this.lastCustomDomainRestartAt.set(appUrn, now);
        this.failedCustomDomainReverts.delete(appUrn);
      } catch (error) {
        // Retry on the next pass. The row was settled before this dispatch, so
        // no later reconcile would ever look at this app again.
        this.failedCustomDomainReverts.add(appUrn);
        this.logger.error(
          `[Cloudflare] Failed to restart ${appUrn} after its custom domain was removed: ${error instanceof Error ? error.message : String(error)}. Retrying on the next sync.`,
        );
      }
    }

    this.pruneCustomDomainRestartHistory(now);
  }

  /**
   * Drops cooldown entries that can no longer suppress anything.
   *
   * The map is keyed by app URN and written on every automatic revert, so without
   * this it retains a row for every app the process has ever restarted, including
   * apps that have since been uninstalled.
   */
  private pruneCustomDomainRestartHistory(now: number): void {
    for (const [appUrn, at] of this.lastCustomDomainRestartAt) {
      if (now - at >= ExposureSyncService.CUSTOM_DOMAIN_RESTART_COOLDOWN_MS) {
        this.lastCustomDomainRestartAt.delete(appUrn);
      }
    }
  }
}
