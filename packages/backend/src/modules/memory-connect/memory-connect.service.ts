import { BadRequestException, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { type MemoryConnectionState } from './memory-connection.repository';
import { MemoryConnectionService } from './memory-connection.service';
import { MemoryExchangeClient } from './memory-exchange.client';
import { MemoryProviderResolver } from './memory-provider.resolver';
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
  /** Whether Companion Memory is installed to connect to. */
  memoryInstalled: boolean;
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
        if (new Date(row.updatedAt).getTime() > cutoff) {
          continue;
        }

        const appUrn = row.appUrn as AppUrn;

        try {
          const rotated = await this.exchange.rotate(provider.internalUrl, appUrn);
          await this.connections.storeConnected(appUrn, provider.internalUrl, rotated.key, rotated.expiresAt);
          await this.applyAndRestart(appUrn);
          this.logger.info(`[MemoryConnect] rotated memory key for ${appUrn}`);
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
  async startConnect(appUrn: AppUrn, next: string | undefined): Promise<string> {
    const provider = await this.resolver.findProvider();

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

    const state = this.pending.create(appUrn, safeNext);
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
   * exchange error) still returns the originating app's URL with `error: true`,
   * so the user lands back on their app (where the interstitial re-appears)
   * rather than dead-ending on the Hub dashboard.
   */
  async handleCallback(code: string, state: string): Promise<{ next: string; error?: boolean }> {
    const attempt = this.pending.consume(state);

    if (!attempt) {
      throw new BadRequestException('Invalid or expired connect state');
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

  /** Wrapper-facing status: current state + the launcher URL to start connecting. */
  async getStatus(appUrn: AppUrn): Promise<MemoryConnectStatus> {
    const [state, connectUrl] = await Promise.all([this.connections.getState(appUrn), this.buildLauncherUrl(appUrn)]);

    return { state, connectUrl };
  }

  /**
   * Richer status for the Hub's app-detail UI: whether the app is even a memory
   * consumer, whether Companion Memory is installed to connect to, the current
   * state, and the launcher URL.
   */
  async getUiStatus(appUrn: AppUrn): Promise<MemoryConnectUiStatus> {
    // Non-consumer apps render no card, so short-circuit before the provider
    // availability probe + state/launcher lookups (the common case — most
    // installed apps are not memory consumers).
    if (!(await this.resolver.isConsumerApp(appUrn))) {
      return { applicable: false, memoryInstalled: false, state: 'unconfigured', connectUrl: null, keyExpiresAt: null };
    }

    // getRow (not getState) so we get the key's expiry in the same query.
    const [provider, row, connectUrl] = await Promise.all([
      this.resolver.findProvider(),
      this.connections.getRow(appUrn),
      this.buildLauncherUrl(appUrn),
    ]);

    // Lazy staleness detection: if we think we're connected but ci-memory no
    // longer accepts the stored key (e.g. it was reset), clear it so the app
    // re-prompts instead of silently running with a dead credential.
    let effectiveState = row?.state ?? 'unconfigured';
    // Normalize to a canonical UTC ISO string: Postgres hands back a
    // space-separated form that Safari's `new Date()` rejects, so the UI must
    // never see the raw column value.
    let keyExpiresAt = this.toIsoInstant(row?.keyExpiresAt);
    if (effectiveState === 'connected' && provider) {
      const creds = await this.connections.getInjectableCreds(appUrn);
      if (creds && !(await this.exchange.isKeyValid(provider.internalUrl, creds.token))) {
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

    return { applicable: true, memoryInstalled: !!provider, state: effectiveState, connectUrl, keyExpiresAt };
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

  /** Regenerate the app's env (picks up the stored creds) and restart it. Best-effort. */
  private async applyAndRestart(appUrn: AppUrn): Promise<void> {
    try {
      const lifecycle = this.moduleRef.get(AppLifecycleService, { strict: false });
      await lifecycle.restartApp({ appUrn });
    } catch (err) {
      this.logger.error(`[MemoryConnect] failed to restart ${appUrn} after connection change`, err);
    }
  }
}
