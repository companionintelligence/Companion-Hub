import { Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { hubTrustMaterialScopes } from '@/modules/apps/app.helpers';
import { ForwardAuthSecretResolver } from '@/modules/auth/forward-auth-secret.resolver';
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
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Load the installed app manifest or 404 — shared by getStatus and rotate. */
  private async requireApp(appUrn: AppUrn) {
    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!info) {
      throw new NotFoundException(`App ${appUrn} not found`);
    }
    return info;
  }

  /** What Hub trust material this app currently holds. */
  async getStatus(appUrn: AppUrn): Promise<HubAccessStatus> {
    // All three reads are independent — the manifest, the managed key, and the app.env — so fetch
    // them together rather than serializing the manifest load ahead of the other two.
    const [info, managed, appEnv] = await Promise.all([
      this.requireApp(appUrn),
      this.apiKeys.findManagedByApp(appUrn),
      this.appFilesManager.getAppEnv(appUrn),
    ]);
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
    await this.requireApp(appUrn);

    await this.apiKeys.revokeManagedByApp(appUrn);

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const envMap = this.envUtils.envStringToMap(appEnv.content);
    if (envMap.delete('CI_HUB_FORWARD_AUTH_SECRET')) {
      await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
    }

    // Drop the resolver's cached signing secret for this app NOW. The old per-app secret may still
    // be a valid, unexpired cache entry; without this, /api/auth/traefik would keep signing with it
    // for up to a full TTL after the app restarts holding its freshly minted secret — 401ing every
    // request in between. Resolved lazily via ModuleRef so AppLifecycleModule need not depend on
    // AuthModule (mirrors uninstall-app-command's ApiKeyService lookup); a miss is non-fatal (the
    // TTL then bounds the window as before).
    try {
      this.moduleRef.get(ForwardAuthSecretResolver, { strict: false })?.invalidateApp(appUrn);
    } catch (error) {
      this.logger.warn(
        `[HubAccessService] could not flush forward-auth cache for ${appUrn}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The restart is what re-provisions: until it lands, the app still holds credentials the Hub
    // has just stopped honouring. That ordering is forced (regeneration only happens on restart),
    // so a failure here must be loud and must name the remedy — silently returning would leave the
    // app authenticating against nothing with no indication that a manual restart fixes it.
    try {
      // As the Hub: the rotation was the authorized act (`configure`), and a refused restart would
      // strand the app on the credentials just revoked.
      const dispatched = await this.appLifecycle.restartApp({ appUrn, actor: { kind: 'system', reason: 'hub-access-rotate' } });
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
