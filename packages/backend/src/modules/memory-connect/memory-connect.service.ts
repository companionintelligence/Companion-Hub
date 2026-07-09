import { BadRequestException, Injectable } from '@nestjs/common';
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
export class MemoryConnectService {
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
   */
  async handleCallback(code: string, state: string): Promise<{ next: string }> {
    const attempt = this.pending.consume(state);

    if (!attempt) {
      throw new BadRequestException('Invalid or expired connect state');
    }

    const provider = await this.resolver.findProvider();

    if (!provider) {
      throw new BadRequestException('Companion Memory is no longer installed');
    }

    const exchanged = await this.exchange.exchange(provider.internalUrl, code);

    // Defense in depth: the code must be for the same app the flow started for.
    if (exchanged.appUrn !== attempt.appUrn) {
      this.logger.error(`[MemoryConnect] app mismatch on exchange: expected ${attempt.appUrn}, got ${exchanged.appUrn}`);
      throw new BadRequestException('Connect code did not match the requested app');
    }

    // Store the internal URL as CI_SERVER_URL — the agent container reaches
    // ci-memory over the same shared docker network the Hub used for exchange.
    await this.connections.storeConnected(attempt.appUrn, provider.internalUrl, exchanged.key);
    await this.applyAndRestart(attempt.appUrn);

    return { next: attempt.next };
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
      return { applicable: false, memoryInstalled: false, state: 'unconfigured', connectUrl: null };
    }

    const [provider, state, connectUrl] = await Promise.all([
      this.resolver.findProvider(),
      this.connections.getState(appUrn),
      this.buildLauncherUrl(appUrn),
    ]);

    // Lazy staleness detection: if we think we're connected but ci-memory no
    // longer accepts the stored key (e.g. it was reset), clear it so the app
    // re-prompts instead of silently running with a dead credential.
    let effectiveState = state;
    if (state === 'connected' && provider) {
      const creds = await this.connections.getInjectableCreds(appUrn);
      if (creds && !(await this.exchange.isKeyValid(provider.internalUrl, creds.token))) {
        // Clear the dead key AND restart the app: clearing alone leaves the
        // container running with the injected dead credential (401ing every
        // memory call) until some unrelated restart. Restarting regenerates the
        // env without creds, so the wrapper re-shows the connect interstitial.
        await this.connections.clear(appUrn);
        await this.applyAndRestart(appUrn);
        effectiveState = 'unconfigured';
        this.logger.info(`[MemoryConnect] cleared stale key for ${appUrn} (ci-memory rejected it)`);
      }
    }

    return { applicable: true, memoryInstalled: !!provider, state: effectiveState, connectUrl };
  }

  /** Record that the user chose not to connect (do not re-prompt). */
  async skip(appUrn: AppUrn): Promise<void> {
    await this.connections.markSkipped(appUrn);
  }

  /**
   * Disconnect an app: revoke the key on ci-memory (best-effort), clear the
   * stored connection, and restart the app so it drops the creds.
   */
  async disconnect(appUrn: AppUrn): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      await this.exchange.revoke(provider.internalUrl, appUrn);
    }

    await this.connections.clear(appUrn);
    await this.applyAndRestart(appUrn);
  }

  /**
   * Uninstall cleanup: revoke the key on ci-memory (best-effort) and drop all
   * local connection state. No restart — the app is going away.
   */
  async handleUninstall(appUrn: AppUrn): Promise<void> {
    const provider = await this.resolver.findProvider();

    if (provider) {
      await this.exchange.revoke(provider.internalUrl, appUrn);
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
