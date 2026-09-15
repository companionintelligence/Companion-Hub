import { extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { appInfoSchema, APP_CATEGORIES, type AppInfo } from '@ci-hub/common/schemas';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { CI_MARKETPLACE_STORE_SLUG } from './portal.constants';
import { PortalClientService } from './portal-client.service';
import { CATALOG_PAGE_SIZE } from '@/modules/marketplace/catalog-page-size';
import {
  alternativeSlugsMatchingSearch,
  parseAlternativesCatalog,
  parseReplaces,
  searchAliasTextByAppId,
  textMatchesSearch,
  type StoreSearchCatalog,
} from './store-search';

type PortalCatalogApp = {
  id: string;
  slug?: string;
  name?: string;
  title?: string;
  short_desc?: string;
  shortDescription?: string | null;
  description?: string;
  author?: string;
  source?: string;
  website?: string;
  port?: number;
  version?: string;
  icon?: string | null;
  runtime_platform?: string;
  categories?: string[];
  tags?: string[];
  deprecated?: boolean;
  supported_architectures?: string[];
  available?: boolean;
  cihub_app_version?: number;
  cihub_version?: number;
  min_hub_version?: number | null;
  exposable?: boolean;
  no_gui?: boolean;
  dynamic_config?: boolean;
  form_fields?: unknown[];
  force_pull?: boolean;
  url_suffix?: string;
  hub_integration?: unknown;
  mcp?: unknown;
  screenshots?: string[];
  demo_video?: string;
  replaces?: string[];
};

/**
 * The full `/store` listing is fetched once per cache cycle, deduped, and only a cold catalog
 * waits on it. Portal has taken 16–37s to build it, past the 30s client default, so the fetch
 * failed every time and the catalog never warmed. A longer ceiling lets a slow Portal still land.
 */
export const PORTAL_CATALOG_FETCH_TIMEOUT_MS = 45_000;

const HUB_MANAGED_MARKETPLACE_APP_IDS = new Set(['cloudflared', 'cloudflare-tunnel']);

function isHubManagedMarketplaceApp(slug: string): boolean {
  return HUB_MANAGED_MARKETPLACE_APP_IDS.has(slug.trim().toLowerCase());
}

function appReplacesMatch(app: { replaces: string[] }, query: string): boolean {
  return app.replaces.some((name) => textMatchesSearch(name, query));
}

export type PortalCatalogEntry = {
  id: string;
  urn: AppUrn;
  name: string;
  short_desc: string;
  replaces: string[];
  icon?: string | null;
  categories: string[];
  deprecated: boolean;
  supported_architectures?: string[];
  available: boolean;
  cihub_app_version: number;
  version: string;
  min_hub_version?: number | null;
};

export type CatalogSearchParams = {
  search?: string | null;
  category?: string | null;
  pageSize?: number;
  cursor?: string | null;
  storeId?: string;
};

export type PortalCatalogUpdateInfo = {
  latestVersion: number;
  latestDockerVersion: string;
  minHubVersion: number | null;
};

@Injectable()
export class PortalCatalogService {
  private cache: PortalCatalogEntry[] | null = null;
  private cacheUpdatedAt = 0;
  private alternativesCache: StoreSearchCatalog | null = null;
  private alternativesCacheUpdatedAt = 0;
  private alternativesInflight: Promise<StoreSearchCatalog> | null = null;
  private readonly cacheTtlMs = 1000 * 60 * 15;
  private inflightFetch: Promise<PortalCatalogEntry[]> | null = null;
  /** True when `inflightFetch` was started with Portal cache-busting. */
  private inflightBypassCache = false;
  /** Bumped on invalidate so a fetch that started against a stale catalog cannot republish. */
  private cacheGeneration = 0;

  constructor(
    private readonly portalClient: PortalClientService,
    private readonly logger: LoggerService,
  ) {}

  invalidateCache() {
    this.cache = null;
    this.cacheUpdatedAt = 0;
    this.alternativesCache = null;
    this.alternativesCacheUpdatedAt = 0;
    this.alternativesInflight = null;
    this.cacheGeneration += 1;
    this.inflightFetch = null;
    this.inflightBypassCache = false;
  }

  private async getAlternativesCatalog(): Promise<StoreSearchCatalog> {
    if (this.alternativesCache && Date.now() - this.alternativesCacheUpdatedAt < this.cacheTtlMs) {
      return this.alternativesCache;
    }
    if (this.alternativesInflight) {
      return this.alternativesInflight;
    }

    const fetch = (async () => {
      try {
        const parsed = parseAlternativesCatalog(await this.portalClient.fetchStoreAlternatives());
        this.alternativesCache = parsed;
        this.alternativesCacheUpdatedAt = Date.now();
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Portal alternatives fetch failed: ${message}`);
        return this.alternativesCache ?? {};
      } finally {
        this.alternativesInflight = null;
      }
    })();

    this.alternativesInflight = fetch;
    return fetch;
  }

  async getSearchAliasTextByAppId(): Promise<Map<string, string>> {
    return searchAliasTextByAppId(await this.getAlternativesCatalog());
  }

  private mapPortalApp(app: PortalCatalogApp): PortalCatalogEntry | null {
    const slug = app.slug ?? app.id;
    if (!slug) return null;
    if (isHubManagedMarketplaceApp(slug)) return null;
    const name = app.name ?? app.title ?? slug;
    const short_desc = app.short_desc ?? app.shortDescription ?? app.description ?? '';
    const categories = new Set<string>();
    for (const c of app.categories ?? []) {
      if (typeof c === 'string') categories.add(c);
    }
    for (const t of app.tags ?? []) {
      if (typeof t === 'string') categories.add(t);
    }
    return {
      id: slug,
      urn: `${slug}:${CI_MARKETPLACE_STORE_SLUG}` as AppUrn,
      name,
      short_desc,
      replaces: parseReplaces(app.replaces),
      icon: app.icon ?? null,
      categories: categories.size > 0 ? [...categories] : ['utilities'],
      deprecated: Boolean(app.deprecated),
      supported_architectures: app.supported_architectures,
      available: app.available !== false,
      cihub_app_version:
        typeof app.cihub_app_version === 'number' ? app.cihub_app_version : typeof app.cihub_version === 'number' ? app.cihub_version : 1,
      version: typeof app.version === 'string' ? app.version : '0.0.1',
      min_hub_version: typeof app.min_hub_version === 'number' ? app.min_hub_version : null,
    };
  }

  /** Drop deprecated/unavailable apps only — wrong-arch apps stay browseable. */
  private filterCatalogEntries(apps: PortalCatalogEntry[]): PortalCatalogEntry[] {
    return apps.filter((app) => !app.deprecated && app.available);
  }

  /**
   * Map raw `/store` rows to catalog entries, dropping Hub-managed, deprecated and unavailable
   * listings. The on-disk catalog snapshot is a copy of those same rows, so it is mapped here too
   * rather than through a looser local path.
   */
  mapCatalogRows(rows: unknown[]): PortalCatalogEntry[] {
    const mapped = rows
      .filter((row): row is PortalCatalogApp => row !== null && typeof row === 'object')
      .map((row) => this.mapPortalApp(row))
      .filter((entry): entry is PortalCatalogEntry => entry !== null);
    return this.filterCatalogEntries(mapped);
  }

  /** True when a Portal catalog answer is held in memory — fresh, or kept after a failed refresh. */
  hasCatalog(): boolean {
    return (this.cache?.length ?? 0) > 0;
  }

  async getCatalogEntries(force = false): Promise<PortalCatalogEntry[]> {
    if (!force && this.cache) {
      // Past its TTL, answer with the catalog in hand and refresh behind it: a slow Portal must
      // not hold a store or onboarding request for the length of the listing fetch.
      if (Date.now() - this.cacheUpdatedAt >= this.cacheTtlMs && !this.inflightFetch) {
        void this.fetchCatalogEntries(false);
      }
      return this.cache;
    }

    return this.fetchCatalogEntries(force);
  }

  private fetchCatalogEntries(force: boolean): Promise<PortalCatalogEntry[]> {
    // Dedupe concurrent callers into a single Portal round-trip so hot paths
    // (e.g. per-app fan-outs) never trigger a thundering herd of fetches.
    // Force refresh may join an inflight fetch that is already cache-busting.
    if (this.inflightFetch && (!force || this.inflightBypassCache)) {
      return this.inflightFetch;
    }

    // A force fetch must not let a non-bypassing inflight republish stale catalog.
    if (force && this.inflightFetch && !this.inflightBypassCache) {
      this.cacheGeneration += 1;
    }

    const generation = this.cacheGeneration;
    const fetch = (async () => {
      try {
        const raw = await this.portalClient.fetchStoreCatalog({ bypassCache: force, timeoutMs: PORTAL_CATALOG_FETCH_TIMEOUT_MS });
        const filtered = this.mapCatalogRows(Array.isArray(raw) ? raw : []);
        if (generation !== this.cacheGeneration) {
          return this.inflightFetch ?? filtered;
        }
        this.cache = filtered;
        this.cacheUpdatedAt = Date.now();
        return this.cache;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Portal catalog fetch failed: ${message}`);
        return this.cache ?? [];
      } finally {
        if (generation === this.cacheGeneration) {
          this.inflightFetch = null;
          this.inflightBypassCache = false;
        }
      }
    })();

    this.inflightFetch = fetch;
    this.inflightBypassCache = force;
    return fetch;
  }

  async searchCatalog(params: CatalogSearchParams) {
    if (params.storeId && params.storeId !== CI_MARKETPLACE_STORE_SLUG) {
      return null;
    }

    const entries = await this.getCatalogEntries();
    const alternatives = params.search?.trim() ? await this.getAlternativesCatalog() : {};
    return this.searchEntries(entries, params, alternatives);
  }

  /**
   * Search a catalog already in hand (the on-disk snapshot) with the same matching and paging as
   * `searchCatalog`, without waiting on Portal: alias matches use the cached alternatives, and a
   * cold alternatives cache is warmed in the background for the next search.
   */
  searchCatalogEntries(entries: PortalCatalogEntry[], params: CatalogSearchParams) {
    let alternatives: StoreSearchCatalog = {};
    if (params.search?.trim()) {
      if (this.alternativesCache) {
        alternatives = this.alternativesCache;
      } else {
        void this.getAlternativesCatalog();
      }
    }
    return this.searchEntries(entries, params, alternatives);
  }

  private searchEntries(entries: PortalCatalogEntry[], params: CatalogSearchParams, alternatives: StoreSearchCatalog) {
    const { search, category, pageSize, cursor } = params;
    let filtered = [...entries];

    if (category) {
      filtered = filtered.filter((app) => app.categories.includes(category));
    }

    if (search?.trim()) {
      const q = search.trim();
      const aliasSlugs = new Set(alternativeSlugsMatchingSearch(alternatives, q));
      filtered = filtered.filter((app) => {
        const replacesHit = app.replaces.some((name) => textMatchesSearch(name, q));
        if (replacesHit || aliasSlugs.has(app.id)) return true;
        if (textMatchesSearch(app.id, q) || textMatchesSearch(app.name, q) || textMatchesSearch(app.short_desc, q)) {
          return true;
        }
        return app.categories.some((category) => textMatchesSearch(category, q));
      });
      filtered = filtered.sort((a, b) => {
        const aReplaces = appReplacesMatch(a, q) || aliasSlugs.has(a.id);
        const bReplaces = appReplacesMatch(b, q) || aliasSlugs.has(b.id);
        if (aReplaces !== bReplaces) return aReplaces ? -1 : 1;
        return a.urn.localeCompare(b.urn);
      });
    } else {
      filtered = filtered.sort((a, b) => a.urn.localeCompare(b.urn));
    }

    const start = cursor
      ? Math.max(
          0,
          filtered.findIndex((app) => app.urn === cursor),
        )
      : 0;
    const end = start + (pageSize ?? CATALOG_PAGE_SIZE);
    const data = filtered.slice(start, end);

    return {
      data,
      total: filtered.length,
      nextCursor: filtered[end]?.urn ?? null,
    };
  }

  async warmCacheInBackground(): Promise<void> {
    void this.getCatalogEntries(true).catch((error) => {
      this.logger.debug(`Background portal catalog warm failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  isCiMarketplaceUrn(appUrn: AppUrn): boolean {
    const { appStoreId } = extractAppUrn(appUrn);
    return appStoreId === CI_MARKETPLACE_STORE_SLUG;
  }

  /**
   * Resolve latest published version metadata from the Portal catalog cache.
   *
   * Non-blocking by design: this runs on hot paths (installed-apps list and
   * dashboard fan out to it per app), so it only reads already-cached catalog
   * data and triggers a background refresh when the cache is stale. Callers
   * fall back to local store metadata when the cache is cold.
   */
  getUpdateInfoForUrn(appUrn: AppUrn): PortalCatalogUpdateInfo | null {
    if (!this.isCiMarketplaceUrn(appUrn)) return null;

    if (!this.cache || Date.now() - this.cacheUpdatedAt >= this.cacheTtlMs) {
      void this.warmCacheInBackground();
    }

    const { appName } = extractAppUrn(appUrn);
    const app = this.cache?.find((entry) => entry.id === appName);
    if (!app) return null;

    return {
      latestVersion: app.cihub_app_version,
      latestDockerVersion: app.version,
      minHubVersion: app.min_hub_version ?? null,
    };
  }

  private mapPortalCategories(app: PortalCatalogApp): string[] {
    const categories = new Set<string>();
    for (const c of app.categories ?? []) {
      if (typeof c === 'string') categories.add(c);
    }
    for (const t of app.tags ?? []) {
      if (typeof t === 'string') categories.add(t);
    }
    return categories.size > 0 ? [...categories] : ['utilities'];
  }

  async fetchDescriptionMarkdown(appSlug: string): Promise<string | null> {
    return this.portalClient.fetchStoreMetadataText(appSlug, 'description.md');
  }

  private mapPortalAppToAppInfo(app: PortalCatalogApp, appUrn: AppUrn, markdownDescription?: string | null): AppInfo | null {
    const slug = app.slug ?? app.id;
    if (!slug) return null;

    const name = app.name ?? app.title ?? slug;
    const short_desc = app.short_desc ?? app.shortDescription ?? '';
    const categories = this.mapPortalCategories(app).filter((category): category is (typeof APP_CATEGORIES)[number] =>
      (APP_CATEGORIES as readonly string[]).includes(category),
    );
    const isMcpListing = Boolean(app.mcp) || app.no_gui === true;
    const parsed = appInfoSchema.safeParse({
      id: slug,
      urn: appUrn,
      name,
      author: typeof app.author === 'string' ? app.author : 'Companion Intelligence',
      available: app.available !== false,
      deprecated: Boolean(app.deprecated),
      short_desc,
      replaces: parseReplaces(app.replaces),
      description: markdownDescription?.trim() || '',
      categories: categories.length > 0 ? categories : ['utilities'],
      // MCP / no_gui listings are not HTTP apps — omit the fake default port.
      port: typeof app.port === 'number' ? app.port : isMcpListing ? undefined : 8080,
      version: typeof app.version === 'string' ? app.version : 'latest',
      cihub_app_version:
        typeof app.cihub_app_version === 'number' ? app.cihub_app_version : typeof app.cihub_version === 'number' ? app.cihub_version : 1,
      source: typeof app.source === 'string' ? app.source : 'https://companionintelligence.com',
      website: typeof app.website === 'string' ? app.website : undefined,
      supported_architectures: app.supported_architectures?.length ? app.supported_architectures : ['amd64', 'arm64'],
      runtime_platform: typeof app.runtime_platform === 'string' ? app.runtime_platform : undefined,
      // Prefer explicit catalog flags; default MCP listings to non-exposable.
      exposable: typeof app.exposable === 'boolean' ? app.exposable : !isMcpListing,
      no_gui: app.no_gui === true || isMcpListing ? true : undefined,
      mcp: app.mcp,
      dynamic_config: app.dynamic_config !== false,
      form_fields: Array.isArray(app.form_fields) ? app.form_fields : undefined,
      force_pull: app.force_pull === true ? true : undefined,
      url_suffix: typeof app.url_suffix === 'string' ? app.url_suffix : undefined,
      hub_integration: app.hub_integration,
      screenshots: Array.isArray(app.screenshots)
        ? app.screenshots.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : undefined,
      demo_video: typeof app.demo_video === 'string' && app.demo_video.length > 0 ? app.demo_video : undefined,
    });

    if (!parsed.success) {
      this.logger.warn(`Portal catalog app info invalid for ${appUrn}: ${parsed.error.message}`);
      return null;
    }

    return parsed.data;
  }

  /** Resolve full app metadata from the portal catalog when local store files are absent. */
  async getAppInfoForUrn(appUrn: AppUrn): Promise<AppInfo | null> {
    if (!this.isCiMarketplaceUrn(appUrn)) return null;

    const { appName } = extractAppUrn(appUrn);
    if (isHubManagedMarketplaceApp(appName)) return null;

    try {
      const raw = await this.portalClient.fetchStoreCatalog();
      const list = Array.isArray(raw) ? raw : [];
      const app = list.find((item) => {
        const portalApp = item as PortalCatalogApp;
        return (portalApp.slug ?? portalApp.id) === appName;
      }) as PortalCatalogApp | undefined;

      if (!app) return null;

      const slug = app.slug ?? app.id;
      const markdownDescription = slug ? await this.fetchDescriptionMarkdown(slug) : null;
      return this.mapPortalAppToAppInfo(app, appUrn, markdownDescription);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Portal catalog app info fetch failed for ${appUrn}: ${message}`);
      return null;
    }
  }

  async getIconUrlForUrn(appUrn: AppUrn): Promise<string | null> {
    if (!this.isCiMarketplaceUrn(appUrn)) return null;
    const { appName } = extractAppUrn(appUrn);
    const entries = await this.getCatalogEntries();
    const icon = entries.find((entry) => entry.id === appName)?.icon?.trim();
    return icon || null;
  }

  async fetchIconImage(appUrn: AppUrn): Promise<{ image: Buffer; etag: string; contentType: string } | null> {
    const iconUrl = await this.getIconUrlForUrn(appUrn);
    if (!iconUrl) return null;

    try {
      const response = await axios.get<ArrayBuffer>(iconUrl, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        validateStatus: (status) => status >= 200 && status < 300,
      });
      const image = Buffer.from(response.data);
      if (image.length === 0) return null;

      const contentType = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : 'image/png';
      const etag = `"portal-icon-${createHash('sha1').update(iconUrl).digest('hex')}"`;
      return { image, etag, contentType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Portal icon fetch failed for ${appUrn}: ${message}`);
      return null;
    }
  }

  async fetchStoreAppDetails(appSlug: string): Promise<{ screenshots?: string[]; demo_video?: string } | null> {
    if (!this.isCiMarketplaceUrn(`${appSlug}:ci-marketplace` as AppUrn)) {
      return null;
    }

    return this.portalClient.fetchStoreAppDetails(appSlug);
  }

  async fetchScreenshotImage(appUrn: AppUrn, filename: string): Promise<{ image: Buffer; etag: string; contentType: string } | null> {
    if (!this.isCiMarketplaceUrn(appUrn)) return null;

    const { appName } = extractAppUrn(appUrn);
    const publicPortalUrl = this.portalClient.getPublicPortalUrl();
    if (!publicPortalUrl) return null;

    const screenshotUrl = `${publicPortalUrl.replace(/\/+$/, '')}/api/store/${encodeURIComponent(appName)}/screenshots/${encodeURIComponent(filename)}`;

    try {
      const response = await axios.get<ArrayBuffer>(screenshotUrl, {
        responseType: 'arraybuffer',
        timeout: 15_000,
        validateStatus: (status) => status >= 200 && status < 300,
      });
      const image = Buffer.from(response.data);
      if (image.length === 0) return null;

      const contentType = typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : 'image/png';
      const etag = `"portal-screenshot-${createHash('sha1').update(screenshotUrl).digest('hex')}"`;
      return { image, etag, contentType };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Portal screenshot fetch failed for ${appUrn}/${filename}: ${message}`);
      return null;
    }
  }
}
