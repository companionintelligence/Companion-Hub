import { Injectable } from '@nestjs/common';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { publicRoutingSnapshotOf, publishesCloudflarePublicRoute, type AppPublicRoutingSnapshot } from '@/modules/apps/app-public-routing.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { buildFqdnSubdomain, type AppUrn } from '@ci-hub/common/types';
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
 * compose file has no router rule for its current `<app>-<device>-<org>` is restarted. A stopped app
 * gets the new name when it is next started. Only apps that publish a public route count: the rest
 * have no tunnel name to answer to.
 *
 * Only the device and organization part is compared, not the local domain after it. The compose file
 * takes its local domain from the app's own env first (`prepareAppComposeDir`), so it can differ from
 * the Hub setting. Compared whole, such an app would never match, and every Hub start would restart
 * it without changing its rule.
 */
@Injectable()
export class OriginHostRefreshService {
  /** Each app already restarted onto a given name, so a restart still queued isn't repeated. */
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly registrationService: RegistrationService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  /**
   * Restarts the running, publicly routed apps whose compose file has no router rule for their current
   * device and organization. `skip` is apps another refresh has just restarted: that restart writes the compose file too.
   *
   * Returns the apps it restarted.
   */
  async refreshStaleOriginHosts(skip: readonly AppUrn[] = []): Promise<AppUrn[]> {
    const registration = await this.registrationService.getDeviceRegistrationInfo();
    const orgSlug = registration?.slug?.trim();
    if (!orgSlug) {
      return [];
    }

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

      // The device and organization part of the name the app sync sends this app's requests with
      // (`buildOriginServerName` in `ExposureSyncService`), without the local domain after it.
      const fqdnSubdomain = buildFqdnSubdomain(app.localSubdomain || `${app.appName}-${app.appStoreSlug}`, registration?.hubSubdomain, orgSlug);
      const attempt = `${appUrn}|${fqdnSubdomain}`;
      if (this.dispatched.has(attempt)) {
        continue;
      }

      try {
        const { content } = await this.appFilesManager.getDockerComposeYaml(appUrn);
        if (typeof content !== 'string' || content.includes(`Host(\`${fqdnSubdomain}.`)) {
          continue;
        }

        this.dispatched.add(attempt);
        this.logger.info(`[OriginHostRefresh] Restarting ${appUrn} so its router answers to ${fqdnSubdomain} after the Hub was paired again`);
        await this.appLifecycleService.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'origin-host-refresh' } });
        restarted.push(appUrn);
      } catch (error) {
        // Nothing was queued, so the next pass may try again.
        this.dispatched.delete(attempt);
        this.logger.error(
          `[OriginHostRefresh] Could not move ${appUrn} onto ${fqdnSubdomain}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return restarted;
  }
}
