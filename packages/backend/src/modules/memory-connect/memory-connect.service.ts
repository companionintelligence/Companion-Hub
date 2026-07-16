import { BadRequestException, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { type MemoryConnectionState } from './memory-connection.repository';
import { MemoryConnectionService } from './memory-connection.service';
import { MemoryExchangeClient } from './memory-exchange.client';
import { isMemoryProviderApp } from './memory-provider.predicate';
import { MemoryProviderResolver, type MemoryProviderRuntimeStatus } from './memory-provider.resolver';
import { PendingConnectStore } from './pending-connect.store';

/**
 * Rotate a connected key once it reaches this age — comfortably before
 * CI-Server's ~90-day key expiry (CONNECT_KEY_TTL_DAYS) — so a running agent
 * never wakes up to a dead credential. MUST stay below that TTL.
 */
const ROTATE_KEY_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
/** How often to sweep connected apps for keys that are due to rotate. */
const ROTATE_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Delay before the first sweep so rotation never slows Hub startup. */
const ROTATE_INITIAL_DELAY_MS = 60 * 1000;

/**
 * Statuses in which an app is down, or not there at all — the only ones for which
 * applying new creds must NOT restart the container.
 *
 * Includes the stop-first maintenance states (`backing_up`, `restoring`, `updating`,
 * `resetting`): each one runs `compose stop` before it works, and each one's own
 * completion handler restores the previous run-state through the env-regenerating
 * `startApp`. Restarting an app mid-backup would therefore not just churn its status —
 * it would leave an app the user had STOPPED running once the backup finished.
 *
 * `starting` / `restarting` are deliberately absent: those really are on their way up,
 * and a restart queued behind the in-flight command is how a live app avoids being
 * stranded on a key CI-Server has already retired.
 *
 * Typed against `AppStatus` so a status added to the enum has to be classified here,
 * rather than silently defaulting to "live, restart it".
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

/**
 * `restarted` — the restart completed and the container is running the new env.
 * `deferred` — the app is down, so its env was rewritten in place and applies on its
 * next start (nothing more to do). `failed` — the creds could not be applied, and the
 * app may be stranded on a key CI-Server has already retired.
 */
type ApplyOutcome = 'restarted' | 'deferred' | 'failed';

/**
 * Parse a Postgres timestamp as UTC milliseconds. `updated_at` is a zoneless
 * `timestamp` that Postgres returns space-separated (e.g. `2026-07-09 12:00:00`),
 * which `new Date()` would read as LOCAL time. It is written as UTC (via
 * `new Date().toISOString()`), so read it back as UTC too — this keeps the
 * rotation age-gate independent of the container's timezone.
 */
function parseUtcMs(value: string): number {
  const trimmed = value.trim();
  const hasZone = /[Zz]$|[+-]\d\d(:?\d\d)?$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`).getTime();
}

/** State + the browser-reachable launcher URL a wrapper needs to render its gate. */
export interface MemoryConnectStatus {
  state: MemoryConnectionState;
  /** Hub launcher URL to start the connect flow, or null if it can't be built. */
  connectUrl: string | null;
}

/** Richer status for the Hub app-detail UI. */
export interface MemoryConnectUiStatus extends MemoryConnectStatus {
  /** Whether this app is a memory consumer at all (else the UI shows nothing). */
  applicable: boolean;
  /** Whether Companion Memory is installed (a row exists) — installing/stopped included. */
  memoryInstalled: boolean;
  /** Whether Companion Memory is actually running, i.e. a connect can succeed right now. */
  memoryReady: boolean;
  /** Coarse provider lifecycle, so the UI can say WHY it isn't ready (starting vs offline). */
  providerStatus: MemoryProviderRuntimeStatus;
  /**
   * ISO instant the current key expires, when connected — else null. The key
   * auto-rotates before this, so the UI frames it as "renews automatically" and
   * only meaningful if the app is disconnected before the next rotation.
   */
  keyExpiresAt: string | null;
}

/**
 * Orchestrates the browser + server-to-server halves of the memory-connect
 * flow, tying together the resolver, exchange client, encrypted store, and the
 * `state`-nonce guard.
 *
 * The apply-and-restart step reaches AppLifecycleService lazily via ModuleRef —
 * this module already imports AppsModule, and going through the DI graph to
 * app-lifecycle statically would form a cycle (app-lifecycle depends on apps).
 */
@Injectable()
export class MemoryConnectService implements OnApplicationBootstrap, OnModuleDestroy {
  /** Periodic rotation-sweep timer; null until bootstrap / after shutdown. */
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot initial-sweep timer (fires shortly after boot). */
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
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Start the key-rotation sweep. Connect keys expire (~90 days on CI-Server) on
   * the assumption the Hub rotates them first; this is the driver that does so.
   * An initial delayed sweep covers Hubs that restart before the first interval.
   */
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
   * Rotate the memory key of every connected app whose current key is older than
   * {@link ROTATE_KEY_AFTER_MS}. Rotation re-mints on CI-Server (which retires
   * the old key), so each rotated app is restarted to pick up the new key —
   * hence the age gate, so we rotate rarely and only when actually due. Runs on
   * a timer; never throws (a failure for one app is logged and skipped).
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
        this.logger.warn('[MemoryConnect] rotation sweep skipped: Companion Memory not resolvable');

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
          // Check liveness BEFORE rotating. Rotation retires the old key on CI-Server,
          // so a rotation we then cannot apply leaves the app 401ing — and because
          // storeConnected bumps `updatedAt`, the age gate above would skip this app for
          // another ROTATE_KEY_AFTER_MS, turning a transient miss into a 60-day outage.
          // Skipping a down app instead leaves its key (and `updatedAt`) untouched, so it
          // is simply picked up by the first sweep after it comes back up.
          if (await this.isAppDown(appUrn)) {
            this.logger.debug(`[MemoryConnect] skipping key rotation for ${appUrn}: app is not running`);

            continue;
          }

          const rotated = await this.exchange.rotate(provider.internalUrl, appUrn);
          await this.connections.storeConnected(appUrn, provider.internalUrl, rotated.key, rotated.expiresAt);

          // The new key is stored + valid, but CI-Server has already retired the
          // old one, so a running container 401s until its env is regenerated.
          // Retry once for a transient failure; if it still fails, log LOUDLY — the
          // age gate now skips this app for ROTATE_KEY_AFTER_MS (its updatedAt is
          // fresh), so a silent failure would strand it on the retired key until an
          // unrelated restart (env generation re-reads the new key).
          let outcome = await this.applyAndRestart(appUrn);

          if (outcome === 'failed') {
            const retry = await this.applyAndRestart(appUrn);

            // A retry that comes back 'deferred' does NOT mean the app was down on
            // purpose: a failed restart marks the app `stopped`, so the retry sees a
            // down app and defers. This app was running when we rotated — the sweep
            // itself knocked it over. Keep it a failure so it gets the loud warning
            // rather than the benign "applies on next start" note.
            outcome = retry === 'deferred' ? 'failed' : retry;
          }

          if (outcome === 'restarted') {
            this.logger.info(`[MemoryConnect] rotated memory key for ${appUrn}`);
          } else if (outcome === 'deferred') {
            // It went down between the liveness check and the apply; its env now holds
            // the new key, so the next start picks it up.
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

  /**
   * Begin a connect attempt: verify ci-memory is installed + reachable, mint a
   * `state` nonce bound to the app, and return the ci-memory consent URL the
   * browser should be redirected to. `next` is where the user lands after the
   * connection is applied.
   */
  async startConnect(appUrn: AppUrn, next: string | undefined, userId: string): Promise<string> {
    // The browser leg needs the public consent URL, so this is the one caller
    // that pays for the availability probe.
    const provider = await this.resolver.findProvider({ withPublicUrl: true });

    if (!provider) {
      throw new BadRequestException('Companion Memory is not installed');
    }

    if (!provider.publicUrl) {
      throw new BadRequestException('Companion Memory is not reachable yet; try again once it is running');
    }

    const hubOrigin = await this.hubOrigin();

    if (!hubOrigin) {
      throw new BadRequestException('This Hub has no public origin to return to');
    }

    // Open-redirect guard: only ever land the browser back on the Hub or on the
    // connecting app's own public URL. An attacker-supplied `next` (e.g. a
    // phishing hand-off right after the consent ceremony) falls back to the app.
    const safeNext = await this.resolveSafeNext(next, appUrn, hubOrigin);

    const state = this.pending.create(appUrn, safeNext, userId);
    const callbackUrl = `${hubOrigin}/api/memory-connect/callback`;
    const consentUrl = new URL('/api/connect', new URL(provider.publicUrl).origin);

    consentUrl.searchParams.set('app', appUrn);
    consentUrl.searchParams.set('state', state);
    consentUrl.searchParams.set('return', callbackUrl);

    // Pass the app's display name so the consent page can name the requester
    // ("<app> is requesting access…") instead of falling back to the raw URN.
    const appName = await this.resolver.getAppName(appUrn);
    if (appName) {
      consentUrl.searchParams.set('app_name', appName);
    }

    this.logger.info(`[MemoryConnect] starting connect for ${appUrn}`);

    return consentUrl.toString();
  }

  /**
   * Handle the browser returning from ci-memory: validate `state`, exchange the
   * one-time code for the key (server-to-server), persist it, apply it to the
   * app (regenerate env + restart), and return where to send the browser next.
   *
   * Only an unknown/expired `state` throws (there is no app to return to). Once
   * the state is resolved, ANY downstream failure (provider gone, app mismatch,
   * user mismatch, exchange error) still returns the originating app's URL with
   * `error: true`, so the user lands back on their app (where the interstitial
   * re-appears) rather than dead-ending on the Hub dashboard.
   */
  async handleCallback(code: string, state: string, currentUserId: string): Promise<{ next: string; error?: boolean }> {
    const attempt = this.pending.consume(state);

    if (!attempt) {
      throw new BadRequestException('Invalid or expired connect state');
    }

    // Login-CSRF / authorization-code-injection guard: the browser completing the
    // callback must be the SAME Hub user who started the flow. On the single-owner
    // appliance this always holds; on a multi-user Hub it stops a low-priv user
    // from binding the owner's app to the attacker's memory account (or vice
    // versa). No key is exchanged when it fails.
    if (attempt.userId !== currentUserId) {
      this.logger.error(`[MemoryConnect] callback user mismatch for ${attempt.appUrn}: started by ${attempt.userId}, completed by ${currentUserId}`);

      return { next: attempt.next, error: true };
    }

    const provider = await this.resolver.findProvider();

    if (!provider) {
      this.logger.error(`[MemoryConnect] callback with no resolvable provider for ${attempt.appUrn}`);

      return { next: attempt.next, error: true };
    }

    try {
      const exchanged = await this.exchange.exchange(provider.internalUrl, code);

      // Defense in depth: the code must be for the same app the flow started for.
      if (exchanged.appUrn !== attempt.appUrn) {
        this.logger.error(`[MemoryConnect] app mismatch on exchange: expected ${attempt.appUrn}, got ${exchanged.appUrn}`);

        // The exchange minted a key under `exchanged.appUrn` (CI-Server rotates by
        // app name), but the Hub will not store it — revoke it so it does not
        // linger unmanaged on CI-Server. revoke() never throws (logs on failure).
        await this.exchange.revoke(provider.internalUrl, exchanged.appUrn);

        return { next: attempt.next, error: true };
      }

      // Store the internal URL as CI_SERVER_URL — the agent container reaches
      // ci-memory over the same shared docker network the Hub used for exchange.
      await this.connections.storeConnected(attempt.appUrn, provider.internalUrl, exchanged.key, exchanged.expiresAt);
      await this.applyAndRestart(attempt.appUrn);

      return { next: attempt.next };
    } catch (err) {
      this.logger.error(`[MemoryConnect] exchange failed for ${attempt.appUrn}`, err);

      return { next: attempt.next, error: true };
    }
  }

  /**
   * Abandon a pending connect (the user denied consent on ci-memory, or an
   * upstream error): free the pending `state` and return where to send the
   * browser — the originating app if the state is still known, else the Hub.
   */
  abandonConnect(state: string | undefined): string {
    const attempt = state ? this.pending.consume(state) : null;

    return attempt?.next ?? '/';
  }

  /**
   * Wrapper-facing status: current state + the launcher URL to start connecting.
   * `connectUrl` is null unless Companion Memory is actually running — otherwise a
   * wrapper would render a connect gate that dead-ends on startConnect's "not
   * installed" / "not reachable yet" 400. `getProviderRuntimeStatus` here is the
   * lightweight DB-only check, run in parallel with the other lookups.
   */
  async getStatus(appUrn: AppUrn): Promise<MemoryConnectStatus> {
    const [state, launcherUrl, providerStatus] = await Promise.all([
      this.connections.getState(appUrn),
      this.buildLauncherUrl(appUrn),
      // Cheap DB-only status check, and fault-tolerant: a transient failure
      // degrades to "no connect URL" rather than 500ing the whole status poll
      // (the state + launcher URL are independent of the provider lookup).
      this.resolver.getProviderRuntimeStatus().catch(() => 'absent' as const),
    ]);

    // Only offer the connect launcher when ci-memory is actually running. While it
    // is merely installing/stopped a launcher link would dead-end on startConnect's
    // "not reachable yet" 400, so the wrapper gate must suppress itself (null URL).
    return { state, connectUrl: providerStatus === 'ready' ? launcherUrl : null };
  }

  /**
   * Richer status for the Hub's app-detail UI: whether the app is even a memory
   * consumer, whether Companion Memory is installed to connect to, the current
   * state, and the launcher URL.
   */
  async getUiStatus(appUrn: AppUrn): Promise<MemoryConnectUiStatus> {
    // Non-consumer apps render no card, so short-circuit before the provider
    // status + state/launcher lookups (the common case — most installed apps
    // are not memory consumers).
    if (!(await this.resolver.isConsumerApp(appUrn))) {
      return {
        applicable: false,
        memoryInstalled: false,
        memoryReady: false,
        providerStatus: 'absent',
        state: 'unconfigured',
        connectUrl: null,
        keyExpiresAt: null,
      };
    }

    // getRow (not getState) so we get the key's expiry in the same query. The
    // coarse provider status (DB-only lite check) drives installed/ready — a mere
    // install-in-progress row must not read as "ready".
    const [providerStatus, row, launcherUrl] = await Promise.all([
      this.resolver.getProviderRuntimeStatus().catch(() => 'absent' as const),
      this.connections.getRow(appUrn),
      this.buildLauncherUrl(appUrn),
    ]);

    const memoryInstalled = providerStatus !== 'absent';
    const memoryReady = providerStatus === 'ready';

    let effectiveState = row?.state ?? 'unconfigured';
    // Normalize to a canonical UTC ISO string: Postgres hands back a
    // space-separated form that Safari's `new Date()` rejects, so the UI must
    // never see the raw column value.
    let keyExpiresAt = this.toIsoInstant(row?.keyExpiresAt);

    // Lazy staleness detection: if we think we're connected but ci-memory no
    // longer accepts the stored key (e.g. it was reset), clear it so the app
    // re-prompts instead of silently running with a dead credential. Only worth
    // doing when ci-memory is actually running — otherwise isKeyValid can't reach
    // it (and fails safe), so we'd only be paying a network timeout on every poll
    // while it's down. findProvider is resolved lazily here (for the internal S2S
    // URL) rather than on every call.
    if (effectiveState === 'connected' && memoryReady) {
      const provider = await this.resolver.findProvider();
      // Decrypt from the row already loaded above — avoids a second findByAppUrn.
      const creds = this.connections.credsFromRow(row);
      if (provider && creds && !(await this.exchange.isKeyValid(provider.internalUrl, creds.token))) {
        // Clear the dead key AND restart the app: clearing alone leaves the
        // container running with the injected dead credential (401ing every
        // memory call) until some unrelated restart. Restarting regenerates the
        // env without creds, so the wrapper re-shows the connect interstitial.
        await this.connections.clear(appUrn);
        await this.applyAndRestart(appUrn);
        effectiveState = 'unconfigured';
        keyExpiresAt = null;
        this.logger.info(`[MemoryConnect] cleared stale key for ${appUrn} (ci-memory rejected it)`);
      }
    }

    // Withhold the launcher URL unless ci-memory is running, so the Connect button
    // can never navigate into a startConnect that would 400.
    return {
      applicable: true,
      memoryInstalled,
      memoryReady,
      providerStatus,
      state: effectiveState,
      connectUrl: memoryReady ? launcherUrl : null,
      keyExpiresAt,
    };
  }

  /** Record that the user chose not to connect (do not re-prompt). */
  async skip(appUrn: AppUrn): Promise<void> {
    await this.connections.markSkipped(appUrn);
  }

  /**
   * Disconnect an app: revoke the key on ci-memory, clear the stored connection,
   * and restart the app so it drops the creds.
   *
   * Only report success once the key is actually gone on CI-Server. If the
   * provider is reachable but the revoke fails, we KEEP the connection (and the
   * injected creds) and surface an error so the user can retry — clearing here
   * would falsely show "disconnected" while the key stays valid for its full
   * ~90-day TTL. When the provider is unresolvable (ci-memory uninstalled) there
   * is nothing to revoke against, so we clear locally.
   */
  async disconnect(appUrn: AppUrn): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      const revoked = await this.exchange.revoke(provider.internalUrl, appUrn);
      if (!revoked) {
        throw new ServiceUnavailableException('Could not revoke the memory key on Companion Memory; the app is still connected. Please try again.');
      }
    }

    await this.connections.clear(appUrn);
    await this.applyAndRestart(appUrn);
  }

  /**
   * The installed apps that currently hold a live Companion Memory connection —
   * used to guard against removing the shared provider out from under them.
   * Excludes (a) the provider's own connection row (ci-memory holds one too) and
   * (b) stale rows whose app is no longer installed. Names are the app's display
   * name, falling back to the URN's app-name half.
   *
   * A row whose URN can't even be PARSED is skipped (it can't map to a real
   * consumer). That is the ONLY thing swallowed here: a DB/resolver error while
   * resolving a genuinely-connected row is allowed to propagate, so the caller
   * (the uninstall/reset guard) fails CLOSED rather than silently dropping a
   * still-connected consumer and letting the shared store be destroyed.
   */
  async listConnectedConsumers(): Promise<Array<{ appUrn: string; name: string }>> {
    const rows = await this.connections.listConnected();
    const consumers: Array<{ appUrn: string; name: string }> = [];

    for (const row of rows) {
      const urn = row.appUrn as AppUrn;

      // Validate the URN up front and skip only on a PARSE failure — everything
      // below (the DB existence check, the name resolution) must be free to throw.
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

  /**
   * Uninstall cleanup: revoke the key on ci-memory and drop all local connection
   * state. No restart — the app is going away. Unlike disconnect this is
   * best-effort: the app is being removed regardless, so a failed revoke cannot
   * block it (the key then lapses on its own TTL) — but it is logged loudly.
   */
  async handleUninstall(appUrn: AppUrn): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      const revoked = await this.exchange.revoke(provider.internalUrl, appUrn);
      if (!revoked) {
        this.logger.error(`[MemoryConnect] uninstall of ${appUrn}: key revocation failed; it stays valid on CI-Server until its TTL expires`);
      }
    }

    await this.connections.remove(appUrn);

    // If Companion Memory ITSELF is being uninstalled, every consumer's stored key
    // is now dead and no provider remains to lazily detect the staleness — so
    // clear each connected consumer and regenerate its env, making them re-prompt
    // instead of silently running with a 401ing credential.
    if (isMemoryProviderApp({ urn: appUrn })) {
      await this.clearConsumersAfterProviderUninstall(appUrn);
    }
  }

  /**
   * Companion Memory was uninstalled: nothing remains to revoke against, so just
   * drop every consumer's now-dead connection and regenerate its env so the
   * connect interstitial reappears. Best-effort per consumer.
   */
  private async clearConsumersAfterProviderUninstall(providerUrn: AppUrn): Promise<void> {
    const connected = await this.connections.listConnected();

    for (const row of connected) {
      if (row.appUrn === providerUrn) {
        continue;
      }

      const consumerUrn = row.appUrn as AppUrn;

      try {
        await this.connections.clear(consumerUrn);
        await this.applyAndRestart(consumerUrn);
        this.logger.info(`[MemoryConnect] cleared ${consumerUrn}: Companion Memory was uninstalled`);
      } catch (err) {
        this.logger.error(`[MemoryConnect] failed to clear ${consumerUrn} after Companion Memory uninstall`, err);
      }
    }
  }

  /**
   * The Hub's browser-reachable origin — its Traefik/tunnel route
   * (`<hubSubdomain>.<domain>`). This MUST match the `CI_HUB_ORIGINS` value the
   * Hub injects into ci-memory (see AppHelpers), since ci-memory allowlists the
   * connect return URL against it.
   */
  private async hubOrigin(): Promise<string | null> {
    const org = await this.deviceRegistration.getFirstDeviceRegistration();
    const domain = this.config.getConfig().domain;

    if (!org?.hubSubdomain || !domain || domain === 'example.com') {
      return null;
    }

    return `https://${org.hubSubdomain}.${domain}`;
  }

  /**
   * Validate the post-connect destination. `next` is only honored when its
   * origin is the Hub's or the connecting app's own public origin; anything else
   * (or an unparseable value) falls back to the app's public URL, then the Hub.
   * This closes the open-redirect the raw `next` param would otherwise allow.
   */
  private async resolveSafeNext(next: string | undefined, appUrn: AppUrn, hubOrigin: string): Promise<string> {
    const appPublicUrl = await this.resolver.getAppPublicUrl(appUrn);
    // Only the Hub or the connecting app's own origin — NOT the memory
    // provider's — as documented above. The provider is never a designed
    // landing page, so it stays out of the allowlist.
    const allowedOrigins = new Set<string>([hubOrigin]);
    if (appPublicUrl) {
      try {
        allowedOrigins.add(new URL(appPublicUrl).origin);
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

    return appPublicUrl ?? hubOrigin;
  }

  /**
   * Normalize a stored key expiry into a canonical ISO-8601 UTC instant. The
   * `key_expires_at` column is `timestamptz`, but Postgres returns it in a
   * space-separated form (e.g. `2026-10-07 00:00:00+00`) that Safari's
   * `new Date()` treats as Invalid Date — so the status DTO always hands the UI
   * a `…Z` string it can parse everywhere. Returns null for a missing or
   * unparseable value.
   */
  private toIsoInstant(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /** The browser-reachable Hub launcher URL for an app, or null if no Hub origin. */
  private async buildLauncherUrl(appUrn: AppUrn): Promise<string | null> {
    const hubOrigin = await this.hubOrigin();

    return hubOrigin ? `${hubOrigin}/api/memory-connect/start?app=${encodeURIComponent(appUrn)}` : null;
  }

  /**
   * Apply the app's current connection state to its env, restarting it if it is live.
   *
   * A DOWN app is NOT restarted — `restartApp` runs `compose down` + `compose up`, so
   * restarting one would start a container the user chose to stop, whether from a
   * background rotation sweep or merely from opening the app's detail page (the status
   * poll self-heals a stale key through here). But its env IS rewritten, in place:
   * deferring that too would leave a REVOKED credential sitting in `app.env` after a
   * disconnect, and would lose a connect completed mid-install (the installer generates
   * the env early, then composes up from it — with no creds in it — long before the
   * install finishes). Rewriting now is what makes "applies on its next start" true.
   *
   * Anything NOT in {@link DOWN_APP_STATUSES} is live or coming up, and its restart is
   * queued behind any in-flight command. Skipping those would strand a LIVE app on a key
   * rotation has already retired on CI-Server, which the age gate then ignores for 60 days.
   */
  private async applyAndRestart(appUrn: AppUrn): Promise<ApplyOutcome> {
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

      // Awaited, not fire-and-forget: `restartApp` returns as soon as the restart is
      // PUBLISHED, so trusting it would report success for a compose failure and let the
      // caller's retry (and its loud strand-warning) never fire.
      const restarted = await lifecycle.restartAppAndWait({ appUrn });

      return restarted ? 'restarted' : 'failed';
    } catch (err) {
      this.logger.error(`[MemoryConnect] failed to apply the connection change to ${appUrn}`, err);

      return 'failed';
    }
  }

  /** Whether the app is down (deliberately or mid-maintenance) or simply not there. */
  private async isAppDown(appUrn: AppUrn): Promise<boolean> {
    const app = await this.apps.getAppByUrn(appUrn);

    // No row at all — nothing to restart.
    if (!app) {
      return true;
    }

    return DOWN_APP_STATUSES.includes(app.status);
  }
}
