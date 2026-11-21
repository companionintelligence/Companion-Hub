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
 * Recreates a running app whose HUB_TRUSTED_PROXY_CIDRS trusts an address no hop on its network holds.
 *
 * Each app is told the edge hops and Traefik's fixed address on the app's own network
 * (`ProxyTrustService.appTrustedProxyCidrs`). An app's env is only written when it starts, so a
 * running app can hold a list the Hub would no longer write: Traefik's address on the shared Hub
 * network, from before apps had networks of their own, which Docker gives to the next container that
 * asks once Traefik leaves it; or the Traefik address of a subnet the app was moved off after a
 * network overlap. An app trusting such an address would let whoever holds it name any client address
 * it liked, defeating the per-address login throttle and session binding the value exists for.
 *
 * So every read of the hops (`ProxyTrustService.onResolved`, once a minute) is compared with what each
 * running app was given, and an app that trusts anything outside its current set is restarted, which
 * regenerates its env. Only a stale address counts: an app trusting fewer hops than it could is
 * narrower, not unsafe. Only apps whose compose file reads the value are restarted; the rest carry it
 * unread. A read that did not find Traefik changes nothing, so a Traefik being recreated or a Docker
 * hiccup never restarts an app.
 */
@Injectable()
export class TrustedProxyRefreshService implements OnModuleInit, OnModuleDestroy {
  /**
   * Each app already restarted from a given stale list toward the set it should hold, so a restart still
   * queued is not repeated every minute. Keyed on both, so a subnet that changes again is followed too.
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

  private async reconcile(_current: string[], target: string): Promise<AppUrn[]> {
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
        // What this app may trust now: the edge hops and Traefik's fixed address on its own network.
        // Anything else is stale: Traefik's address on the shared Hub network, from before apps had
        // networks of their own, or the Traefik address of a subnet the app no longer has.
        const expected = new Set(this.proxyTrust.appTrustedProxyCidrs(app.subnet));
        const stale = given.filter((cidr) => !expected.has(cidr) && !edgeHops.has(cidr));
        const attempt = `${appUrn}|${given.join(',')}|${[...expected].join(',')}`;
        if (stale.length === 0 || !(await this.readsTrustedProxies(appUrn))) {
          continue;
        }
        settled = false;
        if (this.dispatched.has(attempt)) {
          continue;
        }

        this.dispatched.add(attempt);
        this.logger.info(
          `[TrustedProxyRefresh] Restarting ${appUrn}: it trusts ${stale.join(', ')} as a proxy, which no hop on its network holds (now ${[...expected].join(',')})`,
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
