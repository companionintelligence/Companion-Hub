import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { buildHubLocalOrigin, buildHubPublicOrigin, isPrivateHostname } from '@/common/helpers/hub-origin';
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
 * `restarted` — the restart completed and the container is running the new env
 * (await mode only). `restarting` — the restart was dispatched and the status has
 * flipped; its completion handler does the rest (schedule mode only). `deferred` —
 * the app is down, so its env was rewritten in place and applies on its next start
 * (nothing more to do). `failed` — the creds could not be applied, and the app may
 * be stranded on a key CI-Server has already retired.
 */
type ApplyOutcome = 'restarted' | 'restarting' | 'deferred' | 'failed';

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

/**
 * Why a connect cannot be started right now. Machine-readable so the Hub UI can
 * localise it and the wrappers can log something actionable — the previous
 * contract expressed every one of these as a bare `connectUrl: null`, which is
 * why a dead Connect button could never explain itself.
 */
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

/**
 * The launcher URLs available to one specific caller, plus why there are none.
 *
 * Deliberately caller-scoped rather than global: whether the LAN launcher is
 * usable depends on where the browser is, so the same appliance answers this
 * differently for a request that arrived on `http://192.168.1.5` than for one
 * that arrived on `https://hub-….companionintelligence.com`.
 */
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

/**
 * Where a request reached the Hub, so the service can answer "can THIS caller
 * connect?" — and, when the flow starts, keep the whole ceremony on the origin it
 * began on instead of relocating the user mid-flow.
 */
export interface RequestOriginContext {
  /** Host header of the incoming request (`192.168.1.5:80`, `hub-x.example.com`). */
  host?: string;
  /** Whether the request arrived over TLS. */
  secure?: boolean;
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
    private readonly tunnelHealth: TunnelHealthService,
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
          let outcome = await this.applyConnection(appUrn, 'await');

          if (outcome === 'failed') {
            const retry = await this.applyConnection(appUrn, 'await');

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
  async startConnect(appUrn: AppUrn, next: string | undefined, userId: string, origin?: RequestOriginContext): Promise<string> {
    // The browser leg needs the public consent URL, so this is the one caller
    // that pays for the availability probe.
    const provider = await this.resolver.findProvider({ withPublicUrl: true });

    if (!provider) {
      throw new BadRequestException('CI Memory is not installed');
    }

    if (!provider.publicUrl) {
      throw new BadRequestException('CI Memory is not reachable yet; try again once it is running');
    }

    // Run the whole ceremony on the origin the user actually arrived on. The
    // callback, the finishing interstitial and the Hub session cookie all live on
    // one origin, so deriving this from config instead of the request is what used
    // to throw a LAN user onto the public origin mid-flow — where their session
    // cookie does not exist and they are bounced to a second login.
    const hubOrigin = await this.resolveFlowOrigin(origin);

    if (!hubOrigin) {
      throw new BadRequestException('This Hub has no origin to return to');
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
   * one-time code for the key (server-to-server), persist it, kick off the
   * apply (regenerate env + restart), and return where to send the browser next.
   *
   * The restart is NOT awaited here — a compose restart takes tens of seconds,
   * and holding the browser's top-level navigation open that long is how a
   * routine client-side network blip turns into an aborted callback (and a
   * Cloudflare 524 past ~100s). Instead the browser is sent to the SPA's
   * `/memory-connect/finishing` interstitial, which watches the app's status
   * and forwards to `next` once it is running again.
   *
   * The store resolves the `state` bound to the current user and the presented
   * code (hashed): a replay of the SAME code repeats the redirect the first
   * attempt actually resolved to, WITHOUT re-exchanging — never fabricating a
   * success (or failure) the first attempt didn't have. A DIFFERENT code on a
   * consumed state is a fresh consent grant (deny → back → allow, or a retry
   * after a failed exchange) and runs the full flow again. A request from
   * another Hub user is `foreign`: it neither consumes the attempt nor learns
   * anything about it (login-CSRF / authorization-code-injection guard — on a
   * multi-user Hub this stops a low-priv user from binding the owner's app to
   * the attacker's memory account, or from burning the owner's in-flight
   * state).
   *
   * Only an unknown/expired `state` throws (there is no app to return to). Once
   * the state is resolved for its owner, ANY downstream failure (provider gone,
   * app mismatch, exchange error) still returns the originating app's URL with
   * `error: true`, so the user lands back on their app (where the interstitial
   * re-appears) rather than dead-ending on the Hub dashboard.
   */
  async handleCallback(code: string, state: string, currentUserId: string): Promise<{ next: string; error?: boolean }> {
    const attempt = this.pending.consume(state, currentUserId, this.hashCode(code));

    if (attempt.outcome === 'unknown') {
      throw new BadRequestException('Invalid or expired connect state');
    }

    if (attempt.outcome === 'foreign') {
      this.logger.error(`[MemoryConnect] callback user mismatch: state not owned by user ${currentUserId}`);

      // Land on the dashboard with the generic error marker — same landing as an
      // unknown/expired state (the controller's catch also uses this), so the
      // outcome is indistinguishable to a probing non-initiator (no foreign-vs-
      // unknown oracle) while still surfacing a failure toast to the real user
      // whose session drifted. A non-initiator still learns nothing (not the app).
      return { next: '/?memoryConnect=error', error: true };
    }

    if (attempt.outcome === 'replayed') {
      this.logger.info(`[MemoryConnect] callback replayed for ${attempt.appUrn}; skipping exchange`);

      // Repeat the first attempt's recorded redirect: the finishing interstitial
      // if a restart was scheduled, else the app URL (failed / deferred / still
      // in flight). Never assume the replayed attempt succeeded.
      return { next: attempt.redirect };
    }

    const result = await this.completeConnect(attempt.appUrn, attempt.next, code);

    // Record where this attempt actually resolved, unconditionally, so a replay
    // repeats the exact redirect — success, failure, or deferral alike.
    this.pending.recordOutcome(state, result.next);

    return result;
  }

  /**
   * The exchange-and-apply half of a consumed callback: swap the one-time code
   * for a key, persist it, schedule the restart, and return where to send the
   * browser (the finishing interstitial while a restart is in flight, else the
   * app URL).
   */
  private async completeConnect(appUrn: AppUrn, next: string, code: string): Promise<{ next: string; error?: boolean }> {
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

        // The exchange minted a key under `exchanged.appUrn` (CI-Server rotates by
        // app name), but the Hub will not store it — revoke it so it does not
        // linger unmanaged on CI-Server. revoke() never throws (logs on failure).
        await this.exchange.revoke(provider.internalUrl, exchanged.appUrn);

        return { next, error: true };
      }

      // Store the internal URL as CI_SERVER_URL — the agent container reaches
      // ci-memory over the same shared docker network the Hub used for exchange.
      await this.connections.storeConnected(appUrn, provider.internalUrl, exchanged.key, exchanged.expiresAt);
      const applied = await this.applyConnection(appUrn, 'schedule');

      if (applied === 'restarting') {
        return { next: this.buildFinishingPath(appUrn, next) };
      }

      // 'deferred' (app is down; env rewritten in place) or 'failed' — nothing is
      // restarting for the interstitial to watch, so land on the app directly.
      return { next };
    } catch (err) {
      this.logger.error(`[MemoryConnect] exchange failed for ${appUrn}`, err);

      return { next, error: true };
    }
  }

  /**
   * Abandon a pending connect (the user denied consent on ci-memory, or an
   * upstream error): free the pending `state` and return where to send the
   * browser — the originating app if the state is still known (including a
   * refresh of the deny redirect, via the tombstone), else the Hub. A foreign
   * user's deny replay learns nothing (not even the app URL).
   */
  abandonConnect(state: string | undefined, currentUserId: string, error?: string): string {
    const attempt = this.pending.consume(state, currentUserId);

    if (attempt.outcome === 'unknown' || attempt.outcome === 'foreign') {
      // No app to return to. Carry the provider's own error code onto the
      // dashboard so the toast can distinguish "you declined" from "the consent
      // page could not authenticate you" (CI-Server's `csrf_failed` /
      // `login_required`), instead of the single generic marker this used to use.
      return error ? `/?memoryConnect=${encodeURIComponent(error)}` : '/';
    }

    if (error) {
      this.logger.warn(`[MemoryConnect] connect abandoned for ${attempt.appUrn}: provider reported '${error}'`);
    } else {
      this.logger.info(`[MemoryConnect] connect declined by the user for ${attempt.appUrn}`);
    }

    return attempt.redirect;
  }

  /**
   * Hash a one-time code for the tombstone comparison. The raw code is never
   * retained — the hash only answers "is this the same code as last time?" so
   * a fresh consent grant is distinguishable from a browser replay.
   */
  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /**
   * Wrapper-facing status: current state + the launcher URL to start connecting.
   * `connectUrl` is null unless CI Memory is actually running — otherwise a
   * wrapper would render a connect gate that dead-ends on startConnect's "not
   * installed" / "not reachable yet" 400. `getProviderRuntimeStatus` here is the
   * lightweight DB-only check, run in parallel with the other lookups.
   */
  async getStatus(appUrn: AppUrn, origin?: RequestOriginContext): Promise<MemoryConnectStatus> {
    const [state, providerInfo] = await Promise.all([
      this.connections.getState(appUrn),
      // Cheap DB-only status check, and fault-tolerant: a transient failure
      // degrades to "no connect URL" rather than 500ing the whole status poll
      // (the state is independent of the provider lookup).
      this.resolver.getProviderRuntimeInfo().catch(() => ({ status: 'absent' as const, localOnly: false })),
    ]);

    const launchers = await this.resolveLaunchers({
      appUrn,
      providerStatus: providerInfo.status,
      providerLocalOnly: providerInfo.localOnly,
      origin,
    });

    // This endpoint drives a gate that BLOCKS the app, so it fails toward not
    // gating: when nothing is connectable the wrapper receives null URLs, stands
    // down, and lets the user into the app. `reason` still rides along so the
    // wrapper can log why it suppressed itself — the previous contract made an
    // unreachable Hub indistinguishable from a healthy one that had nothing to do.
    return { state, ...launchers };
  }

  /**
   * Richer status for the Hub's app-detail UI: whether the app is even a memory
   * consumer, whether CI Memory is installed to connect to, the current
   * state, and the launcher URL.
   */
  async getUiStatus(appUrn: AppUrn, origin?: RequestOriginContext): Promise<MemoryConnectUiStatus> {
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
        connectUrlLocal: null,
        connectable: false,
        reason: null,
        keyExpiresAt: null,
      };
    }

    // getRow (not getState) so we get the key's expiry in the same query. The
    // coarse provider status (DB-only lite check) drives installed/ready — a mere
    // install-in-progress row must not read as "ready".
    const [providerInfo, row] = await Promise.all([
      this.resolver.getProviderRuntimeInfo().catch(() => ({ status: 'absent' as const, localOnly: false })),
      this.connections.getRow(appUrn),
    ]);

    const providerStatus = providerInfo.status;

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
        await this.applyConnection(appUrn, 'await');
        effectiveState = 'unconfigured';
        keyExpiresAt = null;
        this.logger.info(`[MemoryConnect] cleared stale key for ${appUrn} (ci-memory rejected it)`);
      }
    }

    // Unlike `/state`, this endpoint drives a NON-blocking surface (the Connect
    // button), so it fails toward *showing* — hiding the action here would make
    // the feature look absent. `connectable: false` + `reason` is what lets the
    // button render disabled with copy that says why, rather than the generic
    // description it used to show over a dead click target.
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
        throw new ServiceUnavailableException('Could not revoke the memory key on CI Memory; the app is still connected. Please try again.');
      }
    }

    await this.connections.clear(appUrn);
    await this.applyConnection(appUrn, 'await');
  }

  /**
   * The installed apps that currently hold a live CI Memory connection —
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

    // If CI Memory ITSELF is being uninstalled, every consumer's stored key
    // is now dead and no provider remains to lazily detect the staleness — so
    // clear each connected consumer and regenerate its env, making them re-prompt
    // instead of silently running with a 401ing credential.
    if (isMemoryProviderApp({ urn: appUrn })) {
      await this.clearConsumersAfterProviderUninstall(appUrn);
    }
  }

  /**
   * CI Memory was uninstalled: nothing remains to revoke against, so just
   * drop every consumer's now-dead connection and regenerate its env so the
   * connect interstitial reappears. Best-effort per consumer.
   */
  private async clearConsumersAfterProviderUninstall(providerUrn: AppUrn): Promise<void> {
    const connected = await this.connections.listConnected();
    const consumers = connected.filter((row) => row.appUrn !== providerUrn);

    // Re-arm every consumer CONCURRENTLY. Serially this took the sum of all consumer
    // restarts (~28s for two in a production incident); the app-events queue runs
    // multiple workers, so parallel dispatch bounds the wait to the slowest single
    // restart instead. Each consumer is isolated in its own try/catch and the batch
    // is awaited with allSettled, so one wedged app is logged but never strands the
    // others or rejects the sweep (#906).
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

  /**
   * The Hub's browser-reachable origin — its Traefik/tunnel route
   * (`<hubSubdomain>.<domain>`). This MUST match the `CI_HUB_ORIGINS` value the
   * Hub injects into ci-memory (see AppHelpers), since ci-memory allowlists the
   * connect return URL against it.
   */
  private async hubOrigin(): Promise<string | null> {
    const org = await this.deviceRegistration.getFirstDeviceRegistration();
    const domain = this.config.getConfig().domain;

    return buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain });
  }

  /**
   * The Hub's LAN origin (`http://<internalIp>:<port>`), served by the same
   * gateway as the public route but unaffected by tunnel health. This is the
   * fallback the connect surfaces offer when the public origin is down — and the
   * origin that must also appear in ci-memory's `CI_HUB_ORIGINS` allowlist (see
   * `AppHelpers`) for the callback leg to be accepted.
   */
  private hubLocalOrigin(): string | null {
    const { userSettings } = this.config.getConfig();

    return buildHubLocalOrigin({ internalIp: userSettings.internalIp, port: userSettings.port });
  }

  /**
   * Decide which connect launchers this caller can actually use.
   *
   * The rules, in the order they are applied:
   *
   *  1. **ci-memory must be running.** Anything else short-circuits with the
   *     matching reason — a launcher offered while it is absent/starting/offline
   *     would dead-end on `startConnect`'s 400.
   *  2. **The public launcher is preferred whenever the public route works.**
   *     Tunnel health `up`, `unknown` (no opinion — never suppress on a cold or
   *     inconclusive reading) and a missing-but-configured origin all keep
   *     today's behaviour. Only a confirmed `down` withdraws it.
   *  3. **The LAN launcher is a fallback, never a preference.** It is offered only
   *     when the public route is unusable AND the caller reached us on a private
   *     host — a remote browser cannot route to `192.168.x.x`, so handing it that
   *     URL would swap one dead button for another.
   *  4. **The provider must be reachable by the same caller.** A locally-exposed
   *     ci-memory publishes a private consent origin; an off-network caller
   *     cannot complete the ceremony no matter which Hub launcher they start from.
   *
   * `providerLocalOnly` comes from the provider's `exposureMode` (a DB read), not
   * from an availability probe — so a status poll stays cheap.
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

    // 1. Nothing to connect to.
    if (input.providerStatus !== 'ready') {
      return blocked(
        input.providerStatus === 'absent' ? 'memory_absent' : input.providerStatus === 'starting' ? 'memory_starting' : 'memory_offline',
      );
    }

    // 4. A LAN-only provider is unusable from off-network. Checked before we
    //    bother resolving launchers: no Hub launcher can rescue this caller,
    //    because the consent hop itself lands on a private address.
    const callerIsLocal = this.callerIsOnLocalNetwork(input.origin?.host);

    if (input.providerLocalOnly && !callerIsLocal) {
      this.logger.warn(
        `[MemoryConnect] ${input.appUrn}: CI Memory is exposed on the local network only; an off-network caller cannot reach its consent page`,
      );

      return blocked('provider_local_only');
    }

    const publicOrigin = await this.hubOrigin();
    const localOrigin = this.hubLocalOrigin();
    const health = this.tunnelHealth.getHealth();

    // 2. Public route first, unless it is confirmed down. `unknown` deliberately
    //    counts as usable — a cold Hub must behave exactly as it did before.
    const publicUsable = Boolean(publicOrigin) && health !== 'down';

    if (publicUsable && publicOrigin) {
      return {
        connectUrl: this.launcherFor(publicOrigin, input.appUrn),
        // Still advertise the LAN launcher to a local caller so a client can pin
        // itself to one origin if it wants to; `connectUrl` remains the default.
        connectUrlLocal:
          callerIsLocal && localOrigin && this.localOriginReachableBy(localOrigin, input.origin?.host)
            ? this.launcherFor(localOrigin, input.appUrn)
            : null,
        connectable: true,
        reason: null,
      };
    }

    // 3. Fallback: LAN only, and only for a caller who can route to it.
    if (callerIsLocal && localOrigin && this.localOriginReachableBy(localOrigin, input.origin?.host)) {
      this.logger.info(
        `[MemoryConnect] ${input.appUrn}: public origin unusable (tunnel ${health}); offering the LAN launcher ${localOrigin} to a local caller`,
      );

      return { connectUrl: null, connectUrlLocal: this.launcherFor(localOrigin, input.appUrn), connectable: true, reason: null };
    }

    return blocked(publicOrigin ? 'hub_unreachable' : 'hub_not_provisioned');
  }

  /** The Hub launcher URL for an app on a given origin. */
  private launcherFor(origin: string, appUrn: AppUrn): string {
    return `${origin}/api/memory-connect/start?app=${encodeURIComponent(appUrn)}`;
  }

  /**
   * Whether the caller that reached us on `callerHost` is genuinely on the
   * appliance's own network — and can therefore use the LAN launcher.
   *
   * This is NOT simply "is the host private", because one private-looking host is
   * actively misleading: the Cloudflare tunnel rewrites the `Host` header to
   * `<app-fqdn>.<localDomain>` (`…​.ci.lan`) before handing the request to Traefik
   * — see `buildOriginServerName` — so a REMOTE visitor arrives at the app, and
   * therefore at this endpoint, carrying a `.ci.lan` host. Trusting that suffix
   * would hand a remote browser a `http://192.168.x.x` launcher it cannot route
   * to: precisely the dead link this whole change set exists to remove.
   *
   * So a host under the configured `localDomain` is treated as UNKNOWN rather
   * than local. The asymmetry is deliberate — a genuinely-local visitor who
   * reached the app through that name merely loses a fallback (they still get the
   * public launcher whenever it works), whereas a remote visitor wrongly given
   * the LAN launcher gets a link that cannot work at all.
   *
   * Private IP literals and loopback remain trustworthy: nothing rewrites a Host
   * into those, so they only appear when the browser really did address the
   * appliance directly.
   */
  private callerIsOnLocalNetwork(callerHost: string | undefined): boolean {
    const hostname = this.hostnameOf(callerHost);

    if (!hostname) {
      return false;
    }

    // Read the override first, then the base value — the same precedence
    // `AppHelpers` uses when it writes LOCAL_DOMAIN into an app's env, so the two
    // cannot disagree about which suffix the tunnel rewrites to.
    const config = this.config.getConfig();
    const localDomain = (config.userSettings?.localDomain || config.localDomain)?.trim().toLowerCase();
    const candidate = hostname.toLowerCase();

    if (localDomain && (candidate === localDomain || candidate.endsWith(`.${localDomain}`))) {
      return false;
    }

    return isPrivateHostname(hostname);
  }

  /**
   * Whether `localOrigin` is actually routable by a caller that reached us on
   * `callerHost`.
   *
   * Guards one specific trap: with `INTERNAL_IP` unset or listen-all,
   * {@link buildHubLocalOrigin} collapses to `http://127.0.0.1`. Handing that to a
   * visitor who reached the appliance at `192.168.1.9` points them at their OWN
   * machine — swapping one dead link for another, which is precisely the failure
   * this change set exists to remove. A loopback origin is therefore only offered
   * to a caller that is itself on loopback.
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
   * Hostname of a `Host` header or an absolute URL, without the port. Returns
   * null for anything unparseable, which every caller treats as "not private" —
   * failing toward withholding the LAN launcher rather than offering it blindly.
   */
  private hostnameOf(hostOrUrl: string | null | undefined): string | null {
    const value = hostOrUrl?.trim();

    if (!value) {
      return null;
    }

    try {
      // A bare `Host` header has no scheme; give it one so URL can parse it.
      return new URL(value.includes('://') ? value : `http://${value}`).hostname;
    } catch {
      return null;
    }
  }

  /**
   * Validate the post-connect destination. `next` is only honored when its
   * origin is the Hub's or the connecting app's own public origin; anything else
   * (or an unparseable value) falls back to the app's public URL, then the Hub.
   * This closes the open-redirect the raw `next` param would otherwise allow.
   */
  private async resolveSafeNext(next: string | undefined, appUrn: AppUrn, hubOrigin: string): Promise<string> {
    const appAccessUrls = await this.resolver.getAppAccessUrls(appUrn);
    const appPublicUrl = appAccessUrls.publicUrl;
    // Only the Hub or the connecting app's own origins — NOT the memory
    // provider's — as documented above. The provider is never a designed
    // landing page, so it stays out of the allowlist.
    //
    // "The app's origins" is plural on purpose: an app reached over the LAN has a
    // perfectly legitimate `http://<ip>:<port>` origin that the previous
    // single-URL allowlist rejected, silently relocating the user to the public
    // origin they had deliberately not been using. Both Hub origins are allowed
    // for the same reason — the flow may legitimately be running on either.
    const allowedOrigins = new Set<string>([hubOrigin]);
    const localHubOrigin = this.hubLocalOrigin();
    if (localHubOrigin) {
      allowedOrigins.add(localHubOrigin);
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

    // No usable `next` (the desktop flow never sends one). Prefer the app's
    // primary route, but fall back to its LAN address when that route is not
    // actually serving — landing the user on a known-dead public URL is the same
    // mistake as offering a dead launcher.
    if (appPublicUrl && appAccessUrls.primaryAvailable !== false) {
      return appPublicUrl;
    }

    return appAccessUrls.localUrl ?? appPublicUrl ?? hubOrigin;
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

  /**
   * The Hub origin the connect ceremony should run on for this request.
   *
   * Prefers the origin the browser actually used, so the flow stays on one origin
   * end to end — but only after checking it against the two origins this Hub
   * legitimately answers on. An unrecognised `Host` (a spoofed header, or a proxy
   * we do not know about) falls back to the configured public origin rather than
   * being echoed into a redirect target, which would be an open redirect.
   *
   * Falls back to the LAN origin when there is no public one, so a never-registered
   * appliance can still run the flow entirely on its own network.
   */
  private async resolveFlowOrigin(origin?: RequestOriginContext): Promise<string | null> {
    const publicOrigin = await this.hubOrigin();
    const localOrigin = this.hubLocalOrigin();
    const requestHostname = this.hostnameOf(origin?.host);

    for (const candidate of [publicOrigin, localOrigin]) {
      if (candidate && requestHostname && this.hostnameOf(candidate) === requestHostname) {
        return candidate;
      }
    }

    return publicOrigin ?? localOrigin;
  }

  /**
   * The SPA interstitial that watches the app come back up after a connect,
   * then forwards to `next`. Relative — the callback redirect and the SPA share
   * the Hub origin. `next` was already validated by resolveSafeNext at
   * startConnect; the page re-checks it client-side before navigating.
   */
  private buildFinishingPath(appUrn: AppUrn, next: string): string {
    return `/memory-connect/finishing?${new URLSearchParams({ app: appUrn, next }).toString()}`;
  }

  /**
   * Apply the app's current connection state to its env, restarting it if it is live.
   *
   * A DOWN app is NOT restarted — a restart runs `compose down` + `compose up`, so
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
   *
   * A LIVE app's restart runs in one of two modes:
   *
   *  - `'await'` — wait out the compose cycle via `restartAppAndWait` and report the
   *    real outcome. For background callers (rotation sweep, disconnect, stale-key
   *    self-heal) whose retry/strand-warning logic needs to know whether the restart
   *    actually took. `restartApp` would return as soon as the restart is PUBLISHED,
   *    reporting success for a compose failure.
   *  - `'schedule'` — dispatch via `restartApp` and return `'restarting'` as soon as
   *    the app's status has flipped. For the browser callback, which must answer the
   *    navigation immediately; `restartApp`'s detached completion handler does the
   *    success/error bookkeeping + SSE. The status flip happening BEFORE this resolves
   *    is what keeps the finishing interstitial's status poll from ever reading a
   *    stale `running`.
   *
   * Both modes pass `skipPull`: every apply here exists to pick up an env change, so
   * pulling a newer image only widens the wait — and worse, a rotation sweep hitting a
   * `force_pull` app while the registry is unreachable would fail a restart that the
   * local image could have served, knocking over a healthy app.
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
        await lifecycle.restartApp({ appUrn, skipPull: true });

        return 'restarting';
      }

      const restarted = await lifecycle.restartAppAndWait({ appUrn, skipPull: true });

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
