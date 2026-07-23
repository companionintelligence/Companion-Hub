import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { needsHubAppKey } from '@/modules/apps/app.helpers';
import { isOfficialStoreApp } from '@/modules/apps/official-store.predicate';
import { EnvUtils } from '@/modules/env/env.utils';
import { AppLifecycleService } from './app-lifecycle.service';

/** Operator-facing view of one app's Hub-provisioned trust material. Never carries raw values. */
export interface HubAccessStatus {
  /** The app's managed key, when one exists — prefix + metadata only. */
  appKey: { prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string } | null;
  /** Whether a per-app forward-auth secret is provisioned (in-app identity verification active). */
  identityVerification: boolean;
  /** Whether this app would be (re-)provisioned trust material on its next env generation. */
  provisioned: boolean;
}

/**
 * Per-app operator surface for Hub-provisioned trust material (CI-Engineering#74): what the app
 * holds (managed key prefix, forward-auth state) and the rotation lever. Rotation exists because
 * per-app credentials without a per-app remediation would leave "reinstall the app" as the only
 * response to a leak.
 */
@Injectable()
export class HubAccessService {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly appFilesManager: AppFilesManager,
    private readonly appLifecycle: AppLifecycleService,
    private readonly envUtils: EnvUtils,
    private readonly logger: LoggerService,
  ) {}

  /** What Hub trust material this app currently holds. */
  async getStatus(appUrn: AppUrn): Promise<HubAccessStatus> {
    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!info) {
      throw new NotFoundException(`App ${appUrn} not found`);
    }
    const [keys, appEnv] = await Promise.all([this.apiKeys.list(), this.appFilesManager.getAppEnv(appUrn)]);
    const managed = keys.find((key) => key.managed && key.ownerAppUrn === appUrn) ?? null;
    const envMap = this.envUtils.envStringToMap(appEnv.content);
    return {
      appKey: managed ? { prefix: managed.prefix, scopes: managed.scopes, lastUsedAt: managed.lastUsedAt, createdAt: managed.createdAt } : null,
      identityVerification: (envMap.get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim().length > 0,
      provisioned: Boolean(info.hub_integration?.mcp_client) || (isOfficialStoreApp(info) && needsHubAppKey(info)),
    };
  }

  /**
   * Rotate the app's Hub trust material: revoke the managed key row and clear the per-app
   * forward-auth secret from app.env, then restart the app — the restart regenerates the env,
   * where provisioning mints a fresh key (the old raw no longer resolves) and a fresh secret
   * (preserve-or-mint finds nothing to preserve). One lifecycle event flips the container and
   * the Hub's signing source together, so nothing is left verifying against a dead value.
   */
  async rotate(appUrn: AppUrn): Promise<{ requestId: string }> {
    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!info) {
      throw new NotFoundException(`App ${appUrn} not found`);
    }

    await this.apiKeys.revokeManagedByApp(appUrn);

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const envMap = this.envUtils.envStringToMap(appEnv.content);
    if (envMap.delete('CI_HUB_FORWARD_AUTH_SECRET')) {
      await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
    }

    this.logger.info('Hub access material rotated', appUrn);
    return this.appLifecycle.restartApp({ appUrn });
  }
}
