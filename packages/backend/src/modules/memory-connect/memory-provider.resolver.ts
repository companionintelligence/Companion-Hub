import { Injectable } from '@nestjs/common';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsService } from '@/modules/apps/apps.service';

/** Well-known id of the Companion Memory app (CI-Server). */
const CI_MEMORY_APP_ID = 'ci-memory';
/** Fallbacks when ci-memory's manifest omits an explicit provider descriptor. */
const DEFAULT_PROVIDER_SERVICE = 'gateway';
const DEFAULT_PROVIDER_PORT = 8642;

/** Where the Hub can reach an installed Companion Memory, both internally and for the browser. */
export interface ResolvedMemoryProvider {
  /** URN of the installed ci-memory app. */
  appUrn: AppUrn;
  /** Internal address on the shared docker network (server-to-server exchange). */
  internalUrl: string;
  /** Browser-reachable public URL (base of the consent flow), when resolvable. */
  publicUrl?: string;
}

/** The env-var names a consumer app reads its memory URL + token from. */
export interface MemoryConsumerEnv {
  urlEnv: string;
  tokenEnv: string;
}

/**
 * Resolves the installed Companion Memory provider and classifies memory
 * consumer apps, from the `hub_integration.memory` manifest declarations.
 *
 * This is the one piece the earlier plan under-specified: the Hub has no
 * generic "internal address of installed app X" helper, so ci-memory's manifest
 * carries `provider: { service, port }` and we build the shared-network URL from
 * it (falling back to the historical `gateway:8642`).
 */
@Injectable()
export class MemoryProviderResolver {
  constructor(
    private readonly appsService: AppsService,
    private readonly logger: LoggerService,
  ) {}

  /** Whether an app is a memory consumer (declares both url + token env names). */
  isConsumer(info: AppInfo): boolean {
    return this.consumerEnv(info) !== null;
  }

  /**
   * The browser-reachable public URL of an installed app, or undefined when it
   * can't be resolved (not running / no public route). Used to allowlist the
   * post-connect redirect destination.
   */
  async getAppPublicUrl(appUrn: AppUrn): Promise<string | undefined> {
    try {
      return (await this.appsService.checkAppAvailability(appUrn)).appUrl;
    } catch (err) {
      this.logger.warn(`[MemoryConnect] could not resolve public URL for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);

      return undefined;
    }
  }

  /**
   * The display name of an installed app (for the consent page's friendly
   * label), or undefined when it can't be resolved.
   */
  async getAppName(appUrn: AppUrn): Promise<string | undefined> {
    try {
      const { info } = await this.appsService.getApp(appUrn);

      return info.name;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the installed app at `appUrn` is a memory consumer. Resolves the
   * app's info; returns false if the app can't be found.
   */
  async isConsumerApp(appUrn: AppUrn): Promise<boolean> {
    try {
      const { info } = await this.appsService.getApp(appUrn);

      return this.isConsumer(info);
    } catch {
      return false;
    }
  }

  /** The consumer env-var mapping for an app, or null if it is not a consumer. */
  consumerEnv(info: AppInfo): MemoryConsumerEnv | null {
    const mem = info.hub_integration?.memory;

    if (mem?.url_env && mem?.token_env) {
      return { urlEnv: mem.url_env, tokenEnv: mem.token_env };
    }

    return null;
  }

  /**
   * Find the installed Companion Memory provider, or null when ci-memory is not
   * installed (in which case connecting is not offered).
   */
  async findProvider(): Promise<ResolvedMemoryProvider | null> {
    const installed = await this.appsService.getInstalledApps();

    const provider = installed.find(({ info }) => info.id === CI_MEMORY_APP_ID || !!info.hub_integration?.memory?.provider);

    if (!provider) {
      return null;
    }

    const descriptor = provider.info.hub_integration?.memory?.provider;
    const service = descriptor?.service ?? DEFAULT_PROVIDER_SERVICE;
    const port = descriptor?.port ?? provider.info.port ?? DEFAULT_PROVIDER_PORT;
    const appUrn = provider.info.urn as AppUrn;

    // Public URL is best-effort — the browser leg needs it, but the internal
    // exchange does not, so a provider is still "found" without it.
    let publicUrl: string | undefined;
    try {
      const availability = await this.appsService.checkAppAvailability(appUrn);
      publicUrl = availability.appUrl;
    } catch (err) {
      this.logger.warn(`[MemoryConnect] could not resolve ci-memory public URL: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { appUrn, internalUrl: `http://${service}:${port}`, publicUrl };
  }
}
