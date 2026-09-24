import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildOriginServerName, buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { normalizeForwardedHost } from './utils/forward-auth-host';

/**
 * Cache interval for host mappings and resolved secrets. Rotation restarts outlast this
 * window, which limits stale entries to the existing interruption.
 */
const CACHE_TTL_MS = 30_000;

/**
 * Briefly caches global fallbacks for matched apps without a per-app secret. This absorbs
 * request bursts from legacy apps while quickly detecting secrets added during installation
 * or rotation.
 */
const SECRETLESS_CACHE_TTL_MS = 2_000;

/**
 * Applies a short backoff after failed host-map rebuilds. This permits quick recovery
 * without retrying failed dependencies on every subrequest.
 */
const HOST_MAP_ERROR_BACKOFF_MS = 5_000;

export interface ResolvedForwardAuthSecret {
  secret: string;
  /** Target app when the forwarded host matches an installed app. */
  appUrn?: AppUrn;
  source: 'app-env' | 'global';
}

interface CacheEntry {
  value: ResolvedForwardAuthSecret;
  expiresAt: number;
}

/**
 * Resolves the secret used to sign forward-auth identity headers for the target app
 * identified by `X-Forwarded-Host` (CI-Engineering#74). Each app's `app.env` is
 * authoritative, and an app can affect only signatures destined for itself. The forwarded
 * host identifies only the target app, never caller locality (CI-Engineering#75).
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

  private globalSecret(): ResolvedForwardAuthSecret {
    return { secret: this.config.get('forwardAuthSecret') ?? '', source: 'global' };
  }

  private async rebuildHostMap(): Promise<void> {
    const map = new Map<string, AppUrn>();
    const publicHosts = new Map<AppUrn, string>();
    const [apps, org] = await Promise.all([this.appsRepository.getApps(), this.deviceRegistration.getFirstDeviceRegistration()]);
    // Match app-lifecycle precedence so operator settings override defaults.
    const cfg = this.config.getConfig();
    const localDomain = cfg.userSettings?.localDomain || cfg.localDomain;
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
    for (const [host, entry] of this.secretCache) {
      if (entry.value.appUrn === appUrn) {
        this.secretCache.delete(host);
      }
    }
  }

  /**
   * Resolves the signing secret for a forward-auth subrequest. Failures fall back to the
   * Hub-global secret for compatibility with apps that predate CI-Engineering#74.
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

    // Cache definitive app secrets for the full TTL and secretless fallbacks briefly.
    // Unmatched hosts and read errors remain uncached so transient state recovers promptly.
    let resolved: ResolvedForwardAuthSecret;
    let ttlMs = CACHE_TTL_MS;
    try {
      await this.ensureHostMapFresh();
      const appUrn = this.hostToUrn.get(host);
      if (!appUrn) {
        // Dashboard and other non-app routes legitimately use the global secret.
        return this.globalSecret();
      }
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      const secret = (this.envUtils.envStringToMap(appEnv.content).get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim();
      if (secret) {
        resolved = { secret, appUrn, source: 'app-env' };
      } else {
        // Legacy apps may lack a per-app secret, as can apps during installation or rotation.
        // Cache the global fallback briefly so a new secret becomes visible quickly.
        if (!this.warnedUrns.has(appUrn)) {
          this.warnedUrns.add(appUrn);
          this.logger.warn(`[ForwardAuthSecretResolver] ${appUrn} has no forward-auth secret in app.env; signing with the global secret`);
        }
        resolved = { ...this.globalSecret(), appUrn };
        ttlMs = SECRETLESS_CACHE_TTL_MS;
      }
    } catch (err) {
      // Do not cache read failures so the next request can recover.
      this.logger.warn(`[ForwardAuthSecretResolver] resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
      return this.globalSecret();
    }

    this.secretCache.set(host, { value: resolved, expiresAt: Date.now() + ttlMs });
    // Bound the cache if a malformed host map exceeds the expected number of app hostnames.
    if (this.secretCache.size > 512) {
      this.secretCache.clear();
    }
    return resolved;
  }
}
