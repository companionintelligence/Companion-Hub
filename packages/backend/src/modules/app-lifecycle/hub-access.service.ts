import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type AppUrn, type McpAccessChoice, mcpAccessGranted } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { hubTrustMaterialScopes } from '@/modules/apps/app.helpers';
import { FORWARD_AUTH_IDENTITY_SECRET_ENV, FORWARD_AUTH_SECRET_ENV, ForwardAuthSecretResolver } from '@/modules/auth/forward-auth-secret.resolver';
import { EnvUtils } from '@/modules/env/env.utils';
import { isMemoryProviderApp } from '@/modules/memory-connect/memory-provider.predicate';
import { AppLifecycleService } from './app-lifecycle.service';

/** Operator-facing view of one app's Hub-provisioned trust material. Never carries raw values. */
export interface HubAccessStatus {
  /** The app's managed key, when one exists — prefix + metadata only. */
  appKey: { prefix: string; scopes: string[]; lastUsedAt: string | null; createdAt: string } | null;
  /** Whether a per-app forward-auth secret is provisioned (in-app identity verification active). */
  identityVerification: boolean;
  /** Whether this app would be (re-)provisioned trust material on its next env generation. */
  provisioned: boolean;
  /**
   * The app's request for the Hub's MCP tools, which reach the apps beside it, and a person's answer.
   * `null` when its manifest does not ask (`hub_integration.mcp_client`).
   */
  mcp: {
    /** `null`: nobody has answered yet, so the app holds no MCP key. */
    access: McpAccessChoice | null;
    /** The level its MCP key works at now, which Settings → Security can change; `null` without one. */
    keyCapability: string | null;
  } | null;
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
    private readonly appsRepository: AppsRepository,
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
    const [info, managed, appEnv, mcpAccess] = await Promise.all([
      this.requireApp(appUrn),
      this.apiKeys.findManagedByApp(appUrn),
      this.appFilesManager.getAppEnv(appUrn),
      this.appsRepository.getAppMcpAccess(appUrn),
    ]);
    const envMap = this.envUtils.envStringToMap(appEnv.content);
    return {
      appKey: managed ? { prefix: managed.prefix, scopes: managed.scopes, lastUsedAt: managed.lastUsedAt, createdAt: managed.createdAt } : null,
      identityVerification: [FORWARD_AUTH_SECRET_ENV, FORWARD_AUTH_IDENTITY_SECRET_ENV].some((key) => (envMap.get(key) ?? '').trim().length > 0),
      // The gates generateEnvFile provisions from, never a restatement of them. Companion Memory gets its own identity
      // secret from the second one and holds neither key scope.
      provisioned: hubTrustMaterialScopes(info, mcpAccess).length > 0 || isMemoryProviderApp(info),
      mcp: info.hub_integration?.mcp_client
        ? {
            access: isMcpAccessChoice(mcpAccess) ? mcpAccess : null,
            keyCapability: managed?.scopes.includes('mcp') ? managed.capability : null,
          }
        : null,
    };
  }

  /**
   * Record a person's answer to the app's request for the Hub's MCP tools, and apply it.
   *
   * The caller has checked that the person may give it (`HubManagerGuard`, and an organization owner
   * or admin for `full`). Refusing deletes the app's MCP key now, so it stops working before the app
   * restarts. A granted level also becomes the level of a key the app already holds. A running app is
   * restarted, which is when its env gains or loses `HUB_MCP_API_KEY`; a stopped one gets it at its
   * next start, so this does not start it.
   */
  async setMcpAccess(appUrn: AppUrn, access: McpAccessChoice): Promise<{ restarting: boolean }> {
    const info = await this.requireApp(appUrn);
    if (!info.hub_integration?.mcp_client) {
      throw new BadRequestException(`${appUrn} does not ask for the Hub's MCP tools`);
    }

    return this.appLifecycle.withAppHeld(appUrn, async (app) => {
      await this.appsRepository.setAppMcpAccess(appUrn, access);
      const managed = await this.apiKeys.findManagedByApp(appUrn);
      if (!mcpAccessGranted(access)) {
        // The `app` scope of an official Memory or OIDC consumer is no part of this answer, so only a key
        // holding nothing else goes now; the restart takes `mcp` off one that holds both.
        if (managed?.scopes.every((scope) => scope === 'mcp')) {
          await this.apiKeys.revokeManagedByApp(appUrn);
        }
      } else if (managed?.scopes.includes('mcp') && managed.capability !== access) {
        await this.apiKeys.setCapability(managed.id, access);
      }
      this.logger.info('MCP access set', appUrn, access);

      const status = await this.appsRepository.getAppStatusByUrn(appUrn);
      if (status?.status !== 'running') {
        return { restarting: false };
      }
      await app.restart({ reason: 'hub-access-mcp' });
      return { restarting: true };
    });
  }

  /**
   * Rotate the app's Hub trust material: revoke the managed key row and clear the per-app
   * forward-auth secret from app.env, then restart the app — the restart regenerates the env,
   * where provisioning mints a fresh key (the old raw no longer resolves) and a fresh secret
   * (preserve-or-mint finds nothing to preserve). One lifecycle event flips the container and
   * the Hub's signing source together, so nothing is left verifying against a dead value.
   *
   * The app is held before anything is revoked, and a rotate sent while another operation holds it
   * is refused with that operation's 409, the old credentials untouched. Revoking first and then
   * waiting for the app left it on revoked credentials for as long as that operation lasted, and a
   * second click revoked again.
   */
  async rotate(appUrn: AppUrn): Promise<{ requestId: string }> {
    await this.requireApp(appUrn);

    return this.appLifecycle.withAppHeld(appUrn, async (app) => {
      await this.apiKeys.revokeManagedByApp(appUrn);

      const appEnv = await this.appFilesManager.getAppEnv(appUrn);
      const envMap = this.envUtils.envStringToMap(appEnv.content);
      // Both forward-auth keys: Companion Memory's own one is the identity secret.
      const cleared = [FORWARD_AUTH_SECRET_ENV, FORWARD_AUTH_IDENTITY_SECRET_ENV].filter((key) => envMap.delete(key));
      if (cleared.length > 0) {
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
        const dispatched = await app.restart({ reason: 'hub-access-rotate' });
        this.logger.info('Hub access material rotated', appUrn);
        return dispatched;
      } catch (error) {
        this.logger.error(
          `[HubAccessService] rotated Hub access for ${appUrn} but the restart could not be dispatched — the app is running with revoked credentials until it is restarted manually`,
          error,
        );
        throw error;
      }
    });
  }
}

function isMcpAccessChoice(value: string | null): value is McpAccessChoice {
  return value === 'none' || mcpAccessGranted(value);
}
