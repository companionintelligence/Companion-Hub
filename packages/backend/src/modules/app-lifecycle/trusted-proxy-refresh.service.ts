import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { resolveEdgeHops } from '@/modules/network/edge-hops';
import { ProxyTrustService, type ProxyTrustSnapshot } from '@/modules/network/proxy-trust.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from './app-lifecycle.service';

/** The env key `AppHelpers.generateEnvFile` hands each app the trusted hops in. */
export const TRUSTED_PROXY_ENV_KEY = 'HUB_TRUSTED_PROXY_CIDRS';

/**
 * Recreates a running app whose HUB_TRUSTED_PROXY_CIDRS still trusts an address Traefik has left.
 *
 * Each app is handed Traefik's address on the Hub network when its env is generated, and that
 * address is Docker's to assign: when Traefik is recreated (an image bump, a compose change, the
 * edge network's own roll-out) or the host reboots and containers come back in another order, it
 * can land elsewhere, and Docker gives the address it left to the next container that asks. An app
 * still trusting it (CI Memory maps it onto its gateway's `set_real_ip_from`) would then let that
 * container name any client address it liked, defeating the per-address login throttle and session
 * binding the value exists for. Nothing else re-derives a running app's env: boot restarts apps only
 * on a Hub version change, and an app's container keeps the env it was created with.
 *
 * So every read of the hops (`ProxyTrustService.onResolved`, once a minute) is compared with what
 * each running app was given, and an app that trusts an address no longer in the set is restarted,
 * which regenerates its env. Only a stale address counts: an app trusting fewer hops than it could
 * is narrower, not unsafe, and the edge hops' fixed addresses cannot be handed to anything else (the
 * edge network's `ip_range`), so only Traefik's can go stale. Only apps whose compose file reads
 * the value are restarted; the rest carry it unread. A read that did not find Traefik changes
 * nothing, so a Traefik being recreated or a Docker hiccup never restarts an app.
 */
@Injectable()
export class TrustedProxyRefreshService implements OnModuleInit, OnModuleDestroy {
  /**
   * Each app already restarted from a given stale list to a given set, so a restart still queued is
   * not repeated every minute. Keyed on both, so a Traefik that moves back is followed too.
   */
  private readonly dispatched = new Set<string>();
  /**
   * The last set every running app was found to agree with; a read of the same set skips the scan.
   * A pass that restarted an app does not settle it, so the next read confirms the restart landed.
   */
  private settledTarget: string | null = null;
  private inFlight: Promise<AppUrn[]> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly proxyTrust: ProxyTrustService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly envUtils: EnvUtils,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  onModuleInit(): void {
    // Registered after the network module's first read, so the first check is a minute into the
    // boot, behind the version-change `restartRunningApps` that regenerates every running app.
    this.unsubscribe = this.proxyTrust.onResolved((snapshot) => {
      void this.refresh(snapshot);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Restarts the running apps that trust an address outside `snapshot`. Returns the apps it restarted. */
  async refresh(snapshot: ProxyTrustSnapshot): Promise<AppUrn[]> {
    if (!snapshot.traefikResolved || snapshot.cidrs.length === 0) {
      return [];
    }
    const target = snapshot.cidrs.join(',');
    if (target === this.settledTarget) {
      return [];
    }
    // One pass at a time; a read that lands meanwhile is picked up by the next one.
    if (this.inFlight) {
      return [];
    }
    this.inFlight = this.reconcile(snapshot.cidrs, target).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async reconcile(current: string[], target: string): Promise<AppUrn[]> {
    const trusted = new Set(current);
    const edgeHops = new Set(resolveEdgeHops().map((hop) => `${hop.address}/32`));
    const restarted: AppUrn[] = [];
    let settled = true;

    let apps: Awaited<ReturnType<AppsRepository['getApps']>>;
    try {
      apps = await this.appsRepository.getApps();
    } catch (error) {
      this.logger.warn(`[TrustedProxyRefresh] Could not list apps: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    for (const app of apps) {
      if (app.status !== 'running') {
        // Starting an app regenerates its env, so a stopped one picks up the current set then.
        continue;
      }
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);

      try {
        const { content } = await this.appFilesManager.getAppEnv(appUrn);
        const given = (this.envUtils.envStringToMap(content).get(TRUSTED_PROXY_ENV_KEY) ?? '')
          .split(',')
          .map((cidr) => cidr.trim())
          .filter(Boolean);
        const stale = given.filter((cidr) => !trusted.has(cidr) && !edgeHops.has(cidr));
        const attempt = `${appUrn}|${given.join(',')}|${target}`;
        if (stale.length === 0 || !(await this.readsTrustedProxies(appUrn))) {
          continue;
        }
        settled = false;
        if (this.dispatched.has(attempt)) {
          continue;
        }

        this.dispatched.add(attempt);
        this.logger.info(
          `[TrustedProxyRefresh] Restarting ${appUrn}: it trusts ${stale.join(', ')} as a proxy, which Traefik no longer holds (now ${target})`,
        );
        try {
          await this.appLifecycleService.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'trusted-proxy-refresh' } });
          restarted.push(appUrn);
        } catch (error) {
          // Nothing was queued, so try again on the next read.
          this.dispatched.delete(attempt);
          throw error;
        }
      } catch (error) {
        settled = false;
        this.logger.error(
          `[TrustedProxyRefresh] Could not bring ${appUrn}'s trusted proxies up to date: ${error instanceof Error ? error.message : String(error)}. Retrying on the next check.`,
        );
      }
    }

    if (settled) {
      this.settledTarget = target;
    }
    return restarted;
  }

  /** Whether the app's compose file maps HUB_TRUSTED_PROXY_CIDRS into a container. */
  private async readsTrustedProxies(appUrn: AppUrn): Promise<boolean> {
    const { content } = await this.appFilesManager.getDockerComposeYaml(appUrn);
    return typeof content === 'string' && content.includes(TRUSTED_PROXY_ENV_KEY);
  }
}
