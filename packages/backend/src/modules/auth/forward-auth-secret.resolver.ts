import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { resolveHubLocalDomainRoot, resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { isMemoryProviderApp } from '@/modules/memory-connect/memory-provider.predicate';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { normalizeForwardedHost } from './utils/forward-auth-host';
import type { ForwardAuthSigningKeys } from './utils/forward-auth-signing';

/**
 * Cache interval for host mappings and resolved secrets. Rotation restarts outlast this
 * window, which limits stale entries to the existing interruption.
 */
const CACHE_TTL_MS = 30_000;

/**
 * Briefly caches matched apps without a forward-auth key. This absorbs request bursts from
 * such apps while quickly detecting keys added during installation or rotation.
 */
const SECRETLESS_CACHE_TTL_MS = 2_000;

/** The app-env key forward auth signs the username triple and stable id with. */
export const FORWARD_AUTH_SECRET_ENV = 'CI_HUB_FORWARD_AUTH_SECRET';

/**
 * Companion Memory's own forward-auth key. Memory's `CI_HUB_FORWARD_AUTH_SECRET` is the Hub-wide
 * secret, because it also authenticates the connect exchange and the agent doorbell, so it cannot
 * be Memory's own; this one signs Memory's bound assertion instead.
 */
export const FORWARD_AUTH_IDENTITY_SECRET_ENV = 'CI_HUB_FORWARD_AUTH_IDENTITY_SECRET';

/**
 * Applies a short backoff after failed host-map rebuilds. This permits quick recovery
 * without retrying failed dependencies on every subrequest.
 */
const HOST_MAP_ERROR_BACKOFF_MS = 5_000;

export interface ResolvedForwardAuthSecret extends ForwardAuthSigningKeys {
  /** Target app when the forwarded host matches an installed app. */
  appUrn?: AppUrn;
  /** `none` when nothing may be signed: no app matched, or the app holds no key. */
  source: 'app-env' | 'none';
}

interface CacheEntry {
  value: ResolvedForwardAuthSecret;
  expiresAt: number;
}

/**
 * Resolves the keys used to sign forward-auth identity headers for the target app
 * identified by `X-Forwarded-Host` (CI-Engineering#74). Each app's `app.env` is
 * authoritative, and an app can affect only signatures destined for itself. The forwarded
 * host identifies only the target app, never caller locality (CI-Engineering#75).
 *
 * Nothing is ever signed with the Hub-wide secret for an app that does not hold it. A host
 * that matches no app, or an app with no key, gets no signature at all, since such an app has
 * no key to check one with.
 */
@Injectable()
export class ForwardAuthSecretResolver {
  private hostToUrn = new Map<string, AppUrn>();
  /** Tunnel-rewritten hosts require a separate public return hostname for edge SSO (#77). */
  private urnToPublicHost = new Map<AppUrn, string>();
  private hostMapExpiresAt = 0;
  /** Shared rebuild prevents duplicate repository reads after cache expiry. */
  private hostMapRebuild: Promise<void> | null = null;
  private secretCache = new Map<string, CacheEntry>();
  /** Bumped by {@link invalidateApp}, so a lookup that read app.env before the bump does not cache what it read. */
  private invalidations = 0;
  /** Prevents per-request warnings until a map rebuild rechecks secretless apps. */
  private warnedUrns = new Set<string>();

  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly envUtils: EnvUtils,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /** Uses the same normalized host keys as edge SSO ticket binding. */
  private normalizeHost(forwardedHost: string | string[] | undefined): string {
    return normalizeForwardedHost(forwardedHost);
  }

  private unsigned(appUrn?: AppUrn): ResolvedForwardAuthSecret {
    return appUrn ? { secret: null, appUrn, source: 'none' } : { secret: null, source: 'none' };
  }

  /**
   * The keys in one app's env.
   *
   * - The triple is signed with the app's `CI_HUB_FORWARD_AUTH_SECRET`. Only Companion Memory may
   *   hold the Hub-wide value there (env generation puts it there for the connect exchange); any
   *   other app found holding it signs nothing.
   * - The bound assertion is signed with the app's own key: Memory's
   *   `CI_HUB_FORWARD_AUTH_IDENTITY_SECRET`, else a `CI_HUB_FORWARD_AUTH_SECRET` that is not the
   *   Hub-wide value. Its audience is the app's URN.
   */
  private keysFromEnv(appUrn: AppUrn, env: Map<string, string>): ResolvedForwardAuthSecret {
    const shared = (env.get(FORWARD_AUTH_SECRET_ENV) ?? '').trim();
    const identity = (env.get(FORWARD_AUTH_IDENTITY_SECRET_ENV) ?? '').trim();
    const hubWide = (this.config.get('forwardAuthSecret') ?? '').trim();
    const sharedIsHubWide = shared !== '' && shared === hubWide;

    const secret = shared && (!sharedIsHubWide || isMemoryProviderApp({ urn: appUrn })) ? shared : null;
    const ownKey = identity || (sharedIsHubWide ? '' : shared);
    if (!secret && !ownKey) {
      return this.unsigned(appUrn);
    }

    return {
      secret,
      ...(ownKey ? { assertion: { secret: ownKey, audience: appUrn } } : {}),
      appUrn,
      source: 'app-env',
    };
  }

  private async rebuildHostMap(): Promise<void> {
    const map = new Map<string, AppUrn>();
    const publicHosts = new Map<AppUrn, string>();
    const [apps, org] = await Promise.all([this.appsRepository.getApps(), this.deviceRegistration.getFirstDeviceRegistration()]);
    // Match app-lifecycle precedence so operator settings override defaults.
    const cfg = this.config.getConfig();
    const localDomain = resolveHubLocalDomainRoot(cfg);
    const domain = resolveHubPublicDomainRoot(cfg);

    for (const app of apps) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      // Match app-lifecycle router construction for Cloudflare origin names.
      const appSubdomain = app.localSubdomain || `${app.appName}-${app.appStoreSlug}`;
      // Return the normalized key so both maps use identical host forms.
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
        /*
         * Prefer Companion Portal's bound custom domain for edge SSO returns. Redirecting a
         * custom-domain visitor to the platform hostname breaks host-bound tickets and
         * can fail target validation (#77).
         */
        const boundCustomDomain = normalizeStoredHostname(app.customDomain);
        const registeredCustomDomain = boundCustomDomain ? register(boundCustomDomain) : null;

        const effectivePublicHostname = registeredCustomDomain || publicHostname;
        if (effectivePublicHostname) {
          publicHosts.set(appUrn, effectivePublicHostname);
        }
        register(app.domain);
      } catch (err) {
        // A malformed app row cannot block authentication for other apps.
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
   * Resolves the browser-reachable public hostname for the targeted app. Tunnel-rewritten
   * hosts identify the app but are not valid remote return URLs. Uses the shared map's TTL,
   * single-flight rebuild, and error backoff (#77).
   */
  async resolvePublicHostForHost(forwardedHost: string | string[] | undefined): Promise<string | null> {
    const appUrn = await this.resolveAppUrnForHost(forwardedHost);
    if (!appUrn) {
      return null;
    }
    return this.urnToPublicHost.get(appUrn) ?? null;
  }

  /**
   * Resolves an installed app by exact router-host membership. The same lookup allowlists
   * edge SSO redirect targets and returns null on errors.
   */
  async resolveAppUrnForHost(forwardedHost: string | string[] | undefined): Promise<AppUrn | null> {
    const host = this.normalizeHost(forwardedHost);
    if (!host) {
      return null;
    }
    try {
      await this.ensureHostMapFresh();
    } catch {
      // Rebuild failures already fall back to the last-known map.
    }
    return this.hostToUrn.get(host) ?? null;
  }

  /**
   * Refreshes host maps once per expired window, sharing one rebuild across callers.
   * Failures retain the last-known map and apply backoff to avoid per-request retries.
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
   * Evicts an app's cached secrets before rotation restarts it. Otherwise the old secret
   * can cause 401 responses until the cache expires.
   */
  invalidateApp(appUrn: AppUrn): void {
    this.invalidations += 1;
    for (const [host, entry] of this.secretCache) {
      if (entry.value.appUrn === appUrn) {
        this.secretCache.delete(host);
      }
    }
  }

  /**
   * Resolves the signing keys for a forward-auth subrequest. A missing host, an unmatched host,
   * and a failed read all resolve to no keys: the username goes out unsigned.
   */
  async resolveForHost(forwardedHost: string | string[] | undefined): Promise<ResolvedForwardAuthSecret> {
    const host = this.normalizeHost(forwardedHost);
    if (!host) {
      return this.unsigned();
    }

    const cached = this.secretCache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Cache definitive app keys for the full TTL and keyless apps briefly.
    // Unmatched hosts and read errors remain uncached so transient state recovers promptly.
    let resolved: ResolvedForwardAuthSecret;
    let ttlMs = CACHE_TTL_MS;
    const invalidationsAtStart = this.invalidations;
    try {
      await this.ensureHostMapFresh();
      const appUrn = this.hostToUrn.get(host);
      if (!appUrn) {
        return this.unsigned();
      }
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      resolved = this.keysFromEnv(appUrn, this.envUtils.envStringToMap(appEnv.content));
      if (resolved.source === 'none') {
        // Third-party apps hold no key, and neither does an app mid-install or mid-rotation.
        // Cache that briefly so a new key becomes visible quickly.
        if (!this.warnedUrns.has(appUrn)) {
          this.warnedUrns.add(appUrn);
          this.logger.debug(`[ForwardAuthSecretResolver] ${appUrn} has no forward-auth key in app.env; its identity headers go out unsigned`);
        }
        ttlMs = SECRETLESS_CACHE_TTL_MS;
      }
    } catch (err) {
      // Do not cache read failures so the next request can recover.
      this.logger.warn(`[ForwardAuthSecretResolver] resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
      return this.unsigned();
    }

    // An app.env written (and invalidated) while this lookup awaited may already hold newer keys.
    if (invalidationsAtStart !== this.invalidations) {
      return resolved;
    }

    this.secretCache.set(host, { value: resolved, expiresAt: Date.now() + ttlMs });
    // Bound the cache if a malformed host map exceeds the expected number of app hostnames.
    if (this.secretCache.size > 512) {
      this.secretCache.clear();
    }
    return resolved;
  }
}
