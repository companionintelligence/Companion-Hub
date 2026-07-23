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

/**
 * How long resolved host→secret entries (and the host→app map behind them) are trusted before a
 * re-read. A per-app secret only changes at env regeneration, which coincides with a container
 * restart that itself outlasts this window — so a stale entry can at worst 401 briefly during a
 * restart that is already interrupting the app's traffic.
 */
const CACHE_TTL_MS = 30_000;

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

  /** Lowercase and strip any port — Traefik forwards the host exactly as the client sent it. */
  private normalizeHost(forwardedHost: string | string[] | undefined): string {
    const raw = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    if (typeof raw !== 'string') {
      return '';
    }
    return raw.trim().toLowerCase().replace(/:\d+$/, '');
  }

  private globalSecret(): ResolvedForwardAuthSecret {
    return { secret: this.config.get('forwardAuthSecret') ?? '', source: 'global' };
  }

  /** Register every hostname an installed app's router could present. */
  private async rebuildHostMap(): Promise<void> {
    const map = new Map<string, AppUrn>();
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
      const register = (hostname: string | null | undefined) => {
        const normalized = (hostname ?? '').trim().toLowerCase();
        if (normalized) {
          map.set(normalized, appUrn);
        }
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
        register(
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
        register(app.domain); // operator-entered custom domain
      } catch (err) {
        // One malformed app row must never take forward-auth down for the rest.
        this.logger.warn(`[ForwardAuthSecretResolver] skipped ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.hostToUrn = map;
    this.hostMapExpiresAt = Date.now() + CACHE_TTL_MS;
    this.warnedUrns.clear();
    this.logger.debug(`[ForwardAuthSecretResolver] host map rebuilt (${map.size} hostnames)`);
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

    // ONLY a definitive per-app secret read from app.env is cached. Every fallback to the global
    // secret — unmatched host, matched-but-secretless app, or a transient read error — returns
    // WITHOUT caching. Caching a fallback would pin the global secret for a full TTL over a state
    // that is usually transient (an app mid-install, mid-rotation, or briefly unreadable), so the
    // Hub would keep signing with the global secret for up to 30s after the app came back up
    // holding its own per-app secret and began rejecting every global-signed header. The only cost
    // of not caching is re-reading a secretless app's env per request, which is bounded (such apps
    // are transitional) and cheap next to a sustained window of 401s.
    let resolved: ResolvedForwardAuthSecret;
    try {
      await this.ensureHostMapFresh();
      const appUrn = this.hostToUrn.get(host);
      if (!appUrn) {
        // Unknown host (Hub dashboard, not-an-app route) — expected constantly, debug only.
        return this.globalSecret();
      }
      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      const secret = (this.envUtils.envStringToMap(appEnv.content).get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim();
      if (!secret) {
        // Matched app without a provisioned secret: legitimate for apps that predate the per-app
        // rollout (they verify nothing) and transiently true for one mid-install/mid-rotation.
        // Sign with the global value they may hold, but do NOT cache it — the secret can land at
        // any moment and a cached fallback would keep rejecting it until the TTL lapsed.
        if (!this.warnedUrns.has(appUrn)) {
          this.warnedUrns.add(appUrn);
          this.logger.warn(`[ForwardAuthSecretResolver] ${appUrn} has no forward-auth secret in app.env; signing with the global secret`);
        }
        return { ...this.globalSecret(), appUrn };
      }
      resolved = { secret, appUrn, source: 'app-env' };
    } catch (err) {
      this.logger.warn(`[ForwardAuthSecretResolver] resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`);
      return this.globalSecret();
    }

    this.secretCache.set(host, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
    // Belt-and-suspenders bound. Only definitive per-app entries reach here, so the cache is
    // already bounded by the installed-app count (~apps × hostnames); this guards against a
    // pathological host-map explosion, not attacker junk (junk hosts never get this far).
    if (this.secretCache.size > 512) {
      this.secretCache.clear();
    }
    return resolved;
  }
}
