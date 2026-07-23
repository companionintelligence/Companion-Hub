import { Injectable, NotFoundException } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { hubTrustMaterialScopes } from '@/modules/apps/app.helpers';
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
    const [managed, appEnv] = await Promise.all([this.apiKeys.findManagedByApp(appUrn), this.appFilesManager.getAppEnv(appUrn)]);
    const envMap = this.envUtils.envStringToMap(appEnv.content);
    return {
      appKey: managed ? { prefix: managed.prefix, scopes: managed.scopes, lastUsedAt: managed.lastUsedAt, createdAt: managed.createdAt } : null,
      identityVerification: (envMap.get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim().length > 0,
      // Same gate generateEnvFile provisions from — never a restatement of it.
      provisioned: hubTrustMaterialScopes(info).length > 0,
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

    // The restart is what re-provisions: until it lands, the app still holds credentials the Hub
    // has just stopped honouring. That ordering is forced (regeneration only happens on restart),
    // so a failure here must be loud and must name the remedy — silently returning would leave the
    // app authenticating against nothing with no indication that a manual restart fixes it.
    //
    // No explicit ForwardAuthSecretResolver cache flush is needed: that cache's TTL is deliberately
    // shorter than a container restart (see CACHE_TTL_MS), so by the time the app is back up holding
    // its fresh secret the stale entry has already expired — the same brief-401-during-restart
    // window the resolver already documents, which a rotation is just one instance of.
    try {
      const dispatched = await this.appLifecycle.restartApp({ appUrn });
      this.logger.info('Hub access material rotated', appUrn);
      return dispatched;
    } catch (error) {
      this.logger.error(
        `[HubAccessService] rotated Hub access for ${appUrn} but the restart could not be dispatched — the app is running with revoked credentials until it is restarted manually`,
        error,
      );
      throw error;
    }
  }
}
