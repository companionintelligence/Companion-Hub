import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { buildHubLocalOrigin, buildHubPublicOrigin, buildHubTailnetOrigin, isPrivateHostname, isTailnetHostname } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { TunnelHealthService } from '@/modules/cloudflare/tunnel-health.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { type MemoryConnectionState } from './memory-connection.repository';
import { MemoryConnectionService } from './memory-connection.service';
import { MemoryExchangeClient } from './memory-exchange.client';
import { isMemoryProviderApp } from './memory-provider.predicate';
import { MemoryProviderResolver, type MemoryProviderRuntimeStatus } from './memory-provider.resolver';
import { PendingConnectStore } from './pending-connect.store';

/** Must remain below CI-Server's CONNECT_KEY_TTL_DAYS so apps rotate before their credentials expire. */
const ROTATE_KEY_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
const ROTATE_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Delay before the first sweep so rotation never slows Hub startup. */
const ROTATE_INITIAL_DELAY_MS = 60 * 1000;

/**
 * Maintenance states restore their previous run state, so credential updates must not restart them.
 * Starting apps remain eligible because a queued restart prevents use of a key CI-Server has retired.
 * The `AppStatus` type forces new statuses to be classified here.
 */
const DOWN_APP_STATUSES: readonly AppStatus[] = [
  'stopped',
  'stopping',
  'missing',
  'installing',
  'install_failed',
  'uninstalling',
  'backing_up',
  'restoring',
  'updating',
  'resetting',
];

type ApplyOutcome = 'restarted' | 'restarting' | 'deferred' | 'failed';

/**
 * Postgres returns the zoneless `updated_at` value with a space, which `Date` otherwise reads in local time.
 * Treating the stored UTC value as UTC keeps rotation independent of the container timezone.
 */
function parseUtcMs(value: string): number {
  const trimmed = value.trim();
  const hasZone = /[Zz]$|[+-]\d\d(:?\d\d)?$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`).getTime();
}

/** Machine-readable reasons let the UI explain a disabled Connect button. */
export type ConnectBlockedReason =
  /** ci-memory is not installed; there is nothing to connect to. */
  | 'memory_absent'
  /** ci-memory is installing / booting; a connect would 400 until it is up. */
  | 'memory_starting'
  /** ci-memory is installed but down (stopped, install_failed, …). */
  | 'memory_offline'
  /** This appliance has no public origin at all (unregistered / placeholder domain). */
  | 'hub_not_provisioned'
  /** The Hub's public origin is down and this caller cannot reach the LAN route either. */
  | 'hub_unreachable'
  /** ci-memory only has a LAN address and this caller is off-network. */
  | 'provider_local_only';

/** Launcher availability is caller-scoped because a LAN route is not reachable from every browser. */
export interface ConnectLaunchers {
  /** Public launcher, or null when there is no working public route. */
  connectUrl: string | null;
  /** LAN launcher, or null when there is no LAN origin or this caller can't use it. */
  connectUrlLocal: string | null;
  /** Whether either launcher above is usable by this caller. */
  connectable: boolean;
  /** Why not, when `connectable` is false; null otherwise. */
  reason: ConnectBlockedReason | null;
}

/** State + the browser-reachable launcher URLs a wrapper needs to render its gate. */
export interface MemoryConnectStatus extends ConnectLaunchers {
  state: MemoryConnectionState;
}

/** Preserves the request origin so the flow does not move across cookie scopes. */
export interface RequestOriginContext {
  /** Host header of the incoming request (`192.168.1.5:80`, `hub-x.example.com`). */
  host?: string;
}

/** Richer status for the Hub app-detail UI. */
export interface MemoryConnectUiStatus extends MemoryConnectStatus {
  /** Whether this app is a memory consumer at all (else the UI shows nothing). */
  applicable: boolean;
  /** Whether CI Memory is installed (a row exists) — installing/stopped included. */
  memoryInstalled: boolean;
  /** Whether CI Memory is actually running, i.e. a connect can succeed right now. */
  memoryReady: boolean;
  /** Coarse provider lifecycle, so the UI can say WHY it isn't ready (starting vs offline). */
  providerStatus: MemoryProviderRuntimeStatus;
  /** The UI uses expiry only as a fallback because connected keys rotate automatically. */
  keyExpiresAt: string | null;
}

/**
 * AppLifecycleService is resolved lazily because a static dependency would create a cycle through AppsModule.
 */
@Injectable()
export class MemoryConnectService implements OnApplicationBootstrap, OnModuleDestroy {
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private initialRotationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slow sweep (each rotation restarts an app) overlapping itself. */
  private rotating = false;

  constructor(
    private readonly resolver: MemoryProviderResolver,
    private readonly exchange: MemoryExchangeClient,
    private readonly connections: MemoryConnectionService,
    private readonly pending: PendingConnectStore,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly apps: AppsRepository,
    private readonly tunnelHealth: TunnelHealthService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The delayed initial sweep covers Hubs that restart before the first rotation interval. */
  onApplicationBootstrap(): void {
    this.initialRotationTimer = setTimeout(() => {
      void this.rotateDueKeys();
    }, ROTATE_INITIAL_DELAY_MS);

    this.rotationTimer = setInterval(() => {
      void this.rotateDueKeys();
    }, ROTATE_SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.initialRotationTimer) {
      clearTimeout(this.initialRotationTimer);
      this.initialRotationTimer = null;
    }

    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  /**
   * Rotation retires the old key, so each due app must restart after storing its replacement.
   * Failures remain isolated so one app cannot stop the sweep.
   */
  async rotateDueKeys(): Promise<void> {
    if (this.rotating) {
      return;
    }

    this.rotating = true;

    try {
      const connected = await this.connections.listConnected();

      if (connected.length === 0) {
        return;
      }

      const provider = await this.resolver.findProvider();

      if (!provider) {
        this.logger.warn('[MemoryConnect] rotation sweep skipped: CI Memory not resolvable');

        return;
      }

      const cutoff = Date.now() - ROTATE_KEY_AFTER_MS;

      for (const row of connected) {
        // updatedAt is when the current key was last stored; skip still-fresh keys.
        if (parseUtcMs(row.updatedAt) > cutoff) {
          continue;
        }

        const appUrn = row.appUrn as AppUrn;

        try {
          // Rotating a down app would retire its working key without applying the replacement.
          // Leaving `updatedAt` untouched lets the next sweep retry as soon as the app returns.
          if (await this.isAppDown(appUrn)) {
            this.logger.debug(`[MemoryConnect] skipping key rotation for ${appUrn}: app is not running`);

            continue;
          }

          const rotated = await this.exchange.rotate(provider.internalUrl, appUrn);
          await this.connections.storeConnected(appUrn, provider.internalUrl, rotated.key, rotated.expiresAt, row.hubUserId);

          // A running container uses the retired key until its environment is regenerated.
          // Retry once, then log loudly because the fresh `updatedAt` delays another rotation attempt.
          let outcome = await this.applyConnection(appUrn, 'await');

          if (outcome === 'failed') {
            const retry = await this.applyConnection(appUrn, 'await');

            // A failed restart marks the app stopped, so a deferred retry still represents a rotation failure.
            outcome = retry === 'deferred' ? 'failed' : retry;
          }

          if (outcome === 'restarted') {
            this.logger.info(`[MemoryConnect] rotated memory key for ${appUrn}`);
          } else if (outcome === 'deferred') {
            // The app went down after the liveness check, but its next start will use the rewritten environment.
            this.logger.info(`[MemoryConnect] rotated memory key for ${appUrn} (app went down; applies on next start)`);
          } else {
            this.logger.error(
              `[MemoryConnect] rotated ${appUrn} but could not restart it to apply the new key; it is DOWN or running on the retired key until it is started again`,
            );
          }
        } catch (err) {
          this.logger.warn(`[MemoryConnect] key rotation failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.logger.error('[MemoryConnect] rotation sweep failed', err);
    } finally {
      this.rotating = false;
    }
  }

  async startConnect(appUrn: AppUrn, next: string | undefined, userId: string, origin?: RequestOriginContext): Promise<string> {
    // Only the browser leg needs the public consent URL, so only this path pays for an availability probe.
    const provider = await this.resolver.findProvider({ withPublicUrl: true });

    if (!provider) {
      throw new BadRequestException('CI Memory is not installed');
    }

    if (!provider.publicUrl) {
      throw new BadRequestException('CI Memory is not reachable yet; try again once it is running');
    }

    // Keep the callback, interstitial, and session cookie on one origin to avoid a second login.
    const hubOrigin = await this.resolveFlowOrigin(origin);

    if (!hubOrigin) {
      throw new BadRequestException('This Hub has no origin to return to');
    }

    // Restrict `next` to trusted origins so consent cannot become a phishing handoff.
    const safeNext = await this.resolveSafeNext(next, appUrn, hubOrigin, origin);

    const state = this.pending.create(appUrn, safeNext, userId);
    const callbackUrl = `${hubOrigin}/api/memory-connect/callback`;
    const consentUrl = new URL('/api/connect', new URL(provider.publicUrl).origin);

    consentUrl.searchParams.set('app', appUrn);
    consentUrl.searchParams.set('state', state);
    consentUrl.searchParams.set('return', callbackUrl);

    // A display name keeps the consent prompt from exposing an internal URN.
    const appName = await this.resolver.getAppName(appUrn);
    if (appName) {
      consentUrl.searchParams.set('app_name', appName);
    }

    this.logger.info(`[MemoryConnect] starting connect for ${appUrn}`);

    return consentUrl.toString();
  }

  /**
   * The callback schedules rather than awaits the restart so browser navigation cannot time out.
   * Same-code replays reuse the recorded redirect, while foreign users receive an indistinguishable failure to prevent login CSRF and code injection.
   * Once the owner resolves the state, downstream failures return to the originating app instead of dead-ending on the Hub.
   */
  async handleCallback(code: string, state: string, currentUserId: string): Promise<{ next: string; error?: boolean }> {
    const attempt = this.pending.consume(state, currentUserId, this.hashCode(code));

    if (attempt.outcome === 'unknown') {
      throw new BadRequestException('Invalid or expired connect state');
    }

    if (attempt.outcome === 'foreign') {
      this.logger.error(`[MemoryConnect] callback user mismatch: state not owned by user ${currentUserId}`);

      // Match the unknown-state landing so a non-initiator cannot probe state ownership or the app.
      return { next: '/?memoryConnect=error', error: true };
    }

    if (attempt.outcome === 'replayed') {
      this.logger.info(`[MemoryConnect] callback replayed for ${attempt.appUrn}; skipping exchange`);

      // Reuse the recorded redirect rather than assuming the replayed attempt succeeded.
      return { next: attempt.redirect };
    }

    const result = await this.completeConnect(attempt.appUrn, attempt.next, code, currentUserId);

    // Recording every outcome makes a replay preserve success, failure, and deferral.
    this.pending.recordOutcome(state, result.next);

    return result;
  }

  private async completeConnect(appUrn: AppUrn, next: string, code: string, hubUserId: string): Promise<{ next: string; error?: boolean }> {
    const provider = await this.resolver.findProvider();

    if (!provider) {
      this.logger.error(`[MemoryConnect] callback with no resolvable provider for ${appUrn}`);

      return { next, error: true };
    }

    try {
      const exchanged = await this.exchange.exchange(provider.internalUrl, code);

      // Defense in depth: the code must be for the same app the flow started for.
      if (exchanged.appUrn !== appUrn) {
        this.logger.error(`[MemoryConnect] app mismatch on exchange: expected ${appUrn}, got ${exchanged.appUrn}`);

        // Revoke a mismatched exchange so its unmanaged key does not remain valid.
        await this.exchange.revoke(provider.internalUrl, exchanged.appUrn);

        return { next, error: true };
      }

      // The container shares the Hub's internal network, so it stores the internal provider URL.
      await this.connections.storeConnected(appUrn, provider.internalUrl, exchanged.key, exchanged.expiresAt, hubUserId);
      const applied = await this.applyConnection(appUrn, 'schedule');

      if (applied === 'restarting') {
        return { next: this.buildFinishingPath(appUrn, next) };
      }

      // Without a scheduled restart, the interstitial has nothing to watch.
      return { next };
    } catch (err) {
      this.logger.error(`[MemoryConnect] exchange failed for ${appUrn}`, err);

      return { next, error: true };
    }
  }

  /** Tombstones make deny redirects refresh-safe, while foreign users learn neither the state nor app URL. */
  abandonConnect(state: string | undefined, currentUserId: string, error?: string): string {
    const attempt = this.pending.consume(state, currentUserId);

    if (attempt.outcome === 'unknown' || attempt.outcome === 'foreign') {
      // Preserve the provider error so the dashboard can distinguish denial from authentication failure.
      return error ? `/?memoryConnect=${encodeURIComponent(error)}` : '/';
    }

    if (error) {
      this.logger.warn(`[MemoryConnect] connect abandoned for ${attempt.appUrn}: provider reported '${error}'`);
    } else {
      this.logger.info(`[MemoryConnect] connect declined by the user for ${attempt.appUrn}`);
    }

    return attempt.redirect;
  }

  /** Hashing distinguishes a replay from a fresh grant without retaining the raw one-time code. */
  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Null launchers keep the wrapper from blocking an app on a connect flow that would fail.
   * The provider check stays DB-only because this method runs on the status-poll path.
   */
  async getStatus(appUrn: AppUrn, origin?: RequestOriginContext, hubUserId?: string | null): Promise<MemoryConnectStatus> {
    if (hubUserId) {
      await this.ensureCurrentUserOwnsRunningToken(appUrn, hubUserId);
    }

    const [state, providerInfo] = await Promise.all([
      this.connections.getState(appUrn, hubUserId),
      // A transient provider lookup failure withholds launchers instead of failing the independent state poll.
      this.resolver.getProviderRuntimeInfo().catch(() => ({ status: 'absent' as const, localOnly: false })),
    ]);

    const launchers = await this.resolveLaunchers({
      appUrn,
      providerStatus: providerInfo.status,
      providerLocalOnly: providerInfo.localOnly,
      origin,
    });

    // This blocking gate fails open for app access while retaining a reason for diagnostics.
    return { state, ...launchers };
  }

  async getUiStatus(appUrn: AppUrn, origin?: RequestOriginContext, hubUserId?: string | null): Promise<MemoryConnectUiStatus> {
    // Most apps are not memory consumers, so avoid provider and connection lookups for them.
    if (!(await this.resolver.isConsumerApp(appUrn))) {
      return {
        applicable: false,
        memoryInstalled: false,
        memoryReady: false,
        providerStatus: 'absent',
        state: 'unconfigured',
        connectUrl: null,
        connectUrlLocal: null,
        connectable: false,
        reason: null,
        keyExpiresAt: null,
      };
    }

    // A provider row that is still installing must not read as ready.
    if (hubUserId) {
      await this.ensureCurrentUserOwnsRunningToken(appUrn, hubUserId);
    }

    const [providerInfo, row] = await Promise.all([
      this.resolver.getProviderRuntimeInfo().catch(() => ({ status: 'absent' as const, localOnly: false })),
      this.connections.getRow(appUrn, hubUserId),
    ]);

    const providerStatus = providerInfo.status;

    const memoryInstalled = providerStatus !== 'absent';
    const memoryReady = providerStatus === 'ready';

    let effectiveState = row?.state ?? 'unconfigured';
    // Safari rejects Postgres's space-separated timestamp, so never expose the raw value.
    let keyExpiresAt = this.toIsoInstant(row?.keyExpiresAt);

    // Validate keys only while CI Memory is ready; otherwise every poll would pay a network timeout.
    // A rejected key is cleared so the app prompts again instead of silently using dead credentials.
    if (effectiveState === 'connected' && memoryReady) {
      const provider = await this.resolver.findProvider();
      // Decrypt from the row already loaded above — avoids a second findByAppUrn.
      const creds = this.connections.credsFromRow(row);
      if (provider && creds && !(await this.exchange.isKeyValid(provider.internalUrl, creds.token))) {
        // Restarting removes the injected dead credential immediately instead of waiting for an unrelated restart.
        await this.connections.clear(appUrn);
        await this.applyConnection(appUrn, 'await');
        effectiveState = 'unconfigured';
        keyExpiresAt = null;
        this.logger.info(`[MemoryConnect] cleared stale key for ${appUrn} (ci-memory rejected it)`);
      }
    }

    // This non-blocking surface keeps Connect visible and uses `reason` to explain why it is disabled.
    const launchers = await this.resolveLaunchers({
      appUrn,
      providerStatus,
      providerLocalOnly: providerInfo.localOnly,
      origin,
    });

    return {
      applicable: true,
      memoryInstalled,
      memoryReady,
      providerStatus,
      state: effectiveState,
      ...launchers,
      keyExpiresAt,
    };
  }

  /**
   * When the running container token belongs to a different Hub person, revoke
   * it and return that row to unconfigured so the current person is prompted
   * to connect as themselves.
   */
  private async ensureCurrentUserOwnsRunningToken(appUrn: AppUrn, hubUserId: string): Promise<void> {
    const latest = await this.connections.getRow(appUrn);
    if (latest?.state !== 'connected' || !latest.hubUserId) {
      return;
    }

    if (String(latest.hubUserId) === String(hubUserId)) {
      return;
    }

    const provider = await this.resolver.findProvider();
    if (provider) {
      const creds = this.connections.credsFromRow(latest);
      if (creds) {
        await this.exchange.revoke(provider.internalUrl, appUrn);
      }
    }

    await this.connections.clear(appUrn, latest.hubUserId);
    await this.applyConnection(appUrn, 'schedule');
    this.logger.info(`[MemoryConnect] stale connect for ${appUrn}: token owner ${latest.hubUserId} ≠ current Hub user ${hubUserId}`);
  }

  /** Record that the user chose not to connect (do not re-prompt). */
  async skip(appUrn: AppUrn, hubUserId?: string | null): Promise<void> {
    await this.connections.markSkipped(appUrn, hubUserId);
  }

  /**
   * Keep the local connection when revocation fails so the UI cannot claim a still-valid key is disconnected.
   * If the provider no longer exists, clearing locally is sufficient.
   */
  async disconnect(appUrn: AppUrn, hubUserId?: string | null): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      const revoked = await this.exchange.revoke(provider.internalUrl, appUrn);
      if (!revoked) {
        throw new ServiceUnavailableException('Could not revoke the memory key on CI Memory; the app is still connected. Please try again.');
      }
    }

    await this.connections.clear(appUrn, hubUserId);
    await this.applyConnection(appUrn, 'await');
  }

  /**
   * The provider and stale app rows do not count as installed consumers.
   * Only malformed URNs are skipped; DB and resolver errors propagate so destructive guards fail closed.
   */
  async listConnectedConsumers(): Promise<Array<{ appUrn: string; name: string }>> {
    const rows = await this.connections.listConnected();
    const consumers: Array<{ appUrn: string; name: string }> = [];

    for (const row of rows) {
      const urn = row.appUrn as AppUrn;

      // Parse separately so later DB and resolver failures can still fail the guard closed.
      let fallbackName: string;
      try {
        fallbackName = extractAppUrn(urn).appName;
      } catch (err) {
        this.logger.warn(`[MemoryConnect] skipping unparseable connection row ${row.appUrn}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (isMemoryProviderApp({ urn })) {
        continue;
      }

      if (!(await this.apps.getAppByUrn(urn))) {
        continue;
      }

      const name = (await this.resolver.getAppName(urn)) ?? fallbackName;
      consumers.push({ appUrn: row.appUrn, name });
    }

    return consumers;
  }

  /** Revocation is best-effort during uninstall because a failure must not block app removal. */
  async handleUninstall(appUrn: AppUrn): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      const revoked = await this.exchange.revoke(provider.internalUrl, appUrn);
      if (!revoked) {
        this.logger.error(`[MemoryConnect] uninstall of ${appUrn}: key revocation failed; it stays valid on CI-Server until its TTL expires`);
      }
    }

    await this.connections.remove(appUrn);

    // Removing the provider bypasses lazy key validation, so clear consumers now instead of leaving dead credentials.
    if (isMemoryProviderApp({ urn: appUrn })) {
      await this.clearConsumersAfterProviderUninstall(appUrn);
    }
  }

  /** Consumer cleanup is best-effort because no provider remains to revoke against. */
  private async clearConsumersAfterProviderUninstall(providerUrn: AppUrn): Promise<void> {
    const connected = await this.connections.listConnected();
    const consumers = connected.filter((row) => row.appUrn !== providerUrn);

    // Parallel dispatch bounds cleanup to the slowest restart, and allSettled prevents one failure from stranding the rest (#906).
    await Promise.allSettled(
      consumers.map(async (row) => {
        const consumerUrn = row.appUrn as AppUrn;

        try {
          await this.connections.clear(consumerUrn);
          await this.applyConnection(consumerUrn, 'await');
          this.logger.info(`[MemoryConnect] cleared ${consumerUrn}: CI Memory was uninstalled`);
        } catch (err) {
          this.logger.error(`[MemoryConnect] failed to clear ${consumerUrn} after CI Memory uninstall`, err);
        }
      }),
    );
  }

  /** Must match the `CI_HUB_ORIGINS` value that AppHelpers injects because CI Memory allowlists return URLs. */
  private async hubOrigin(): Promise<string | null> {
    const org = await this.deviceRegistration.getFirstDeviceRegistration();
    const domain = this.config.getConfig().domain;

    return buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain });
  }

  /** The LAN fallback must also appear in `CI_HUB_ORIGINS` so CI Memory accepts its callback. */
  private hubLocalOrigin(): string | null {
    const { userSettings } = this.config.getConfig();

    return buildHubLocalOrigin({ internalIp: userSettings.internalIp, port: userSettings.port });
  }

  /**
   * The tailnet origin must appear in `CI_HUB_ORIGINS` so CI Memory accepts its callback.
   * Lazy resolution avoids an AppsModule cycle, and cached status avoids an exec on every poll.
   */
  private async hubTailnetOrigin(): Promise<string | null> {
    try {
      const { TailscaleService } = await import('../tailscale/tailscale.service');
      const tailscale = this.moduleRef.get(TailscaleService, { strict: false });

      if (!tailscale) {
        return null;
      }

      const status = await tailscale.getStatusCached();

      return buildHubTailnetOrigin({ connected: status.connected, httpsAvailable: status.httpsAvailable, nodeFqdn: status.nodeFqdn });
    } catch (err) {
      // VPN failure withholds only the tailnet launcher, but remains traceable for diagnostics.
      this.logger.debug(`[MemoryConnect] tailnet origin unavailable: ${err instanceof Error ? err.message : String(err)}`);

      return null;
    }
  }

  /**
   * Only ready providers get launchers, and confirmed remote callers cannot use a local-only provider.
   * Tailnet callers stay on their own origin (CI-Engineering#78); otherwise public is preferred and LAN is limited to confirmed local callers.
   * Provider locality comes from the DB so status polling stays cheap.
   */
  private async resolveLaunchers(input: {
    appUrn: AppUrn;
    providerStatus: MemoryProviderRuntimeStatus;
    origin?: RequestOriginContext;
    providerLocalOnly?: boolean;
  }): Promise<ConnectLaunchers> {
    const blocked = (reason: ConnectBlockedReason): ConnectLaunchers => ({
      connectUrl: null,
      connectUrlLocal: null,
      connectable: false,
      reason,
    });

    if (input.providerStatus !== 'ready') {
      return blocked(
        input.providerStatus === 'absent' ? 'memory_absent' : input.providerStatus === 'starting' ? 'memory_starting' : 'memory_offline',
      );
    }

    // Block only confirmed remote callers; an ambiguous rewritten host may belong to a valid LAN visitor.
    const locality = this.callerLocality(input.origin?.host);
    const callerIsLocal = locality === 'local';

    if (input.providerLocalOnly && locality === 'remote') {
      this.logger.warn(
        `[MemoryConnect] ${input.appUrn}: CI Memory is exposed on the local network only; an off-network caller cannot reach its consent page`,
      );

      return blocked('provider_local_only');
    }

    // Resolve VPN status only for tailnet callers so other polls avoid the extra read.
    if (locality === 'tailnet') {
      const tailnetOrigin = await this.hubTailnetOrigin();

      if (tailnetOrigin) {
        return {
          connectUrl: this.launcherFor(tailnetOrigin, input.appUrn),
          connectUrlLocal: null,
          connectable: true,
          reason: null,
        };
      }

      this.logger.warn(
        `[MemoryConnect] ${input.appUrn}: caller arrived on a tailnet host but the Private VPN reports no usable origin; falling back to the public route`,
      );
    }

    const publicOrigin = await this.hubOrigin();
    const localOrigin = this.hubLocalOrigin();
    const health = this.tunnelHealth.getHealth();

    // Treat unknown tunnel health as usable so a cold Hub does not suppress its public route.
    const publicUsable = Boolean(publicOrigin) && health !== 'down';

    if (publicUsable && publicOrigin) {
      return {
        connectUrl: this.launcherFor(publicOrigin, input.appUrn),
        // Keep LAN available to local clients that need to pin their origin.
        connectUrlLocal:
          callerIsLocal && localOrigin && this.localOriginReachableBy(localOrigin, input.origin?.host)
            ? this.launcherFor(localOrigin, input.appUrn)
            : null,
        connectable: true,
        reason: null,
      };
    }

    // Never offer the LAN fallback to a caller that cannot route to it.
    if (callerIsLocal && localOrigin && this.localOriginReachableBy(localOrigin, input.origin?.host)) {
      this.logger.info(
        `[MemoryConnect] ${input.appUrn}: public origin unusable (tunnel ${health}); offering the LAN launcher ${localOrigin} to a local caller`,
      );

      return { connectUrl: null, connectUrlLocal: this.launcherFor(localOrigin, input.appUrn), connectable: true, reason: null };
    }

    return blocked(publicOrigin ? 'hub_unreachable' : 'hub_not_provisioned');
  }

  private launcherFor(origin: string, appUrn: AppUrn): string {
    return `${origin}/api/memory-connect/start?app=${encodeURIComponent(appUrn)}`;
  }

  /**
   * Locality needs four states because unsafe launcher choices fail in opposite directions.
   * A rewritten local-domain host is ambiguous, so `unknown` withholds LAN without blocking a potentially local caller.
   * Private IP literals and loopback remain trustworthy because the tunnel does not synthesize them.
   */
  private callerLocality(callerHost: string | undefined): 'tailnet' | 'local' | 'remote' | 'unknown' {
    const hostname = this.hostnameOf(callerHost);

    if (!hostname) {
      return 'unknown';
    }

    // Tailscale ranges must be classified before private hosts to avoid LAN launchers for VPN callers (CI-Engineering#78).
    if (isTailnetHostname(hostname)) {
      return 'tailnet';
    }

    // Match AppHelpers precedence so routing and app environments agree on the rewritten suffix.
    const config = this.config.getConfig();
    const localDomain = (config.userSettings?.localDomain || config.localDomain)?.trim().toLowerCase();
    const candidate = hostname.toLowerCase();

    if (localDomain && (candidate === localDomain || candidate.endsWith(`.${localDomain}`))) {
      return 'unknown';
    }

    return isPrivateHostname(hostname) ? 'local' : 'remote';
  }

  /**
   * A wildcard bind resolves to loopback, which points non-loopback visitors at their own machine.
   * Therefore, loopback origins are offered only to loopback callers.
   */
  private localOriginReachableBy(localOrigin: string, callerHost: string | undefined): boolean {
    const localHostname = this.hostnameOf(localOrigin);

    if (localHostname !== '127.0.0.1' && localHostname !== '::1') {
      return true;
    }

    const callerHostname = this.hostnameOf(callerHost);

    return callerHostname === 'localhost' || callerHostname === '127.0.0.1' || callerHostname === '::1';
  }

  /**
   * Invalid values fail toward withholding a LAN launcher.
   * Bare IPv6 normalization keeps loopback checks consistent with browser-origin construction.
   */
  private hostnameOf(hostOrUrl: string | null | undefined): string | null {
    // Repeated query keys can arrive as arrays, so reject non-strings before calling `.trim`.
    if (typeof hostOrUrl !== 'string') {
      return null;
    }

    const value = hostOrUrl.trim();

    if (!value) {
      return null;
    }

    try {
      const url = new URL(value.includes('://') ? value : `http://${value}`);

      // Embedded userinfo can disguise a private hostname and bypass locality checks.
      if (url.username || url.password) {
        return null;
      }

      const hostname = url.hostname;

      return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    } catch {
      return null;
    }
  }

  /** Restrict `next` to the Hub and connecting app origins to prevent an open redirect after consent. */
  private async resolveSafeNext(next: string | undefined, appUrn: AppUrn, hubOrigin: string, origin?: RequestOriginContext): Promise<string> {
    const appAccessUrls = await this.resolver.getAppAccessUrls(appUrn);
    const appPublicUrl = appAccessUrls.publicUrl;
    // Allow both Hub and app origins so a LAN flow is not relocated to a different cookie scope.
    // The memory provider is not a valid landing page.
    const allowedOrigins = new Set<string>([hubOrigin]);
    const localHubOrigin = this.hubLocalOrigin();
    // A loopback LAN origin is unsafe for non-loopback callers because it redirects them to their own machine.
    if (localHubOrigin && this.localOriginReachableBy(localHubOrigin, origin?.host)) {
      allowedOrigins.add(localHubOrigin);
    }

    // A tailnet origin cannot collapse to attacker-controlled loopback.
    const tailnetHubOrigin = await this.hubTailnetOrigin();
    if (tailnetHubOrigin) {
      allowedOrigins.add(tailnetHubOrigin);
    }

    for (const candidate of [appAccessUrls.publicUrl, appAccessUrls.localUrl]) {
      if (!candidate) {
        continue;
      }

      try {
        allowedOrigins.add(new URL(candidate).origin);
      } catch {
        /* ignore unparseable */
      }
    }

    if (next) {
      try {
        if (allowedOrigins.has(new URL(next).origin)) {
          return next;
        }
      } catch {
        /* fall through to a safe default */
      }
    }

    // Prefer a serving primary route, but let local callers fall back to LAN.
    // A remote caller keeps the public URL because a private fallback can never become reachable for it.
    const callerIsRemote = this.callerLocality(origin?.host) === 'remote';

    if (appPublicUrl && (appAccessUrls.primaryAvailable !== false || callerIsRemote)) {
      return appPublicUrl;
    }

    return appAccessUrls.localUrl ?? appPublicUrl ?? hubOrigin;
  }

  /** Normalize Postgres timestamps because Safari rejects their space-separated representation. */
  private toIsoInstant(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * Preserve the browser's origin only when it matches one the Hub serves, preventing a spoofed Host from becoming a redirect.
   * LAN remains the fallback so an unregistered appliance can complete the flow locally.
   */
  private async resolveFlowOrigin(origin?: RequestOriginContext): Promise<string | null> {
    const publicOrigin = await this.hubOrigin();
    const localOrigin = this.hubLocalOrigin();
    const requestHostname = this.hostnameOf(origin?.host);
    // Resolve VPN status only when the request host indicates a tailnet caller.
    const tailnetOrigin = requestHostname && isTailnetHostname(requestHostname) ? await this.hubTailnetOrigin() : null;

    for (const candidate of [publicOrigin, localOrigin, tailnetOrigin]) {
      if (candidate && requestHostname && this.hostnameOf(candidate) === requestHostname) {
        return candidate;
      }
    }

    return publicOrigin ?? localOrigin;
  }

  /** A relative path keeps the callback and interstitial on the same Hub origin. */
  private buildFinishingPath(appUrn: AppUrn, next: string): string {
    return `/memory-connect/finishing?${new URLSearchParams({ app: appUrn, next }).toString()}`;
  }

  /**
   * Down apps get a rewritten environment without a restart, preserving user intent while removing stale credentials.
   * Live apps restart; background callers await the real outcome, while browser callbacks return once restart is scheduled.
   * Every path skips pulls because this change needs only the existing image and must not depend on registry availability.
   */
  private async applyConnection(appUrn: AppUrn, restart: 'await'): Promise<'restarted' | 'deferred' | 'failed'>;
  private async applyConnection(appUrn: AppUrn, restart: 'schedule'): Promise<'restarting' | 'deferred' | 'failed'>;
  private async applyConnection(appUrn: AppUrn, restart: 'await' | 'schedule'): Promise<ApplyOutcome> {
    try {
      const lifecycle = this.moduleRef.get(AppLifecycleService, { strict: false });

      if (await this.isAppDown(appUrn)) {
        const applied = await lifecycle.regenerateAppEnv(appUrn);

        if (!applied) {
          this.logger.error(`[MemoryConnect] could not rewrite ${appUrn}'s env while it is down; its creds are stale on disk`);

          return 'failed';
        }

        this.logger.debug(`[MemoryConnect] ${appUrn} is not running — env rewritten in place; it applies on next start`);

        return 'deferred';
      }

      if (restart === 'schedule') {
        await lifecycle.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'memory-connect' } });

        return 'restarting';
      }

      const restarted = await lifecycle.restartAppAndWait({ appUrn, skipPull: true });

      return restarted ? 'restarted' : 'failed';
    } catch (err) {
      this.logger.error(`[MemoryConnect] failed to apply the connection change to ${appUrn}`, err);

      return 'failed';
    }
  }

  private async isAppDown(appUrn: AppUrn): Promise<boolean> {
    const app = await this.apps.getAppByUrn(appUrn);

    if (!app) {
      return true;
    }

    return DOWN_APP_STATUSES.includes(app.status);
  }
}
