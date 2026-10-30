import { Injectable } from '@nestjs/common';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import {
  publicRoutingSnapshotOf,
  publishesCloudflarePublicRoute,
  resolveRoutingSubdomain,
  type AppPublicRoutingSnapshot,
} from '@/modules/apps/app-public-routing.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import { buildFqdnSubdomain, type AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from './app-lifecycle.service';

/**
 * Recreates a running app whose tunnel router still answers to the Hub's old device or organization
 * name. A restart writes the compose file from the current registration; a stopped app moves when it
 * is next started (#2178).
 *
 * Only the `<app>-<device>-<org>` part of the rule is compared. The local domain after it comes from
 * the app's own env first, so comparing it too restarted such an app on every Hub start.
 */
@Injectable()
export class OriginHostRefreshService {
  /** Passes a refused restart is tried on before it waits for the next pairing or Hub start. */
  static readonly MAX_ATTEMPTS = 8;

  /** The name each app was last restarted onto, so a restart still queued isn't sent again. */
  private readonly dispatched = new Map<AppUrn, string>();
  /** Apps whose restart was refused (the app was busy, or the queue was down), with the passes tried. */
  private refused = new Map<AppUrn, number>();
  private lastPass: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly logger: LoggerService,
    private readonly registrationService: RegistrationService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  /** True while a restart an earlier pass was refused is waiting to be tried again. */
  hasRefusedRestarts(): boolean {
    return this.refused.size > 0;
  }

  /**
   * Restarts the running, publicly routed apps whose compose file routes another name. `skip` is apps
   * another refresh has just restarted, since that restart writes the compose file too. `onlyRefused`
   * looks only at the apps an earlier pass could not restart.
   *
   * Passes run one at a time. Returns the apps this pass restarted.
   */
  refreshStaleOriginHosts(skip: readonly AppUrn[] = [], options: { onlyRefused?: boolean } = {}): Promise<AppUrn[]> {
    const pass = this.lastPass.then(() => this.refresh(new Set(skip), options.onlyRefused === true));
    this.lastPass = pass.catch(() => undefined);
    return pass;
  }

  private async refresh(skipped: ReadonlySet<AppUrn>, onlyRefused: boolean): Promise<AppUrn[]> {
    const registration = await this.registrationService.getDeviceRegistrationInfo();
    const orgSlug = registration?.slug?.trim();
    if (!orgSlug) {
      this.refused.clear();
      return [];
    }

    const triedBefore = this.refused;
    this.refused = new Map();
    const restarted: AppUrn[] = [];

    for (const app of await this.appsRepository.getApps()) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      if (
        (onlyRefused && !triedBefore.has(appUrn)) ||
        app.status !== 'running' ||
        skipped.has(appUrn) ||
        // An exposed port is routed by Traefik's file provider, which pairing rebuilds (`syncPortExposeRoutes`).
        isPortExposeApp(app.config) ||
        !publishesCloudflarePublicRoute(publicRoutingSnapshotOf(app as AppPublicRoutingSnapshot))
      ) {
        continue;
      }

      // The device and organization part of the name the app sync sends this app's requests with
      // (`buildOriginServerName` in `ExposureSyncService`), without the local domain after it.
      const fqdnSubdomain = buildFqdnSubdomain(
        resolveRoutingSubdomain(app.localSubdomain, app.appName, app.appStoreSlug),
        registration?.hubSubdomain,
        orgSlug,
      );
      if (this.dispatched.get(appUrn) === fqdnSubdomain) {
        continue;
      }

      try {
        const { content } = await this.appFilesManager.getDockerComposeYaml(appUrn);
        // With no router at all (a main service without a port gets none) a restart adds nothing.
        if (typeof content !== 'string' || !content.includes('Host(`') || content.includes(`Host(\`${fqdnSubdomain}.`)) {
          continue;
        }

        this.logger.info(`[OriginHostRefresh] Restarting ${appUrn} so its router answers to ${fqdnSubdomain} after the Hub was paired again`);
        await this.appLifecycleService.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'origin-host-refresh' } });
        this.dispatched.set(appUrn, fqdnSubdomain);
        restarted.push(appUrn);
      } catch (error) {
        const attempts = (triedBefore.get(appUrn) ?? 0) + 1;
        const reason = error instanceof Error ? error.message : String(error);
        if (attempts < OriginHostRefreshService.MAX_ATTEMPTS) {
          this.refused.set(appUrn, attempts);
          this.logger.warn(`[OriginHostRefresh] Could not move ${appUrn} onto ${fqdnSubdomain} yet (${reason}); trying again shortly`);
        } else {
          this.logger.error(`[OriginHostRefresh] Could not move ${appUrn} onto ${fqdnSubdomain} after ${attempts} tries: ${reason}`);
        }
      }
    }

    return restarted;
  }
}
