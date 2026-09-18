import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { receivesPortalDeviceKey } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from './app-lifecycle.service';

/**
 * Hands a new Portal device key to the app that calls Companion Portal as this device.
 *
 * Every pairing issues a new device key, and first-party Companion Memory receives it as `HUB_API_KEY`
 * only when its env is generated: on install, start, restart, update or reset. Nothing regenerated it
 * after a pairing, so a Memory that stayed installed across a re-pair kept calling the Portal with the
 * key the pairing had just replaced, and its cloud OAuth and geocoding failed until something else
 * happened to restart it.
 *
 * The whole env is regenerated, so the values Memory derives from the registration (the Portal origin
 * and its OIDC issuer, the domain) are refreshed with the key.
 */
@Injectable()
export class DeviceKeyRefreshService {
  /**
   * Each app and key already handed over, so an app whose env still reads stale afterwards (its
   * restart failed, say) is not restarted again on every check. A later key is tried afresh.
   */
  private readonly dispatched = new Set<string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly envUtils: EnvUtils,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  /**
   * Regenerates the env of every installed app that should hold the current device key and holds a
   * different one: a running app is restarted, a stopped one has its env rewritten for its next start.
   * An app with an operation under way is left to it, since that operation writes the env itself.
   *
   * Returns the apps it acted on.
   */
  async refreshStaleDeviceKeys(): Promise<AppUrn[]> {
    const deviceKey = (this.config.getConfig().ciHubApiKey ?? '').trim();
    if (!deviceKey) {
      return [];
    }

    const keyId = createHash('sha256').update(deviceKey).digest('hex').slice(0, 16);
    const refreshed: AppUrn[] = [];

    for (const app of await this.appsRepository.getApps()) {
      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      const attempt = `${appUrn}#${keyId}`;

      if (this.dispatched.has(attempt) || !(app.status === 'running' || app.status === 'stopped')) {
        continue;
      }

      const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
      if (!info || !receivesPortalDeviceKey(info)) {
        continue;
      }

      const { content } = await this.appFilesManager.getAppEnv(appUrn);
      if ((this.envUtils.envStringToMap(content).get('HUB_API_KEY') ?? '') === deviceKey) {
        continue;
      }

      this.dispatched.add(attempt);

      try {
        if (app.status === 'running') {
          this.logger.info(`[DeviceKeyRefresh] Restarting ${appUrn} so it calls CI Portal with this Hub's new device key`);
          await this.appLifecycleService.restartApp({ appUrn, skipPull: true, actor: { kind: 'system', reason: 'device-key-refresh' } });
        } else {
          this.logger.info(`[DeviceKeyRefresh] Rewriting the env of stopped ${appUrn} with this Hub's new device key`);
          if (!(await this.appLifecycleService.regenerateAppEnv(appUrn))) {
            continue;
          }
        }

        refreshed.push(appUrn);
      } catch (error) {
        this.logger.error(
          `[DeviceKeyRefresh] Could not hand the new device key to ${appUrn}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return refreshed;
  }
}
