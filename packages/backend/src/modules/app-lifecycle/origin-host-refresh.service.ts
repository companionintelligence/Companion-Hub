import { Injectable } from '@nestjs/common';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { resolveHubLocalDomainRoot } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { publicRoutingSnapshotOf, publishesCloudflarePublicRoute, type AppPublicRoutingSnapshot } from '@/modules/apps/app-public-routing.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { buildOriginServerName, type AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from './app-lifecycle.service';

/**
 * Recreates a running app whose router still answers to the Hub's old device or organization name.
 *
 * An app's Traefik rule names the name the tunnel sends it, `<app>-<device>-<org>.<local domain>`,
 * and that name is written into its compose file when the app is installed or started. Pairing the
 * Hub again under another device name, or into another organization, makes the next app sync ask the
 * Portal for routes under the new name, while every running app still answers only to the old one:
 * the Portal listed the apps as Online and each of them opened Traefik's 404 (#2178).
 *
 * Starting an app writes its compose file again from the current registration, so a running app whose
 * compose file doesn't name the router name the sync sends now is restarted. A stopped app gets the
 * new name when it is next started. Only apps that publish a public route count: the rest have no
 * tunnel name to answer to.
 */
@Injectable()
export class OriginHostRefreshService {
  /** Each app already restarted onto a given name, so a restart still queued isn't repeated. */
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registrationService: RegistrationService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  /**
   * Restarts the running, publicly routed apps whose compose file doesn't name their current router
   * name. `skip` is apps another refresh has just restarted: that restart writes the compose file too.
   *
   * Returns the apps it restarted.
   */
  async refreshStaleOriginHosts(skip: readonly AppUrn[] = []): Promise<AppUrn[]> {
    const registration = await this.registrationService.getDeviceRegistrationInfo();
    if (!registration?.slug) {
      return [];
    }

    const localDomain = resolveHubLocalDomainRoot(this.config.getConfig());
    const skipped = new Set(skip);
    const restarted: AppUrn[] = [];

    for (const app of await this.appsRepository.getApps()) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      if (
        app.status !== 'running' ||
        skipped.has(appUrn) ||
        !publishesCloudflarePublicRoute(publicRoutingSnapshotOf(app as AppPublicRoutingSnapshot))
      ) {
        continue;
      }

      // The name the app sync sends this app's requests with (`ExposureSyncService`).
      const originHost = buildOriginServerName({
        appSubdomain: app.localSubdomain || `${app.appName}-${app.appStoreSlug}`,
        hubSubdomain: registration.hubSubdomain,
        orgSlug: registration.slug,
        localDomain,
      });
      const attempt = `${appUrn}|${originHost}`;
      if (this.dispatched.has(attempt)) {
        continue;
      }

      try {
        const { content } = await this.appFilesManager.getDockerComposeYaml(appUrn);
        if (typeof content !== 'string' || content.includes(`Host(\`${originHost}\`)`)) {
          continue;
        }

        this.dispatched.add(attempt);
        this.logger.info(`[OriginHostRefresh] Restarting ${appUrn} so its router answers to ${originHost} after the Hub was paired again`);
        await this.appLifecycleService.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'origin-host-refresh' } });
        restarted.push(appUrn);
      } catch (error) {
        // Nothing was queued, so the next pass may try again.
        this.dispatched.delete(attempt);
        this.logger.error(
          `[OriginHostRefresh] Could not move ${appUrn} onto ${originHost}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return restarted;
  }
}
