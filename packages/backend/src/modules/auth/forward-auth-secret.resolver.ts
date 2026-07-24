import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, resolvePublicDomainRoot } from '@ci-hub/common/types';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { normalizeForwardedHost } from './utils/forward-auth-host';

/**
 * How long resolved host→secret entries (and the host→app map behind them) are trusted before a
 * re-read. A per-app secret only changes at env regeneration, which coincides with a container
 * restart that itself outlasts this window — so a stale entry can at worst 401 briefly during a
 * restart that is already interrupting the app's traffic.
 */
const CACHE_TTL_MS = 30_000;

/**
 * TTL for the matched-but-secretless fallback — an app that is in the host map but has no per-app
 * secret in its env. This covers two populations at once: a legacy app that PERMANENTLY predates
 * the per-app rollout (for which a fallback is the stable, correct answer and re-reading its env
 * every request would be pure waste), and an app TRANSIENTLY secretless mid-install/mid-rotation
 * (for which the fallback is wrong the moment its secret lands). A short TTL serves both — it
 * absorbs a request burst into one env read for the legacy case, while bounding the wrong-secret
 * window for the transient case to a couple of seconds instead of the full definitive-cache TTL.
 */
const SECRETLESS_CACHE_TTL_MS = 2_000;

/**
 * Backoff after a failed host-map rebuild. Much shorter than the TTL so recovery is quick once the
 * dependency (apps repo / device registration) returns, but non-zero so a sustained outage does not
 * make every forward-auth subrequest re-attempt the failing reads.
 */
const HOST_MAP_ERROR_BACKOFF_MS = 5_000;

export interface ResolvedForwardAuthSecret {
  secret: string;
  /** The app the request targets, when the forwarded host matched an installed app. */
  appUrn?: AppUrn;
  /** Where the secret came from — 'app-env' is the per-app path, 'global' the fallback. */
  source: 'app-env' | 'global';
}

interface CacheEntry {
  value: ResolvedForwardAuthSecret;
  expiresAt: number;
}

/**
 * Resolves which forward-auth secret `GET /api/auth/traefik` must sign the identity headers with,
 * from the request's `X-Forwarded-Host` (CI-Engineering#74).
 *
 * Consumers verify `X-CI-Hub-User` with a PER-APP secret so one app can never forge an identity
 * header a sibling accepts. The authoritative copy of each app's secret is its own `app.env`
 * (written by AppHelpers.generateEnvFile): signing with what the target app actually holds makes
 * the pair self-healing — an app that has not regenerated its env since the per-app rollout still
 * holds the Hub-global value, and we sign with exactly that until its next lifecycle event flips
 * both sides at once. Deriving the secret here instead would break every running consumer the
 * moment the Hub upgrades.
 *
 * The value read from app.env is only ever "the secret this app verifies with" — never trust. An
 * app that overwrites the var in its own env (e.g. via a manifest form field) can only break or
 * forge signatures destined for itself, which it can trivially do anyway.
 *
 * Host matching mirrors the Traefik router rules: in cloudflare mode the tunnel rewrites the Host
 * header to the ORIGIN SERVER NAME (`<sub>.<localDomain>`, see cloudflare-client.service), which
 * is what arrives here — the public hostname and the custom-domain column are matched as well for
 * robustness. The rewritten host identifies the TARGET APP only; it says nothing about where the
 * caller is (see CI-Engineering#75 on why it must never be used as a locality signal).
 */
@Injectable()
export class ForwardAuthSecretResolver {
  private hostToUrn = new Map<string, AppUrn>();
  /** The reverse direction for the SSO redirect: which PUBLIC hostname serves each app. Built in
   *  the same rebuild pass as hostToUrn — the tunnel-rewritten host identifies the target app, and
   *  this map answers "what URL should a remote browser be sent back to for it" (#77). */
  private urnToPublicHost = new Map<AppUrn, string>();
  private hostMapExpiresAt = 0;
  /** The in-flight rebuild, if one is running — concurrent callers await it instead of each
   *  launching their own (single-flight; avoids a thundering herd of repo reads at every TTL). */
  private hostMapRebuild: Promise<void> | null = null;
  private secretCache = new Map<string, CacheEntry>();
  /** Apps already warned about (matched but secretless) — reset on every map rebuild so a fixed
   *  env stops warning and a regressed one warns again, without ever logging per-request. */
  private warnedUrns = new Set<string>();

  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly envUtils: EnvUtils,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /** Lowercase and strip any port — Traefik forwards the host exactly as the client sent it.
   *  Shared with AuthController's edge-SSO ticket binding, which compares against these keys. */
  private normalizeHost(forwardedHost: string | string[] | undefined): string {
    return normalizeForwardedHost(forwardedHost);
  }

  private globalSecret(): ResolvedForwardAuthSecret {
    return { secret: this.config.get('forwardAuthSecret') ?? '', source: 'global' };
  }

  /** Register every hostname an installed app's router could present. */
  private async rebuildHostMap(): Promise<void> {
    const map = new Map<string, AppUrn>();
    const publicHosts = new Map<AppUrn, string>();
    const [apps, org] = await Promise.all([this.appsRepository.getApps(), this.deviceRegistration.getFirstDeviceRegistration()]);
    // Same precedence as the compose build (app-lifecycle command.ts): operator settings win.
    const cfg = this.config.getConfig();
    const localDomain = cfg.userSettings?.localDomain || cfg.localDomain;
    const domain = cfg.userSettings?.domain || cfg.domain;

    for (const app of apps) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      // Same construction as the compose/labels build (app-lifecycle command.ts):
      // the router host in cloudflare mode is the origin server name.
      const appSubdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;
      /** Registers a hostname and returns the key it was stored under (empty when there was none),
       *  so callers needing the normalized form reuse this one normalization instead of repeating
       *  it — the two maps can then never disagree about a key's shape. */
      const register = (hostname: string | null | undefined): string => {
        const normalized = normalizeForwardedHost(hostname ?? undefined);
        if (normalized) {
          map.set(normalized, appUrn);
        }
        return normalized;
      };

      try {
        register(
          buildOriginServerName({
            appSubdomain,
            hubSubdomain: org?.hubSubdomain,
            orgSlug: org?.slug,
            localDomain,
          }),
        );
        const publicHostname = register(
          buildPublicWebIdentity({
            appSubdomain,
            publicDomainRoot: resolvePublicDomainRoot({
              selectedPublicDomain: app.publicDomain ?? undefined,
              envDomain: undefined,
              configDomain: domain,
            }),
            hubSubdomain: org?.hubSubdomain,
            orgSlug: org?.slug,
          }).hostname,
        );
        if (publicHostname) {
          publicHosts.set(appUrn, publicHostname);
        }
        register(app.domain); // operator-entered custom domain
      } catch (err) {
        // One malformed app row must never take forward-auth down for the rest.
        this.logger.warn(`[ForwardAuthSecretResolver] skipped ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.hostToUrn = map;
    this.urnToPublicHost = publicHosts;
    this.hostMapExpiresAt = Date.now() + CACHE_TTL_MS;
    this.warnedUrns.clear();
    this.logger.debug(`[ForwardAuthSecretResolver] host map rebuilt (${map.size} hostnames)`);
  }

  /**
   * The PUBLIC hostname of the app a forward-auth subrequest targets, or null when the forwarded
   * host matches no installed app (or the app has no public identity). Used by the edge-SSO
   * redirect (#77): the tunnel rewrites every visitor's Host to the origin server name, so the
   * forwarded host can identify the app but must never be echoed back to a REMOTE browser — this
   * is the address that browser can actually reach. Never throws; shares the host map's TTL,
   * single-flight rebuild and error backoff.
   */
  async resolvePublicHostForHost(forwardedHost: string | string[] | undefined): Promise<string | null> {
    const appUrn = await this.resolveAppUrnForHost(forwardedHost);
    if (!appUrn) {
      return null;
    }
    return this.urnToPublicHost.get(appUrn) ?? null;
  }

  /**
   * The installed app a hostname belongs to, or null. Doubles as the edge-SSO redirect-target
   * allowlist: a mint request may only point back at a hostname this map vouches for, which is
   * exactly "a router hostname of an app installed on THIS appliance" — an exact membership check
   * rather than a label-pattern heuristic. Never throws.
   */
  async resolveAppUrnForHost(forwardedHost: string | string[] | undefined): Promise<AppUrn | null> {
    const host = this.normalizeHost(forwardedHost);
    if (!host) {
      return null;
    }
    try {
      await this.ensureHostMapFresh();
    } catch {
      // ensureHostMapFresh swallows rebuild errors itself; this is pure belt-and-suspenders.
    }
    return this.hostToUrn.get(host) ?? null;
  }

  /**
   * Ensure the host map is fresh, single-flighting the rebuild so a burst of subrequests past the
   * TTL shares ONE repo read. On failure it keeps the last-known-good map and backs off briefly
   * rather than re-attempting the failing reads on every request — an outage degrades to serving
   * slightly stale host→app mappings, never to a per-request query storm.
   */
  private async ensureHostMapFresh(): Promise<void> {
    if (this.hostMapExpiresAt > Date.now()) {
      return;
    }
    if (!this.hostMapRebuild) {
      this.hostMapRebuild = this.rebuildHostMap()
        .catch((err) => {
          this.hostMapExpiresAt = Date.now() + HOST_MAP_ERROR_BACKOFF_MS;
          this.logger.warn(`[ForwardAuthSecretResolver] host map rebuild failed, backing off: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.hostMapRebuild = null;
        });
    }
    await this.hostMapRebuild;
  }

  /**
   * Drop any cached signing secret for an app so the next subrequest re-reads its app.env. Called
   * on rotate (via ModuleRef, to avoid a module cycle): the app is about to restart holding a
   * freshly minted secret, and a still-valid cache entry for its OLD secret would otherwise keep
   * being signed until the TTL lapsed — 401ing the app for up to a full TTL after it came back up.
   * Deleting entries of the current Map during iteration is well-defined in JS.
   */
  invalidateApp(appUrn: AppUrn): void {
    for (const [host, entry] of this.secretCache) {
      if (entry.value.appUrn === appUrn) {
        this.secretCache.delete(host);
      }
    }
  }

  /**
   * Resolve the signing secret for a forward-auth subrequest. Never throws: any failure falls
   * back to the Hub-global secret, preserving pre-#74 behaviour.
   */
  async resolveForHost(forwardedHost: string | string[] | undefined): Promise<ResolvedForwardAuthSecret> {
    const host = this.normalizeHost(forwardedHost);
    if (!host) {
      return this.globalSecret();
    }

    const cached = this.secretCache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // A definitive per-app secret is cached for the full TTL; a matched-but-secretless fallback is
    // cached only briefly (SECRETLESS_CACHE_TTL_MS); a transient READ ERROR and an unmatched host
    // are not cached at all. This is what stops the Hub from pinning the global secret over a state
    // that is usually transient (an app mid-install/mid-rotation) and 401ing it for a full TTL once
    // its own secret lands — while still absorbing a request burst to a permanently-legacy
    // secretless app into one env read rather than one per request.
    let resolved: ResolvedForwardAuthSecret;
    let ttlMs = CACHE_TTL_MS;
    try {
      await this.ensureHostMapFresh();
      const appUrn = this.hostToUrn.get(host);
      if (!appUrn) {
        // Unknown host (Hub dashboard, not-an-app route) — expected constantly, debug only.
        return this.globalSecret();
      }
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      const secret = (this.envUtils.envStringToMap(appEnv.content).get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim();
      if (secret) {
        resolved = { secret, appUrn, source: 'app-env' };
      } else {
        // Matched app without a provisioned secret: legitimate for apps that predate the per-app
        // rollout (they verify nothing) and transiently true for one mid-install/mid-rotation.
        // Sign with the global value they may hold, cached only briefly so a secret that lands is
        // picked up within a couple of seconds rather than a full TTL later.
        if (!this.warnedUrns.has(appUrn)) {
          this.warnedUrns.add(appUrn);
          this.logger.warn(`[ForwardAuthSecretResolver] ${appUrn} has no forward-auth secret in app.env; signing with the global secret`);
        }
        resolved = { ...this.globalSecret(), appUrn };
        ttlMs = SECRETLESS_CACHE_TTL_MS;
      }
    } catch (err) {
      // A read error is truly transient (disk hiccup, env mid-write); never cache it — the very
      // next request should re-read rather than serve a pinned global fallback.
      this.logger.warn(`[ForwardAuthSecretResolver] resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
      return this.globalSecret();
    }

    this.secretCache.set(host, { value: resolved, expiresAt: Date.now() + ttlMs });
    // Belt-and-suspenders bound. Only matched-app entries reach here, so the cache is already
    // bounded by the installed-app count (~apps × hostnames); this guards against a pathological
    // host-map explosion, not attacker junk (junk hosts never get this far).
    if (this.secretCache.size > 512) {
      this.secretCache.clear();
    }
    return resolved;
  }
}
