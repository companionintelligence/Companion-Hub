import { ConfigurationService } from '@/core/config/configuration.service';
import { ErrorReportingService } from '@/core/error-reporting/error-reporting.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { LifecycleActor } from '@/core/portal/lifecycle-actor';
import { SSEService } from '@/core/sse/sse.service';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import {
  buildOriginServerName,
  buildPublicWebIdentity,
  collectAmbiguousCustomDomains,
  collectContestedCustomDomainTargets,
  customDomainHeldByAnotherHub,
  customDomainServesAnotherApp,
  indexCustomDomainsByTarget,
  normalizeHostname,
  normalizeStoredHostname,
  selectCustomDomain,
} from '@ci-hub/common/types';
import type { TunnelCustomDomain } from '@ci-hub/common/types';
import type { CustomDomainApplyReport } from '../cloudflare/cloudflare-client.service';
import { AppsRepository } from '../apps/apps.repository';
import { AppFilesManager } from '../apps/app-files-manager';
import { EnvUtils } from '../env/env.utils';
import {
  canServeOnCustomDomain,
  publicRoutingSnapshotOf,
  publishesCloudflarePublicRoute,
  resolveRoutingSubdomain,
  type AppPublicRoutingSnapshot,
} from '../apps/app-public-routing.helpers';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { CloudflareClientService, AppInfo, type PublicDnsFailure, type PublicDnsFailureReason } from '../cloudflare/cloudflare-client.service';
import { DockerReadFacade } from '../docker/docker-read.facade';
import { RegistrationService } from '../registration/registration.service';
import { isServePermissionDenied, servePermissionRemedy, TailscaleService, type TailscaleServeEntry } from '../tailscale/tailscale.service';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { resolveHubLocalDomainRoot, resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { isPrivateVpnEnabled } from '@/common/helpers/private-vpn';
import { hasPairingAppCheck, hasRestoreIntent, readRehydrationState } from './registration-recovery-state';
import { customDomainAuditLine } from './custom-domain-audit';
import { moveStoredPublicDomain, readServedHostname, resolveMovedPublicDomainRoot } from './public-domain-move';
import { TailscaleServeOwnership } from './tailscale-serve-ownership';

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

type AppRow = Awaited<ReturnType<AppsRepository['getApps']>>[number];

/**
 * An app Companion Portal published on another domain than the one it asked
 * for, because it cannot write DNS there (CI-Portal#841). See
 * {@link ExposureSyncService.adoptServedPublicDomains}.
 */
type PublicDomainMove = {
  appUrn: AppUrn;
  app: AppRow;
  /** The hostname this Hub composes today, which nothing serves. */
  previousHostname: string;
  previousDomain: string;
  /** Where CI-Cloud serves the app. */
  servedHostname: string;
  /** The public root that makes the Hub compose `servedHostname`. */
  publicDomain: string;
};

/** Why an app is recreated for its public identity; see `restartRevertedApps`. */
type PublicIdentityRestart = 'revert' | 'apply' | 'public-domain-move';

/**
 * Refusals that come from the user's own plan or naming. The Portal refuses every
 * sync the same way until the user removes an app's public address, upgrades the
 * plan, or gives the app another subdomain. They are no fault of the Hub, so they
 * are not reported to Sentry.
 */
const USER_ACTION_REFUSALS: ReadonlySet<PublicDnsFailureReason> = new Set<PublicDnsFailureReason>([
  'subdomain_quota_exceeded',
  'duplicate_subdomain',
]);

/**
 * Refusals the Portal repeats on every sync until someone acts, so their toast is
 * shown once instead of on the five-minute cooldown. Besides the user's own, they
 * are an address another device or tunnel holds, a domain not set up for this
 * device, and a subdomain with no valid DNS label. Those three can point at a
 * platform or Hub fault (CI-Portal#403 began as conflicts), so Sentry still gets them.
 */
const STANDING_REFUSALS: ReadonlySet<PublicDnsFailureReason> = new Set<PublicDnsFailureReason>([
  ...USER_ACTION_REFUSALS,
  'conflict',
  'zone_unreachable',
  'invalid_subdomain',
]);

function isUserActionRefusal(reason: PublicDnsFailureReason | undefined): reason is PublicDnsFailureReason {
  return reason !== undefined && USER_ACTION_REFUSALS.has(reason);
}

function isStandingRefusal(reason: PublicDnsFailureReason | undefined): reason is PublicDnsFailureReason {
  return reason !== undefined && STANDING_REFUSALS.has(reason);
}

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
 * Whether Tailscale Serve already answers `port` under this node's current name with the wanted
 * target.
 *
 * The name is part of the match because a tailnet rename leaves the old listener in place and
 * gives the new name none. core-17 (formerly bench-1) kept only `bench-1.<tailnet>:443`, so every
 * peer's HTTPS to `core-17.<tailnet>` failed its TLS handshake while a port-and-target check read
 * the Hub as published. With no DNS name in the status there is nothing to compare, so the port
 * and target decide rather than republishing on every pass.
 */
function isServedUnderCurrentName(entries: readonly TailscaleServeEntry[], port: number, upstreamUrl: string, selfHost: string | null): boolean {
  return entries.some(
    (entry) => entry.listenPort === port && entry.mountPoint === '/' && entry.dest === upstreamUrl && (selfHost === null || entry.host === selfHost),
  );
}

/** The pre-rename name still holding `port` when the node's current name holds nothing there. */
function findStaleHost(entries: readonly TailscaleServeEntry[], port: number, selfHost: string | null): string | undefined {
  if (!selfHost) return undefined;
  const onPort = entries.filter((entry) => entry.listenPort === port);
  return onPort.some((entry) => entry.host === selfHost) ? undefined : onPort.find((entry) => entry.host)?.host;
}

/**
 * Converts Companion Portal's per-app failure details into an operator-facing
 * explanation.
 *
 * Distinguishing a DNS conflict from a domain or zone problem prevents operators
 * from investigating the wrong cause (CI-Portal#403). The generic wording remains
 * available when an older Portal sends no details.
 *
 * Only `api_error` and unknown reasons fall through to the "usually transient"
 * wording. A plan-limit refusal read that way would send operators to wait for a
 * retry that the Portal refuses every time.
 */
export function describePublicDnsFailures(failures: PublicDnsFailure[]): string {
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
        case 'subdomain_quota_exceeded':
          return `${failure.app}: the organization's plan includes no more public app addresses, so CI-Cloud refused it and retrying will not help until another app's public address is removed or the plan is upgraded (${failure.message ?? 'no detail'})`;
        case 'duplicate_subdomain':
          return `${failure.app}: another app in this sync claimed the same subdomain first and CI-Cloud kept that app's address (${failure.message ?? 'no detail'})`;
        case 'release_pending':
          return `${failure.app}: its previous public address has not been released yet, so CI-Cloud kept it on its current address and a later sync retries the change (${failure.message ?? 'no detail'})`;
        case 'write_failed':
          return `${failure.app}: CI-Cloud could not record the app and changed nothing about it, and the next sync retries (${failure.message ?? 'no detail'})`;
        default:
          return `${failure.app}: Cloudflare rejected the DNS write, usually transient (${failure.message ?? 'no detail'})`;
      }
    })
    .join('; ');
}

/**
 * CI-Cloud's refusal of a bind, without a move grant, for a domain another
 * device in the organization holds. This Hub sends no grant, so no retry can
 * succeed; see {@link customDomainHeldByAnotherHub}. `TAKEOVER_REQUIRED` and
 * `MOVE_GRANT_INVALID` answer only a request that carries a grant, so how to
 * treat them is decided with grant delivery rather than here.
 */
const HELD_BY_ANOTHER_HUB_BIND_REFUSAL = 'DOMAIN_BOUND_TO_ANOTHER_DEVICE';

/** Where a domain another Hub holds is moved, named by every log line that gives one up. */
const MOVE_IN_PORTAL_REMEDY = 'To serve it here, move it to this Hub from the portal: organization settings → domains.';

@Injectable()
export class ExposureSyncService {
  private lastPublicDnsFailureReportAt = 0;
  private readonly lastPublicDnsToastAt = new Map<string, number>();
  private static readonly PUBLIC_DNS_FAILURE_COOLDOWN_MS = 5 * 60_000;
  /**
   * The refusal each app's toast last reported, for refusals that stand until someone acts.
   *
   * Repeating that toast on every pass tells the user nothing new, so it is shown
   * once. An entry goes when a sync stops refusing the app that way, because the
   * app published, left the sync, or failed for another reason. The next such
   * refusal is then news again.
   */
  private readonly toastedStandingRefusals = new Map<AppUrn, PublicDnsFailureReason>();

  private readonly lastTailscaleServeToastAt = new Map<string, number>();
  private static readonly TAILSCALE_SERVE_FAILURE_COOLDOWN_MS = 5 * 60_000;
  /** Set once the operator refusal has been logged; cleared by the next Serve write that succeeds. */
  private servePermissionDeniedReported = false;
  private privateVpnDisabledReported = false;
  /** `<port> <old name> <new name>` of each rename already logged at info. */
  private readonly reportedRenames = new Set<string>();
  /** The node name last warned about as unpublished while opted out; cleared once it is served. */
  private optedOutUnpublishedReportedFor: string | null = null;
  /** The only listeners the Tailscale cleanup may remove; see {@link TailscaleServeOwnership}. */
  private readonly tailscaleServeOwnership = new TailscaleServeOwnership();

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
   * How long an empty `customDomains` must persist, across a second sync,
   * before it is believed while apps still hold domains. See the
   * confirmation in `reconcileCustomDomains`.
   */
  private static readonly EMPTY_CUSTOM_DOMAINS_CONFIRM_MS = 60_000;
  /** When the current run of empty answers began, while domains were still bound. */
  private emptyCustomDomainsSince: number | null = null;

  /**
   * Reverts whose restart could not be dispatched, to retry on a later pass.
   *
   * The reconcile settles the row before it asks for the restart, so once a
   * dispatch fails nothing else will ever notice that app: every later pass sees
   * `next === current` and returns early, leaving the container forwarding a
   * hostname the Hub has stopped serving.
   */
  private readonly failedCustomDomainReverts = new Set<AppUrn>();

  /**
   * Public-domain moves whose restart could not be dispatched, to retry on a
   * later pass — for the same reason as {@link failedCustomDomainReverts}: the
   * row already names the served domain, so CI-Cloud stops reporting the move
   * and nothing else would ever notice the container still carries the old one.
   */
  private readonly failedPublicDomainMoveRestarts = new Set<AppUrn>();

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
    /*
     * `PRIVATE_VPN_USER_DISABLED=true` is the operator's opt-out, and core-17, beta-ms-a2, and
     * beta-nas set it, yet this pass still ran `tailscale serve` on each of them every five
     * minutes. Opting out leaves Serve exactly as it is rather than tearing it down: all three
     * still hold a 443 listener that pool peers reach through `https://<node>/`, and Serve
     * config does not record whether the Hub or an operator created a listener.
     */
    const privateVpnEnabled = isPrivateVpnEnabled();
    if (!privateVpnEnabled && !this.privateVpnDisabledReported) {
      this.privateVpnDisabledReported = true;
      this.logger.info('[Tailscale] Private VPN is turned off for this Hub (PRIVATE_VPN_USER_DISABLED=true); leaving Tailscale Serve unchanged');
    }

    try {
      const tailscaleService = this.moduleRef.get(TailscaleService, { strict: false });
      if (!tailscaleService) return;

      const status = await tailscaleService.getStatus().catch(() => null);
      if (!status?.connected) return;

      if (!privateVpnEnabled) {
        await this.reportHubUnpublishedWhileOptedOut(tailscaleService, status.nodeFqdn?.toLowerCase() ?? null);
        return;
      }

      const apps = await this.appRepository.getApps();

      // Publish only apps whose lifecycle state can accept traffic. Stopped apps
      // remain absent from the desired map so the cleanup loop removes the
      // Serve entries the Hub published for them.
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

      const selfHost = status.nodeFqdn?.toLowerCase() ?? null;
      const ownership = await this.tailscaleServeOwnership.load();

      for (const desired of desiredPorts.values()) {
        if (isServedUnderCurrentName(serveStatus.entries, desired.port, desired.upstreamUrl, selfHost)) {
          // Adopts what an older Hub, which kept no record, already published.
          ownership.record(desired.port, desired.upstreamUrl);
          continue;
        }

        const staleHost = findStaleHost(serveStatus.entries, desired.port, selfHost);
        if (staleHost) {
          // Once per rename: while tailscaled refuses the write, this branch comes round every pass.
          const renameKey = `${desired.port} ${staleHost} ${selfHost}`;
          const renameLine = `[Tailscale] :${desired.port} is served for ${staleHost} but this node is now ${selfHost}; publishing ${desired.appName} under the current name`;
          if (this.reportedRenames.has(renameKey)) {
            this.logger.debug(renameLine);
          } else {
            this.reportedRenames.add(renameKey);
            this.logger.info(renameLine);
          }
        }

        try {
          await tailscaleService.serveApp({
            appName: desired.appName,
            httpsPort: desired.port,
            upstreamUrl: desired.upstreamUrl,
          });
          ownership.record(desired.port, desired.upstreamUrl);
          this.reportServePermissionGranted(tailscaleService);
        } catch (e) {
          if (isServePermissionDenied(e)) {
            this.reportServePermissionDenied(tailscaleService, e);
            // Every other write in this pass, the cleanup below included, meets the same refusal.
            return;
          }
          if (desired.appUrn) {
            this.surfaceTailscaleServeFailure(desired.appUrn, e);
          } else {
            this.logger.error(`[Tailscale] Failed to publish the Hub on the Private VPN: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      // Removes a listener only while it still carries the target the Hub wrote there. Tailscale
      // Services have no listen port and are left alone: the Hub stopped creating them in
      // CI-Hub#766 and has cleared its own on every pass since, so any left are someone else's.
      // `unservePort` logs and swallows every failure except the operator refusal, which it
      // rethrows so a Hub whose own entry is already correct does not repeat tailscaled's refusal
      // for a leftover listener on every pass.
      const checkedPorts = new Set<number>();
      try {
        for (const served of serveStatus.entries) {
          const listenPort = served.listenPort;
          if (!listenPort || desiredPorts.has(listenPort) || checkedPorts.has(listenPort)) {
            continue;
          }
          // `serve --https=<port> off` acts only on the node's current name, so a listener left
          // under a pre-rename name cannot be removed from here; trying would fail on every pass.
          if (selfHost && served.host && served.host !== selfHost) {
            continue;
          }
          checkedPorts.add(listenPort);

          const target = ownership.targetFor(listenPort);
          if (!target || !isServedUnderCurrentName(serveStatus.entries, listenPort, target, selfHost)) {
            // Someone else's listener, or one that replaced the Hub's, so the port is no longer the Hub's.
            ownership.release(listenPort);
            this.logger.debug(`[Tailscale] Leaving :${listenPort} in place: the Hub did not publish what it serves`);
            continue;
          }

          if (await tailscaleService.unservePort(listenPort)) {
            ownership.release(listenPort);
            // A removal is a Serve write too, and may be the only one a pass makes.
            this.reportServePermissionGranted(tailscaleService);
          }
        }
      } catch (e) {
        if (!isServePermissionDenied(e)) throw e;
        this.reportServePermissionDenied(tailscaleService, e);
        return;
      }

      this.logger.debug(`[Tailscale] Sync complete: ${desiredPorts.size} apps served`);
    } catch (error) {
      this.logger.error(`[Tailscale] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await this.tailscaleServeOwnership
        .save()
        .catch((error) =>
          this.logger.warn(
            `[Tailscale] Failed to record which Tailscale Serve listeners the Hub published: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  }

  /**
   * Reports a public DNS sync failure through logs, Sentry, and per-app SSE.
   *
   * The frontend converts the SSE event into a toast. Cooldowns prevent Sentry
   * and toast floods when availability remediation repeats the sync for an app
   * that remains unavailable. A refusal that stands until someone acts is toasted
   * once instead, and `reportError: false` keeps a sync with no Hub fault out of
   * Sentry.
   */
  private surfacePublicDnsFailure(
    message: string,
    failedAppNames: string[],
    toastTargets: PublicDnsToastTarget[] = [],
    { reportError = true }: { reportError?: boolean } = {},
  ): void {
    this.logger.error(message);

    const now = Date.now();
    if (reportError && now - this.lastPublicDnsFailureReportAt >= ExposureSyncService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
      this.lastPublicDnsFailureReportAt = now;
      this.errorReportingService?.captureMessage(message, 'error', { failedApps: failedAppNames });
    }

    for (const target of toastTargets) {
      const { appUrn, reason } = target;
      if (isStandingRefusal(reason)) {
        if (this.toastedStandingRefusals.get(appUrn) === reason) {
          continue;
        }
      } else if (now - (this.lastPublicDnsToastAt.get(appUrn) ?? 0) < ExposureSyncService.PUBLIC_DNS_FAILURE_COOLDOWN_MS) {
        continue;
      }
      this.lastPublicDnsToastAt.set(appUrn, now);
      // `errorCode` lets the frontend describe the actual failure class instead
      // of attributing every failure to the domain (CI-Portal#403). No `appUrn`
      // third argument: that publishes to the `app:<urn>` topic, which nothing
      // subscribes to, so the toast never reached the browser.
      this.sseService.emit('app', { event: 'public_dns_error', appUrn, error: target.hostname, errorCode: reason });
      // Count the refusal as told only if a UI was listening. The first sync
      // after the Hub starts, or one an agent triggers with no UI open, would
      // otherwise spend the only toast on nobody.
      if (isStandingRefusal(reason) && this.sseService.hasSubscribers('app')) {
        this.toastedStandingRefusals.set(appUrn, reason);
      }
    }
  }

  /**
   * Forgets each told refusal that this sync did not repeat, so that app's next
   * refusal is shown again.
   */
  private forgetSettledRefusals(stillRefused: ReadonlyMap<AppUrn, PublicDnsFailureReason>): void {
    for (const [appUrn, reason] of this.toastedStandingRefusals) {
      if (stillRefused.get(appUrn) !== reason) {
        this.toastedStandingRefusals.delete(appUrn);
      }
    }
  }

  /**
   * Warns once, without writing anything, when an opted-out Hub is not published under this node's
   * current name.
   *
   * The opt-out stops the Hub repairing its own `https://<node>/` entry, and on the fleet the Hubs
   * that set it are the ones that needed the repair: core-14 (formerly bench-2) and core-17
   * (formerly bench-1) both carry `PRIVATE_VPN_USER_DISABLED=true`, as do beta-max, core-6 and
   * beta-red, whose Hubs had been keeping their own entry alive. Pool peers, pairing and the
   * Private VPN sign-in flow all dial `https://<node>/`, so after a rename or a `tailscale serve
   * reset` on such a node they fail TLS with nothing in this Hub's log to say why. Reading the
   * Serve config needs no operator role, so this check costs no refusal.
   */
  private async reportHubUnpublishedWhileOptedOut(tailscaleService: TailscaleService, selfHost: string | null): Promise<void> {
    if (!selfHost) return;

    const [serveStatus, upstreamUrl] = await Promise.all([tailscaleService.getServeStatus(), tailscaleService.getHubServeUpstream()]);
    const port = ExposureSyncService.HUB_VPN_PORT;
    if (isServedUnderCurrentName(serveStatus.entries, port, upstreamUrl, selfHost)) {
      this.optedOutUnpublishedReportedFor = null;
      return;
    }
    if (this.optedOutUnpublishedReportedFor === selfHost) return;
    this.optedOutUnpublishedReportedFor = selfHost;

    const staleHost = findStaleHost(serveStatus.entries, port, selfHost);
    this.logger.warn(
      `[Tailscale] Tailscale Serve has no :${port} entry for ${selfHost} → ${upstreamUrl}` +
        (staleHost ? ` (only ${staleHost}, a name this node no longer has)` : '') +
        `, so pool peers and Private VPN sign-in cannot reach this Hub at https://${selfHost}/. ` +
        'PRIVATE_VPN_USER_DISABLED=true stops the Hub publishing itself; ' +
        `run sudo tailscale serve --bg --yes --https=${port} ${upstreamUrl} once on the host, or remove PRIVATE_VPN_USER_DISABLED and restart the Hub.`,
    );
  }

  /**
   * Logs tailscaled's operator refusal once, then at debug level until a Serve write succeeds.
   *
   * The refusal is a host setting the Hub cannot change, so retrying on the five-minute poll only
   * repeated the same four-line CLI error all day on beta-ms-a2, beta-nas, and core-17, and on
   * core-3, core-4 and core-10 until 2026-09-17, when their operator was set. That error also
   * suggests `--operator=$USER`, which names whoever pastes it rather than the account the Hub runs
   * as, so this line names the Hub's uid instead.
   *
   * The log was the only place that said so, and Private VPN apps just read "Pending" (CI-Hub#1766).
   * So the refusal is also recorded where `GET /tailscale/status` reports it, with the command, and
   * open pages are told to read it again.
   */
  private reportServePermissionDenied(tailscaleService: TailscaleService, error: unknown): void {
    if (tailscaleService.recordServePermissionDenied()) {
      this.sseService.emit('app', { event: 'tailscale_serve_permission', denied: true });
    }
    if (this.servePermissionDeniedReported) {
      this.logger.debug(`[Tailscale] Tailscale Serve config still denied: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.servePermissionDeniedReported = true;
    this.logger.warn(
      "[Tailscale] tailscaled denied a Tailscale Serve change from the Hub (serve config denied) because the Hub is neither root nor this host's Tailscale operator. " +
        `Run ${servePermissionRemedy()} once on the host; the next sync then publishes the Hub and its Private VPN apps. ` +
        'Further denials log at debug level until a publish succeeds.',
    );
  }

  /** Ends a recorded operator refusal once tailscaled accepts a Serve write, and tells open pages. */
  private reportServePermissionGranted(tailscaleService: TailscaleService): void {
    this.servePermissionDeniedReported = false;
    if (tailscaleService.recordServePermissionGranted()) {
      this.sseService.emit('app', { event: 'tailscale_serve_permission', denied: false });
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
      /*
       * ⚠ THE FIRST SYNC AFTER A PAIRING CAN RELEASE EVERY APP ON THE DEVICE. Companion Portal releases
       * each app on the device that a sync leaves out, and a Hub reinstalled and paired back onto its
       * device has none of them installed yet. `PairingAppRestoreService` lifts this hold once it has
       * compared the Portal's list with this Hub's, and restored what was missing.
       */
      if (await hasPairingAppCheck()) {
        this.logger.debug('[Cloudflare] Skipping sync until the apps Companion Portal lists for this device are checked after pairing');
        return;
      }

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
      const cfg = this.config.getConfig();
      const defaultPublicDomain = resolveHubPublicDomainRoot(cfg);
      const localDomain = resolveHubLocalDomainRoot(cfg);

      type AppFromDb = Awaited<ReturnType<AppsRepository['getApps']>>[number];
      const exclude = new Set(options?.excludeAppUrns ?? []);

      const syncedDbApps = apps.filter((app: AppFromDb) => {
        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
        if (exclude.has(appUrn)) {
          return false;
        }
        return (
          publishesCloudflarePublicRoute(publicRoutingSnapshotOf(app as AppPublicRoutingSnapshot)) &&
          ['running', 'starting', 'restarting'].includes(app.status)
        );
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

      const exposedApps: AppInfo[] = await Promise.all(
        syncedDbApps.map(async (app: AppFromDb) => {
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
        }),
      );

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

      // Derive each public record name from its database row in one place so the
      // failure toasts, the failure log, and the custom-domain passes remain consistent —
      // and the report below names each binding by the same hostname.
      const toPublicHostname = (dbApp: AppFromDb): string =>
        buildPublicHostname({
          appSubdomain: dbApp.localSubdomain || `${dbApp.appName}-${dbApp.appStoreSlug}`,
          hubSubdomain: orgInfo.hubSubdomain,
          orgSlug: orgInfo.slug,
          publicDomainRoot: dbApp.publicDomain || defaultPublicDomain,
        });

      /*
       * Built from EVERY app row, not from `syncedDbApps`: the publish payload
       * leaves stopped apps out on purpose, and a stopped app is exactly the one
       * Portal must not offer to restart. See `CustomDomainApplyReport`.
       */
      const customDomainApps = await this.buildCustomDomainApplyReport(apps, toPublicHostname);

      const result = await this.cloudflareClientService.syncState(orgInfo.id, exposedApps, orgInfo.tunnelId || undefined, customDomainApps);

      const appEntries = exposedApps.filter((entry) => entry.privilegedKind !== 'hub');

      // The partial-failure branch maps app names to database rows, exposed entries,
      // and failure reasons. Index once to avoid a full scan for every failure on
      // Hubs that run many apps.
      const dbAppByName = indexByFirst(apps, (candidate: AppFromDb) => candidate.appName);

      const toToastTarget = (dbApp: AppFromDb): PublicDnsToastTarget => ({
        appUrn: createAppUrn(dbApp.appName, dbApp.appStoreSlug),
        hostname: toPublicHostname(dbApp),
      });

      /** Apps this sync refused for a reason that stands until someone acts. */
      const standingRefusals = new Map<AppUrn, PublicDnsFailureReason>();

      /*
       * Apps CI-Cloud did publish, only on its own domain instead of the one they
       * asked for (CI-Portal#841). They are served, so they are not failures here:
       * "couldn't create a public address" would be false, and there is nothing
       * for Sentry. They are adopted below, once this sync's reporting is done.
       */
      const publicDomainMoves = result.ok
        ? this.collectPublicDomainMoves({ result, syncedDbApps, toPublicHostname, defaultPublicDomain })
        : new Map<string, PublicDomainMove>();
      const refusedNames = result.failed.filter((name) => !publicDomainMoves.has(name));

      if (!result.ok) {
        // The Portal gave no answer about any app: it could not be reached, timed
        // out, answered with an error status, or reported `success: false`. That
        // says nothing about any app's address, so it raises no per-app toast. A
        // toast blaming each app's domain would send the user the wrong way. The
        // log and Sentry still record it.
        const cause = [result.errorStatus && `HTTP ${result.errorStatus}`, result.errorMessage].filter(Boolean).join(': ');
        this.surfacePublicDnsFailure(
          `[Cloudflare] State sync did not complete — public DNS was not updated for ${appEntries.length} exposed app(s).${
            cause ? ` Cause: ${cause}.` : ''
          }`,
          appEntries.map((entry) => entry.name),
        );
      } else if (refusedNames.length > 0) {
        // Map Companion Portal's failed app names to URNs and hostnames so the
        // frontend can raise per-app toasts. The privileged Hub entry is absent
        // from `appEntries`, so unmatched names are skipped.
        const exposedByName = indexByFirst(appEntries, (entry) => entry.name);
        const failureByApp = indexByFirst(result.failures, (failure) => failure.app);

        const toastTargets = refusedNames
          .map((name): PublicDnsToastTarget | null => {
            const dbApp = dbAppByName.get(name);
            if (!dbApp || !exposedByName.has(name)) {
              return null;
            }
            return {
              ...toToastTarget(dbApp),
              // Older Companion Portal versions omit structured failures. The
              // Portal was still reached and named the app, so it keeps a toast,
              // and the frontend falls back to a generic message.
              reason: failureByApp.get(name)?.reason,
            };
          })
          .filter((target): target is PublicDnsToastTarget => target !== null);

        for (const target of toastTargets) {
          if (isStandingRefusal(target.reason)) {
            standingRefusals.set(target.appUrn, target.reason);
          }
        }

        // Name every failed app by its reconstructed hostname or the raw name from
        // Companion Portal. Apps without a toast target include entries with no
        // database row and the privileged Hub entry, which `appEntries` excludes.
        // Listing only mapped hostnames would make the log count more failures
        // than it names and hide the entries operators cannot identify elsewhere.
        const failedLabels = refusedNames.map((name) => {
          const dbApp = dbAppByName.get(name);

          return dbApp ? toPublicHostname(dbApp) : name;
        });

        // A plan limit or a duplicate subdomain is the user's to clear, not a Hub
        // fault, so a sync refused only for those reports nothing to Sentry. Any
        // other failure in the same sync, including one with no reason, still does.
        const onlyUserActionRefusals = refusedNames.every((name) => isUserActionRefusal(failureByApp.get(name)?.reason));

        this.surfacePublicDnsFailure(
          `[Cloudflare] Public DNS records were NOT created for ${refusedNames.length} app(s): ${failedLabels.join(', ')}. ` +
            `These apps will not resolve at their public domain — ${describePublicDnsFailures(
              result.failures.filter((failure) => !publicDomainMoves.has(failure.app)),
            )}`,
          refusedNames,
          toastTargets,
          { reportError: !onlyUserActionRefusals },
        );
      } else if (appEntries.length > 0) {
        // Log success only after the request and every per-app operation complete.
        // The failure branches own all other messaging.
        this.logger.info(
          `[Cloudflare] Public hostnames synced: ${appEntries
            .map(
              (entry) =>
                `${entry.name} -> ${
                  publicDomainMoves.get(entry.name)?.servedHostname ??
                  buildPublicHostname({
                    appSubdomain: entry.subdomain,
                    hubSubdomain: orgInfo.hubSubdomain,
                    orgSlug: orgInfo.slug,
                    publicDomainRoot: entry.publicDomain || defaultPublicDomain,
                  })
                }`,
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
        // Only a sync the Portal answered says which apps it stopped refusing.
        this.forgetSettledRefusals(standingRefusals);

        const skipAutoRestartAppUrns = new Set(options?.skipAutoRestartAppUrns ?? []);

        /*
         * Adopt moves BEFORE reconciling custom domains. CI-Cloud delivers a moved
         * app's custom domains against the hostname it serves, and the platform
         * hostname is the reconcile's join key: on the old row the domain would
         * read as lost and be unbound, then bound again on the next pass.
         */
        let moved: { adopted: AppUrn[]; restart: AppUrn[] } = { adopted: [], restart: [] };
        try {
          moved = await this.adoptServedPublicDomains(publicDomainMoves, skipAutoRestartAppUrns);
        } catch (error) {
          this.logger.error(`[Cloudflare] Public-domain move failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        let deferredRevertAppUrns: AppUrn[] = [];
        try {
          deferredRevertAppUrns = await this.reconcileCustomDomains({
            // Re-read only when a row moved, so the join sees the served hostname.
            apps: moved.adopted.length > 0 ? await this.appRepository.getApps() : apps,
            syncedAppUrns,
            customDomains: result.customDomains,
            toPublicHostname,
            // The move restarts these below, once, after their custom domains settle.
            skipAutoRestartAppUrns: new Set([...skipAutoRestartAppUrns, ...moved.adopted]),
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

        // Last, so one recreation carries both the new domain and anything the
        // passes above wrote for it. Earlier dispatches that failed go again too.
        const retries = [...this.failedPublicDomainMoveRestarts].filter((appUrn) => !moved.restart.includes(appUrn));
        if (moved.restart.length > 0 || retries.length > 0) {
          await this.restartRevertedApps([...moved.restart, ...retries], 'public-domain-move');
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
   * The apps this sync's answer says CI-Cloud published on another domain than
   * the one they asked for, keyed by the name the answer uses.
   *
   * Taken from `failed`, which stays the source of truth for which apps an entry
   * is about, and matched only to an app this payload asked about under a name
   * no other synced app shares: the answer names apps by `appName` alone, and a
   * move rewrites a row, so an entry two apps could claim moves neither.
   */
  private collectPublicDomainMoves(params: {
    result: { failed: string[]; failures: PublicDnsFailure[] };
    syncedDbApps: AppRow[];
    toPublicHostname: (app: AppRow) => string;
    defaultPublicDomain: string;
  }): Map<string, PublicDomainMove> {
    const moves = new Map<string, PublicDomainMove>();
    const failureByApp = indexByFirst(params.result.failures, (failure) => failure.app);

    for (const name of new Set(params.result.failed)) {
      const failure = failureByApp.get(name);
      const servedHostname = failure ? readServedHostname(failure) : null;

      if (!servedHostname) {
        continue;
      }

      const candidates = params.syncedDbApps.filter((candidate) => candidate.appName === name);
      const app = candidates.length === 1 ? candidates[0] : undefined;

      if (!app) {
        this.logger.warn(
          `[Cloudflare] CI-Cloud serves ${name} at ${servedHostname}, but ${candidates.length === 0 ? 'no app' : 'more than one app'} ` +
            'in this sync goes by that name, so no public domain was changed.',
        );
        continue;
      }

      const previousHostname = params.toPublicHostname(app);
      const previousDomain = app.publicDomain?.trim() || params.defaultPublicDomain;
      const publicDomain = resolveMovedPublicDomainRoot({ servedHostname, composedHostname: previousHostname, composedRoot: previousDomain });

      if (!publicDomain) {
        if (normalizeHostname(servedHostname) !== normalizeHostname(previousHostname)) {
          this.logger.warn(
            `[Cloudflare] CI-Cloud serves ${name} at ${servedHostname}, which this Hub cannot compose from any public domain ` +
              `(it composes ${previousHostname}), so the app keeps advertising a hostname nothing serves. Check its subdomain.`,
          );
        }
        continue;
      }

      moves.set(name, {
        appUrn: createAppUrn(app.appName, app.appStoreSlug),
        app,
        previousHostname,
        previousDomain,
        servedHostname,
        publicDomain,
      });
    }

    return moves;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * FOLLOW AN APP TO WHERE CI-CLOUD ACTUALLY PUBLISHED IT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * CI-Cloud cannot write DNS in every zone it offers — production can see
   * `companionintelligence.com` and not write it — and since CI-Portal#841 it
   * publishes such an app on its own domain instead and says so in
   * `zone_unreachable`. The Hub composes every public URL itself, from the
   * domain it ASKED for, so without this the app's env (`APP_PUBLIC_URL`,
   * `APP_BASE_URL`, `APP_BASE_HOST`, `APP_BASE_WSS_ORIGIN`), its
   * `X-Forwarded-Host`, and the Open link all keep naming a hostname that never
   * resolved.
   *
   * ⚠ ADOPTED AS THE APP'S PUBLIC DOMAIN, on the row and in the saved form, not
   * kept as an override beside it. Every surface already composes from that
   * domain, so they all follow; and the next sync asks for what CI-Cloud serves,
   * so the move stops being reported instead of repeating on every pass. The
   * domain the app asked for is not coming back: CI-Cloud has already released
   * the name there.
   *
   * ⚠ AND THE APP IS RECREATED, like a custom-domain revert and for the same
   * reason: its env and its Traefik labels are fixed when the container is
   * created, so until then it redirects every visitor — LAN ones included — to
   * the dead name. A lifecycle command already in flight has regenerated the env
   * from the old row, so that app is left for the next sync, which reports the
   * move again.
   *
   * @returns every app moved, and the running ones the caller must restart.
   */
  private async adoptServedPublicDomains(
    moves: ReadonlyMap<string, PublicDomainMove>,
    skipAutoRestartAppUrns: ReadonlySet<AppUrn>,
  ): Promise<{ adopted: AppUrn[]; restart: AppUrn[] }> {
    const adopted: AppUrn[] = [];
    const restart: AppUrn[] = [];

    for (const move of moves.values()) {
      const { appUrn, app } = move;

      if (app.status === 'starting' || app.status === 'restarting') {
        this.logger.debug(`[Cloudflare] Deferred moving ${appUrn} to ${move.publicDomain}: a lifecycle command is running for it`);
        continue;
      }

      let persisted: boolean;
      try {
        persisted = await this.appRepository.updateAppByIdIfStatus(app.id, app.status, {
          publicDomain: move.publicDomain,
          config: moveStoredPublicDomain(app.config, {
            publicDomain: move.publicDomain,
            fromUrl: `https://${move.previousHostname}`,
            toUrl: `https://${move.servedHostname}`,
          }),
          pendingRestart: true,
        });
      } catch (error) {
        this.logger.error(`[Cloudflare] Failed to move ${appUrn} to ${move.publicDomain}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (!persisted) {
        this.logger.debug(`[Cloudflare] Deferred moving ${appUrn} to ${move.publicDomain}: a lifecycle command claimed it during this sync`);
        continue;
      }

      adopted.push(appUrn);
      const restarting = app.status === 'running' && !skipAutoRestartAppUrns.has(appUrn);
      if (restarting) {
        restart.push(appUrn);
      }

      this.logger.warn(
        `[Cloudflare] CI-Cloud cannot publish ${appUrn} on ${move.previousDomain} in this environment, so ${move.previousHostname} never resolved; ` +
          `it serves the app at ${move.servedHostname}. Moved the app to ${move.publicDomain}` +
          (restarting ? ' and restarting it so its env follows.' : '; it picks that up when it next starts.'),
      );
      // Omit the third `appUrn` argument: the frontend opens only `/api/sse/app`.
      this.sseService.emit('app', { event: 'public_domain_changed', appUrn, hostname: move.servedHostname });
    }

    return { adopted, restart };
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
  ): Promise<{ ok: true; portalRowId?: string } | { ok: false; message: string }> {
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
     *
     * Asked through {@link customDomainServesAnotherApp} rather than with an
     * inline `!==`, because CI-Cloud holds the CANONICAL slug and this side holds
     * the raw one — see that function for what a raw comparison costs.
     */
    const appSubdomain = resolveRoutingSubdomain(app.localSubdomain, app.appName, app.appStoreSlug);

    if (customDomainServesAnotherApp(entry, appSubdomain)) {
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

    return { ok: true, portalRowId: entry.id };
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

    /*
     * Gives up a choice that can never land. Every terminal branch below ends
     * here, so none of them can skip a step: the confirmation goes with the
     * choice, the reason is logged once, open dialogs refetch the app and the
     * domain listing, and the revert `reconcileCustomDomains` deferred to this
     * pass is taken. A dialog nobody has edited re-seeds its picker from the
     * refetched row; an edited one keeps the value it holds until it is saved or
     * closed.
     *
     * That revert is what makes "leaving the app on its platform hostname" true.
     * An app whose revert was deferred was serving on the intent moments ago and
     * is still injecting it as `X-Forwarded-Host`, so it is broken on its
     * platform hostname until its container is recreated (CI-Hub#1207).
     */
    const abandonChoice = async (appId: number, appUrn: AppUrn, reason: string): Promise<void> => {
      await this.appRepository.updateAppById(appId, { customDomainIntent: null, customDomainTakeover: false });
      this.logger.warn(reason);
      // No third argument: the frontend opens only `/api/sse/app`, so a per-app topic would refetch nothing.
      this.sseService.emit('app', { event: 'custom_domain_changed', appUrn });

      if (params.deferredRevertAppUrns.has(appUrn)) {
        strandedAppUrns.push(appUrn);
      }
    };

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
          await abandonChoice(
            app.id,
            appUrn,
            `[Cloudflare] ${appUrn} was set up to serve on ${intent}, but that domain is no longer connected to this organization; clearing the choice and leaving the app on its platform hostname.`,
          );

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
        /** The hostname CI-Cloud delivers this domain to now, if any. */
        const currentTarget = normalizeStoredHostname(entry.targetHostname);

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
        if (currentTarget === target) {
          this.logger.debug(`[Cloudflare] ${appUrn} is waiting for CI-Cloud to report ${intent} delivered; it is already pointed here.`);

          continue;
        }

        /*
         * ⚠ HELD BY ANOTHER HUB, WHICH NO CONFIRMATION GIVEN ON THIS ONE CAN MOVE
         * (see {@link customDomainHeldByAnotherHub}). Kept, the choice was refused
         * on every heartbeat forever, and nothing told the operator where the move
         * is actually made.
         *
         * Asked before the confirmation check below, whose log line would blame a
         * missing answer that could not have helped. A row no device holds any
         * more, and any row still verifying, stays on that path.
         */
        if (customDomainHeldByAnotherHub(entry)) {
          await abandonChoice(
            app.id,
            appUrn,
            `[Cloudflare] ${intent} is serving an app on another Hub, which this Hub cannot move; clearing the choice on ${appUrn}. ${MOVE_IN_PORTAL_REMEDY}`,
          );

          continue;
        }

        /*
         * ── IT IS SERVING SOMETHING ELSE, AND ONLY A PERSON MAY MOVE IT ──────
         *
         * A non-null `targetHostname` that is not ours means CI-Cloud currently
         * points this domain at another app. `bindCustomDomain` would move it
         * without asking anyone: the bind route retargets an app on this Hub, or
         * a row whose Hub was deleted, and a customer's hostname changes on a
         * background heartbeat with nothing in the log to tell it from a fresh
         * bind (CI-Engineering#208, defect 4). A domain another Hub holds was
         * given up above; a CI-Cloud from before CI-Portal#686 would retarget
         * that too.
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
         * the picker decides with exactly the same predicate — literally the same
         * function, {@link customDomainServesAnotherApp}, which is also what
         * canonicalizes the slug CI-Cloud stored against the raw one this side
         * composes. Divergence between the two is not academic: a state the
         * dialog does not warn about but the pass refuses is a choice that
         * evaporates after a success toast.
         *
         * ⚠ AND NOT GATED ON `currentTarget`. A domain CI-Cloud reports against
         * another device is a move whether or not it has been given a target yet:
         * `targetHostname` is absent while a bind is still settling, and the
         * parser NULLS one it cannot read rather than dropping the row. Requiring
         * it meant a `boundElsewhere` row could slip past unconfirmed on a
         * payload hiccup.
         */
        const servesAnotherApp = customDomainServesAnotherApp(entry, appSubdomain);

        if (servesAnotherApp && !app.customDomainTakeover) {
          /*
           * `boundAppSlug` names an app on this Hub. Without one the row is
           * `boundElsewhere`, and all the listing proves is where it points — at a
           * Hub that may no longer exist — so the line does not claim anything is
           * served there.
           */
          const whereItIs = entry.boundAppSlug
            ? `serving ${entry.boundAppSlug}`
            : `pointed at another Hub${entry.targetHostname ? ` (${entry.targetHostname})` : ''}`;

          await abandonChoice(
            app.id,
            appUrn,
            `[Cloudflare] ${intent} is currently ${whereItIs}; ` +
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
           * clear themselves: the zone can leave the account, or an entitlement
           * can lapse. Report those states as warnings so operators can explain a
           * choice that never takes effect. A domain another Hub holds never
           * reaches this wait; it was given up above.
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

        /*
         * ⚠ BINDABLE AND YET UNSERVABLE, WHICH IS WHY IT IS SAID OUT LOUD HERE.
         *
         * CI-Cloud reports a permanently failed certificate with `bindable: true`
         * deliberately, and `bindable` is its gate, not ours to override — so the
         * request still goes out. But unlike `securing`, this state never clears
         * itself: there is no in-place reissue, only disconnect-and-reconnect. The
         * bind therefore succeeds and the domain is never delivered, after which
         * every later pass lands on the "already pointed here" skip above and says
         * nothing louder than debug — a permanently unsatisfiable intent going
         * quiet, which is the stuck-move state (CI-Engineering#208, defect 2) this
         * pass now exists to make visible. `AvailableCustomDomain` names the bind
         * pass as a caller that must weigh this state; this is it doing so.
         */
        if (entry.state === 'failed') {
          this.logger.warn(
            `[Cloudflare] ${intent} has a certificate that will never issue (state: failed), so CI-Cloud will not deliver it; ` +
              `${appUrn} stays on its platform hostname until the domain is reconnected in the portal.`,
          );
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
         * action. Only a missing or unowned domain, or one another Hub holds, is
         * terminal, matching the listing checks above.
         */
        if (bound.code === 'DOMAIN_NOT_FOUND') {
          await abandonChoice(
            app.id,
            appUrn,
            `[Cloudflare] CI-Cloud does not recognise ${intent} for this organization; clearing the choice on ${appUrn}.`,
          );

          continue;
        }

        // The listing read it as bindable, and another Hub took it before this bind arrived.
        if (bound.code === HELD_BY_ANOTHER_HUB_BIND_REFUSAL) {
          await abandonChoice(
            app.id,
            appUrn,
            `[Cloudflare] CI-Cloud will not wire ${intent} to ${appUrn}: ${bound.message} (${bound.code}). Clearing the choice. ${MOVE_IN_PORTAL_REMEDY}`,
          );

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
      await this.restartRevertedApps(strandedAppUrns, 'revert');
    }
  }

  /**
   * Whether a bound custom domain is NOT being served yet.
   *
   * ⚠ THE ENV READ IS THE POINT, not an optimisation. `pendingRestart` alone is
   * raised by every settings save (`updateAppConfig`), so `customDomain !== null
   * && pendingRestart` would claim a customer's domain was dark each time an
   * unrelated setting changed — and, where this gates an automatic restart, would
   * bounce a container for a change that has nothing to do with the domain. The
   * only honest answer is the one `PublicWebService` gives: the domain is bound
   * and the compose env is still on some other hostname.
   *
   * Read from the row plus the env rather than from the diagnostics report: this
   * runs inside the sync that BINDS the domain, and a report gathered before that
   * write would still say the app has no custom domain at all — which is how an
   * apply request arriving with its own delivery came to be ignored.
   *
   * The two cheap terms are checked first, so the env is only ever read for an
   * app that actually holds a binding and owes a restart.
   */
  private async customDomainPendingApply(appUrn: AppUrn, app: { customDomain: string | null; pendingRestart: boolean }): Promise<boolean> {
    const customDomain = normalizeStoredHostname(app.customDomain);
    if (customDomain === null || !app.pendingRestart) {
      return false;
    }

    const envHostname = await this.readEnvPublicHostname(appUrn);
    // An env that cannot be read is not evidence that the domain is serving. Say
    // "not serving yet" so the Portal badge errs toward the truthful warning and
    // the apply gate still needs its other three conditions to act.
    return envHostname !== customDomain;
  }

  /**
   * One entry per app row holding a custom domain, whatever the app's status —
   * see `CustomDomainApplyReport`.
   *
   * ⚠ `pending-restart` MEANS "A CONFIRMATION WOULD BE CARRIED OUT". Portal offers a
   * restart for exactly that state, so it is decided with the same checks the apply
   * gate in `reconcileCustomDomains` makes: running, `pendingRestart` still set, the
   * env not yet on the domain, and a platform hostname no other app answers on.
   * Reporting it more widely than the gate acts put a button in front of people
   * that accepted the click and then did nothing, until the click expired. Running
   * but failing one of those checks is `blocked`: no button, "check your Hub".
   *
   * Only apps that can serve on a custom domain at all are reported. For any other
   * the binding is being dropped by this very pass, and Portal should not be told
   * about a binding that is going away.
   *
   * Never throws: this rides along with a sync that must keep working. On any
   * failure it returns `undefined`, which the client omits from the payload so
   * Portal keeps its previous reading — "no news" rather than "nothing is bound".
   *
   * One sync late for a domain bound DURING this pass: the report is built before
   * the request, and the binding is written by `reconcileCustomDomains` after the
   * response. The next sync reports it. Portal reads the gap as "waiting for your
   * Hub" rather than guessing.
   */
  private async buildCustomDomainApplyReport(
    apps: Awaited<ReturnType<AppsRepository['getApps']>>,
    toPublicHostname: (app: Awaited<ReturnType<AppsRepository['getApps']>>[number]) => string,
  ): Promise<CustomDomainApplyReport[] | undefined> {
    try {
      const servable = apps.filter((app) => canServeOnCustomDomain(app as AppPublicRoutingSnapshot));
      // The same set the apply gate refuses — see `collectContestedCustomDomainTargets`.
      const contestedTargets = collectContestedCustomDomainTargets(servable.map((app) => normalizeHostname(toPublicHostname(app))));
      const report: CustomDomainApplyReport[] = [];

      for (const app of servable) {
        const domain = normalizeStoredHostname(app.customDomain);
        if (domain === null) {
          continue;
        }

        const targetHostname = normalizeHostname(toPublicHostname(app));
        const envHostname = await this.readEnvPublicHostname(createAppUrn(app.appName, app.appStoreSlug));

        let state: CustomDomainApplyReport['state'];
        if (envHostname === domain) {
          state = 'applied';
        } else if (app.status === 'running') {
          state = app.pendingRestart && !contestedTargets.has(targetHostname) ? 'pending-restart' : 'blocked';
        } else {
          // Stopped, or coming up now: starting and restarting both regenerate the
          // env on the way up, so the domain arrives without anyone confirming.
          state = 'pending-start';
        }

        report.push({ domain, targetHostname, state, autoRestart: app.autoRestartOnDomainChange === true });
      }

      return report;
    } catch (error) {
      this.logger.debug(`[Cloudflare] Could not build the custom-domain report: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** `APP_PUBLIC_HOSTNAME` as the app's compose env currently holds it, or `null`. */
  private async readEnvPublicHostname(appUrn: AppUrn): Promise<string | null> {
    try {
      const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
      const appEnv = await appFilesManager.getAppEnv(appUrn);
      // `EnvUtils`, not a local regex: `PublicWebService` reads the same key through
      // it, and two parsers for one file is how the report and this gate would come
      // to disagree about whether a domain is serving.
      const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
      return normalizeStoredHostname(envUtils.envStringToMap(appEnv.content || '').get('APP_PUBLIC_HOSTNAME'));
    } catch {
      return null;
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

    /*
     * ⚠ "NONE" WHILE DOMAINS ARE BOUND IS BELIEVED ONLY ON THE SECOND ASKING.
     *
     * An empty array unbinds every custom-domain app on the Hub and recreates
     * each one onto its platform hostname — at once, since the restart cooldown
     * is per app. The Portal now omits the field when it cannot tell
     * (R2-PORTALMISC-5), but a failure mode nobody has found yet could still
     * answer `[]` for "I could not read it". So while apps that can serve a
     * custom domain still hold one, the first empty answer changes none of
     * them, and it is acted on by the next sync at least a minute on that says
     * the same — normally the five-minute poll, unless a save or a restart
     * triggers one sooner. So a real "the org disconnected them all" lands one
     * sync late, and until then those apps keep publishing a hostname that no
     * longer resolves (CI-Hub#1207); a transient read failure no longer takes
     * every customer hostname off the air.
     *
     * Only the bindings DERIVED FROM THIS ANSWER wait. An app that stopped being
     * publicly routed loses its binding because of its own settings, whatever
     * CI-Cloud says, and still does so on the first pass.
     *
     * ⚠ AND ONLY THE APPS THIS ANSWER IS ABOUT COUNT. A stopped app is left out
     * of the payload, so CI-Cloud rightly delivers nothing for it. Counting it
     * would start the minute on every poll while it is stopped, and the first
     * bad answer after it starts again would read as already confirmed.
     */
    const holdsDomains = params.apps.some(
      (candidate) =>
        params.syncedAppUrns.has(createAppUrn(candidate.appName, candidate.appStoreSlug)) &&
        canServeOnCustomDomain(candidate as AppPublicRoutingSnapshot) &&
        normalizeStoredHostname(candidate.customDomain) !== null,
    );
    let holdEmptyAnswer = false;

    if (params.customDomains.length === 0 && holdsDomains) {
      const now = Date.now();
      this.emptyCustomDomainsSince ??= now;
      holdEmptyAnswer = now - this.emptyCustomDomainsSince < ExposureSyncService.EMPTY_CUSTOM_DOMAINS_CONFIRM_MS;

      if (holdEmptyAnswer) {
        this.logger.warn('[Cloudflare] CI-Cloud reported no custom domains while apps still hold some; keeping them until a later sync confirms.');
      }
    } else {
      this.emptyCustomDomainsSince = null;
    }

    /*
     * CI-Cloud's row id for each delivered domain. Nothing is decided on it —
     * the join is on `targetHostname` — but it names the record a binding change
     * came from, for the audit line below.
     */
    const portalRowIdByDomain = new Map(
      params.customDomains.flatMap((entry) => (entry.id ? [[normalizeHostname(entry.domain), entry.id] as const] : [])),
    );

    /**
     * Whether a restart was confirmed, by BINDING — the customer hostname AND the
     * platform hostname it was delivered against.
     *
     * By domain alone, a confirmation given for one app would restart whichever app
     * holds the domain when it arrives: the domain moved in between, and the new app
     * went down at a moment nobody picked. Portal pins the confirmation to the
     * binding it was given for; this keeps the Hub to the same.
     *
     * OR-ed rather than last-write-wins. `collectAmbiguousCustomDomains` only
     * catches a domain delivered against *different* targets; two rows for the
     * same domain and the same target pass straight through, and `new Map(...)`
     * would silently keep the last — dropping the operator's "yes, start serving
     * it" whenever it arrived on the first of them.
     */
    const bindingKey = (domain: string, target: string) => `${domain}\n${target}`;
    const applyRequestedByBinding = new Map<string, boolean>();
    for (const entry of params.customDomains) {
      const key = bindingKey(normalizeHostname(entry.domain), normalizeHostname(entry.targetHostname));
      applyRequestedByBinding.set(key, (applyRequestedByBinding.get(key) ?? false) || entry.applyRequested === true);
    }

    const byTarget = indexCustomDomainsByTarget(params.customDomains);
    const ambiguousDomains = collectAmbiguousCustomDomains(params.customDomains);
    /*
     * Platform hostnames more than one app answers on. CI-Cloud attributes a
     * delivered domain by hostname, so a contested one cannot be attributed at
     * all — see {@link collectContestedCustomDomainTargets}, and the refusal
     * below.
     */
    const contestedTargets = collectContestedCustomDomainTargets(
      params.apps
        .filter((candidate) => canServeOnCustomDomain(candidate as AppPublicRoutingSnapshot))
        .map((candidate) => normalizeHostname(params.toPublicHostname(candidate))),
    );
    const matchedTargets = new Set<string>();
    /** Reverts to dispatch, with the hostname each app lost. See the filter below. */
    const revertedApps: { appUrn: AppUrn; lostHostname: string }[] = [];
    /** Apps an operator asked to start serving a domain they already hold. */
    const applyRequestedAppUrns: AppUrn[] = [];
    /** Reverts the bind pass must decide on. See `stillPursuingCurrent` below. */
    const deferredRevert = new Set<AppUrn>();

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
         * Two apps answer on this hostname, so nothing delivered against it can be
         * attributed to one of them (R2-HUBDOMAINS-2). Bind none and hold each app
         * on whatever it is already serving: CI-Cloud reports a target, not an app
         * id, and the wrong half of that guess hands a customer's production
         * hostname — with its live certificate, its `X-Forwarded-Host` and its
         * OAuth redirects — to an app it was never bound to.
         *
         * Logged as an error, not a warning: unlike the mid-rebind case below,
         * this does not settle on its own. Two rows resolving to one hostname is a
         * local misconfiguration, and it stays until somebody renames one of them.
         */
        if (contestedTargets.has(target)) {
          this.logger.error(
            `[Cloudflare] More than one app resolves to ${target}; binding no custom domain to ${appUrn} until one of them is renamed.`,
          );
          continue;
        }
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
        if (holdEmptyAnswer) {
          continue;
        }
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
        /*
         * Already bound. The only work left is to APPLY it — recreate the
         * container so it answers on the customer's name — and that only happens
         * when the operator asked for it in the connect flow.
         *
         * Gated on whether the env is still off the domain, NOT on `pendingRestart`:
         * the raw flag is raised by any settings save, and acting on it here would
         * restart an app whose domain is already serving, for a change that has
         * nothing to do with the domain. `customDomainPendingApply` reads the env
         * for exactly that reason.
         *
         * `skipAutoRestartAppUrns` is honoured for the reason it exists — a save
         * already owns this container's recreation, and doing it twice for one
         * action is the hazard that flag was added to prevent.
         *
         * `app.status` is only a first sieve here. Unlike the bind branch below,
         * this path performs no `updateAppByIdIfStatus`, so nothing has re-read the
         * row since the snapshot was taken before a Portal round trip that can take
         * seconds. The dispatcher re-checks the status before it restarts anything.
         */
        /*
         * A person confirmed the restart in Portal, or this app is one somebody set
         * to restart on its own. Nothing else moves a running container here: the
         * default is to wait to be asked.
         */
        const confirmed = current !== null && applyRequestedByBinding.get(bindingKey(current, target)) === true;
        const applyRequested = current !== null && (confirmed || app.autoRestartOnDomainChange === true);

        if (
          applyRequested &&
          app.status === 'running' &&
          !params.skipAutoRestartAppUrns.has(appUrn) &&
          (await this.customDomainPendingApply(appUrn, app))
        ) {
          const why = confirmed ? 'a restart was confirmed' : 'it is set to restart on its own';
          this.logger.info(`[Cloudflare] ${appUrn} is not serving ${current} yet and ${why}; restarting it to apply that binding.`);
          applyRequestedAppUrns.push(appUrn);
        }

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
       * R2-HUBREGISTRATION-2: this write is what moves an app's public identity —
       * its env, `X-Forwarded-Host`, and edge-SSO return host all follow it — and
       * here it is driven by CI-Cloud's answer or by the app's own routing
       * settings, not by a person on this Hub. The audit line names both
       * hostnames, CI-Cloud's record for each and which of the two it was, so a
       * retarget is attributable from the Hub side. An operator's own release
       * logs the same line from `releaseClearedCustomDomain`.
       */
      this.logger.info(
        customDomainAuditLine({
          appUrn,
          previous: current,
          next,
          previousPortalRowId: current ? portalRowIdByDomain.get(current) : undefined,
          nextPortalRowId: next ? portalRowIdByDomain.get(normalizeHostname(next)) : undefined,
          cause: cloudDrivenChange ? 'ci-cloud' : 'settings',
        }),
      );

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
        deferredRevert.add(appUrn);
      }

      /*
       * A restart for this binding can already be owed on the sync that binds it:
       * the app is set to restart on its own, or a confirmation Companion Portal
       * holds for exactly this binding reaches a Hub that lost the binding locally
       * and is binding it again. Handling it only on a later pass would leave the
       * customer's domain dark for another poll interval for no reason.
       *
       * No "still not serving" check here: the binding is being written in this
       * pass, so the environment necessarily still holds the old hostname.
       *
       * ⚠ DECIDED AFTER THE REVERT, and refused when the revert was deferred. A
       * deferred revert means the Hub is about to ask CI-Cloud to wire `current`
       * back, and recreating the container onto `next` now is exactly the bounce
       * the deferral exists to prevent: the app would serve the wrong customer
       * hostname until the re-wire lands, and then need a second recreation the
       * shared cooldown would refuse. `restartingNow` needs no exclusion here —
       * the dispatcher below drops an app that is already restarting as a revert.
       */
      if (next !== null && !deferredRevert.has(appUrn) && app.status === 'running' && !params.skipAutoRestartAppUrns.has(appUrn)) {
        const confirmedForNext = applyRequestedByBinding.get(bindingKey(normalizeHostname(next), target)) === true;
        if (confirmedForNext || app.autoRestartOnDomainChange === true) {
          const why = confirmedForNext ? 'a restart was confirmed' : 'it is set to restart on its own';
          this.logger.info(`[Cloudflare] ${appUrn} is now bound to ${next} and ${why}; restarting it to apply that binding.`);
          applyRequestedAppUrns.push(appUrn);
        }
      }

      const applyingNow = applyRequestedAppUrns.includes(appUrn);

      let message: string;
      if (current === null) {
        message = applyingNow
          ? `[Cloudflare] ${appUrn} is now served on custom domain ${next}; restarting it to publish that hostname to the app.`
          : `[Cloudflare] ${appUrn} is now served on custom domain ${next}; restart it to publish that hostname to the app.`;
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
      await this.restartRevertedApps(revertedAppUrns, 'revert');
    }

    /*
     * Re-attempt reverts whose dispatch failed earlier. Their rows are already
     * settled, so this is the only thing that will ever look at them again.
     *
     * Read BEFORE the applies dispatch: a failure recorded by that dispatch would
     * otherwise be re-attempted in the same pass, a second dispatch the "retry on
     * the next pass" comment below explicitly does not intend.
     */
    const dispatched = new Set(revertedAppUrns);
    const retries = [...this.failedCustomDomainReverts].filter((appUrn) => !dispatched.has(appUrn));

    /*
     * Apply requests go through the same dispatcher as reverts: one place decides
     * that a container is recreated for a custom-domain reason, so the two
     * directions cannot race each other over the same app. An app already
     * restarting as a revert is filtered out rather than queued twice — and so is
     * one the identity-moved check above deliberately spared, since `revertedApps`
     * holding it means this pass concluded its container must not be recreated.
     */
    const sparedByIdentityMove = new Set(identityMoved.map((entry) => entry.appUrn));
    const toApply = applyRequestedAppUrns.filter((appUrn) => !dispatched.has(appUrn) && !sparedByIdentityMove.has(appUrn));
    if (toApply.length > 0) {
      await this.restartRevertedApps(toApply, 'apply');
    }

    if (retries.length > 0) {
      await this.restartRevertedApps(retries, 'revert');
    }

    return [...deferredRevert];
  }

  /**
   * Recreates apps whose public identity changed under them — a custom domain
   * removed (`revert`), one the operator asked to start serving (`apply`), or a
   * public domain CI-Cloud moved the app off (`public-domain-move`).
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
   * ⚠ ONLY A REVERT OR A MOVE IS REMEMBERED ON FAILURE. Its row was settled
   * before the dispatch, so no later pass derives it again — without the retry
   * list nothing would notice the app again, and it would sit forwarding a
   * hostname nothing serves. An apply is the opposite: the next pass re-derives
   * it from `applyRequested`, the env and the app's status, so remembering it
   * would re-dispatch a restart with none of those conditions re-checked — after
   * the operator withdrew the request, or onto an app they have since stopped. A
   * cooldown-skipped revert or move is remembered for the same reason a failed
   * one is: nothing else will ever look at it.
   */
  private async restartRevertedApps(appUrns: AppUrn[], direction: PublicIdentityRestart): Promise<void> {
    const retries =
      direction === 'revert' ? this.failedCustomDomainReverts : direction === 'public-domain-move' ? this.failedPublicDomainMoveRestarts : undefined;

    /*
     * Imported dynamically. `AppLifecycleService` injects this service, so a
     * static import would close the cycle and leave this module's DI tokens
     * undefined at decoration time — the same reason `AppsService` reaches for
     * it this way.
     */
    let lifecycleService: { restartApp(params: { appUrn: AppUrn; skipPull?: boolean; actor: LifecycleActor }): Promise<unknown> } | undefined;
    try {
      const { AppLifecycleService } = await import('./app-lifecycle.service');
      // `ModuleRef.get` throws when a provider cannot be resolved; it does not
      // return undefined.
      lifecycleService = this.moduleRef.get(AppLifecycleService, { strict: false });
    } catch (error) {
      this.logger.debug(
        `[Cloudflare] Lifecycle service unavailable for custom-domain ${direction}: ${error instanceof Error ? error.message : String(error)}`,
      );
      lifecycleService = undefined;
    }

    if (!lifecycleService) {
      for (const appUrn of appUrns) {
        retries?.add(appUrn);
      }
      if (direction === 'revert') {
        this.logger.warn(
          `[Cloudflare] Could not revert ${appUrns.join(', ')} to the platform hostname automatically. ` +
            'Those apps are still forwarding a hostname that no longer resolves — the next sync will try again, ' +
            'or run `cihub public-web repair` to apply it now.',
        );
      } else if (direction === 'public-domain-move') {
        this.logger.warn(
          `[Cloudflare] Could not restart ${appUrns.join(', ')} onto the public domain CI-Cloud serves them on. ` +
            'Those apps are still forwarding a hostname that never resolved — the next sync will try again, ' +
            'or restart the app to apply it now.',
        );
      } else {
        this.logger.warn(
          `[Cloudflare] Could not apply the custom domain bound to ${appUrns.join(', ')} automatically. ` +
            'Those apps are still answering on their platform hostname, so the customer domain stays dark — the next sync ' +
            'will try again, or restart the app to apply it now.',
        );
      }
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
        // A revert or a move has nothing else watching it, so a cooldown skip
        // would strand the app forwarding a dead hostname. Queue the retry.
        retries?.add(appUrn);
        continue;
      }

      /*
       * ⚠ APPLIES AND MOVES. The status an apply was decided on is a snapshot taken
       * before a Portal round trip that can take seconds, and — unlike the bind
       * branch — nothing on that path performs an `updateAppByIdIfStatus` that
       * would fail if a command claimed the app meanwhile. `restartApp` has no
       * status guard of its own and, as a `system` actor, skips the entitlement
       * gate, so without this an app the operator stopped mid-sync is brought back
       * up. A move is re-checked too, and dropped rather than retried: an app that
       * is not running carries no env, and whatever starts it next generates one
       * from the moved row. A revert is not re-checked: its row was settled by a
       * compare-and-set in the same iteration, and an app still injecting a dead
       * `X-Forwarded-Host` has to be recreated whatever it is doing now.
       */
      if (direction !== 'revert') {
        const row = await this.appRepository.getAppByUrn(appUrn).catch(() => null);
        if (row && row.status !== 'running') {
          this.logger.debug(
            direction === 'apply'
              ? `[Cloudflare] Not applying ${appUrn}'s custom domain: it is ${row.status}, not running.`
              : `[Cloudflare] Not restarting ${appUrn} onto its moved public domain: it is ${row.status}, not running, and picks it up when it next starts.`,
          );
          retries?.delete(appUrn);
          continue;
        }
      }

      try {
        // Skip the pull: nothing about the image changed, and a registry round
        // trip would extend the outage this restart exists to end.
        await lifecycleService.restartApp({
          appUrn,
          skipPull: true,
          actor: {
            kind: 'system',
            reason: direction === 'apply' ? 'custom-domain-apply' : direction === 'revert' ? 'custom-domain-revert' : 'public-domain-move',
          },
        });
        // Recorded only once the command is queued. A dispatch that threw
        // restarted nothing, so it must not spend the cooldown. Any restart
        // regenerates the env from the current row, so it settles both kinds of
        // owed restart at once.
        this.lastCustomDomainRestartAt.set(appUrn, now);
        this.failedCustomDomainReverts.delete(appUrn);
        this.failedPublicDomainMoveRestarts.delete(appUrn);
      } catch (error) {
        // Retry a revert or a move on the next pass. Its row was settled before
        // this dispatch, so no later pass would ever look at this app again.
        retries?.add(appUrn);
        const cause = error instanceof Error ? error.message : String(error);
        if (direction === 'revert') {
          this.logger.error(`[Cloudflare] Failed to restart ${appUrn} after its custom domain was removed: ${cause}. Retrying on the next sync.`);
        } else if (direction === 'public-domain-move') {
          this.logger.error(
            `[Cloudflare] Failed to restart ${appUrn} onto the public domain CI-Cloud serves it on: ${cause}. Retrying on the next sync.`,
          );
        } else {
          this.logger.error(
            `[Cloudflare] Failed to restart ${appUrn} to start serving its custom domain: ${cause}. The next sync re-derives this and will try again.`,
          );
        }
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
