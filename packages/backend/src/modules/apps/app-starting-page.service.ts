import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { isPortExposeApp } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { parseDbTimestampMs } from '@/common/helpers/db-timestamp';
import { buildHubPublicOrigin, resolveHubPublicDomainRoot } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ForwardAuthSecretResolver } from '@/modules/auth/forward-auth-secret.resolver';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { AppFilesManager } from './app-files-manager';
import { type AppStartingPage, classifyApp } from './app-starting-page';
import { AppsRepository } from './apps.repository';

/** How long an app's name and kind, and the Hub's own address, are reused between pages. */
const CACHE_TTL_MS = 60_000;
/** A bound on the name cache, far above any Hub's app count. */
const MAX_CACHED_APPS = 256;

interface AppFacts {
  name: string;
  /** False for a port-expose app, whose process the person runs themselves. */
  hubStartsIt: boolean;
}

/** The app's page in the Hub's frontend. Custom apps (`_user`) live one level up. */
function hubAppPath(appUrn: AppUrn): string {
  const { appName, appStoreId } = extractAppUrn(appUrn);
  return appStoreId === '_user' ? `/apps/${encodeURIComponent(appName)}` : `/apps/${encodeURIComponent(appStoreId)}/${encodeURIComponent(appName)}`;
}

/**
 * Works out what the "app is starting" page says (CI-Hub#1764).
 *
 * Traefik fetches the page for every 502 and 504 an app's route returns, without a Hub sign-in to rely
 * on, so this reads only what the page shows: the app's display name and lifecycle status. One small
 * query per page; the host map, the name and the Hub's address come from caches, and nothing here
 * calls Docker.
 */
@Injectable()
export class AppStartingPageService {
  /**
   * When this Hub process started. After a reboot Docker starts every app at the same time as the
   * Hub, and nothing records those starts in the app table, so this stands in for them.
   */
  private readonly hubStartedAtMs = Date.now();
  private readonly appFactsCache = new Map<AppUrn, { value: AppFacts; expiresAt: number }>();
  private hubOriginCache: { value: string | null; expiresAt: number } | null = null;

  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly config: ConfigurationService,
    private readonly moduleRef: ModuleRef,
    private readonly logger: LoggerService,
  ) {}

  /**
   * The page for a request Traefik made on a visitor's behalf. `host` is that request's `Host`,
   * which Traefik passes through from the visitor: the hostname the app's router matched. Never
   * `X-Forwarded-Host`, which an app's own public-host middleware rewrites.
   */
  async describe(host: string | string[] | undefined): Promise<AppStartingPage> {
    const nowMs = Date.now();
    // Only the button needs it: a registration lookup that fails costs the link, not the page.
    const hubOrigin = await this.hubOrigin(nowMs).catch(() => null);
    try {
      const appUrn = await this.resolveAppUrn(host);
      const row = appUrn ? await this.appsRepository.getAppStatusByUrn(appUrn) : null;
      if (!appUrn || !row) {
        return { state: 'unknown', hubUrl: hubOrigin };
      }

      const facts = await this.appFacts(appUrn, nowMs);
      const state = classifyApp({
        status: row.status,
        changedAtMs: parseDbTimestampMs(row.updatedAt),
        hubStartedAtMs: this.hubStartedAtMs,
        nowMs,
        hubStartsIt: facts.hubStartsIt,
      });

      return { state, appName: facts.name, hubUrl: hubOrigin ? `${hubOrigin}${hubAppPath(appUrn)}` : null };
    } catch (error) {
      // A page that failed would show the visitor the Hub's own 500 instead. Debug only: during an
      // outage this runs for every failing request.
      this.logger.debug(`App starting page fell back to the generic text: ${error instanceof Error ? error.message : String(error)}`);
      return { state: 'unknown', hubUrl: hubOrigin };
    }
  }

  /**
   * The same host-to-app map forward auth signs with: platform, tunnel-origin (also the LAN name),
   * and custom-domain hostnames. Through `ModuleRef` because AuthModule imports AppsModule.
   */
  private async resolveAppUrn(host: string | string[] | undefined): Promise<AppUrn | null> {
    const resolver = this.moduleRef.get(ForwardAuthSecretResolver, { strict: false });
    return resolver.resolveAppUrnForHost(host);
  }

  private async appFacts(appUrn: AppUrn, nowMs: number): Promise<AppFacts> {
    const cached = this.appFactsCache.get(appUrn);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value;
    }

    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    const value: AppFacts = {
      name: info?.name?.trim() || extractAppUrn(appUrn).appName,
      hubStartsIt: !isPortExposeApp(info),
    };
    if (this.appFactsCache.size >= MAX_CACHED_APPS) {
      this.appFactsCache.clear();
    }
    this.appFactsCache.set(appUrn, { value, expiresAt: nowMs + CACHE_TTL_MS });
    return value;
  }

  /** The Hub's public origin, which works from the LAN and through the tunnel alike. */
  private async hubOrigin(nowMs: number): Promise<string | null> {
    if (this.hubOriginCache && this.hubOriginCache.expiresAt > nowMs) {
      return this.hubOriginCache.value;
    }

    const org = await this.deviceRegistration.getFirstDeviceRegistration();
    const value = buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain: resolveHubPublicDomainRoot(this.config.getConfig()) });
    this.hubOriginCache = { value, expiresAt: nowMs + CACHE_TTL_MS };
    return value;
  }
}
