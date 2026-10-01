import { extractAppUrn } from '@/common/helpers/app-helpers';
import { describeNetworkError } from '@/common/helpers/network-error';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { appInfoSchema, APP_CATEGORIES, type AppInfo } from '@ci-hub/common/schemas';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { CI_MARKETPLACE_STORE_SLUG, PORTAL_STORE_LISTING_TIMEOUT_MS } from './portal.constants';
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

const HUB_MANAGED_MARKETPLACE_APP_IDS = new Set(['cloudflared', 'cloudflare-tunnel']);

function isHubManagedMarketplaceApp(slug: string): boolean {
  return HUB_MANAGED_MARKETPLACE_APP_IDS.has(slug.trim().toLowerCase());
}

/**
 * The raw `/store` fields the Hub reads, and so the only ones kept in the cached rows. Portal's
 * listing also carries each free app's whole compose file — about half of a ~7.8 MB catalog — which
 * the Hub never reads from here (an install fetches it per app), so cached rows drop it. Typing this
 * as `Record<keyof PortalCatalogApp, true>` makes the compiler fail when a field is added to
 * `PortalCatalogApp` without being cached.
 */
const CACHED_CATALOG_FIELDS: Record<keyof PortalCatalogApp, true> = {
  id: true,
  slug: true,
  name: true,
  title: true,
  short_desc: true,
  shortDescription: true,
  description: true,
  author: true,
  source: true,
  website: true,
  port: true,
  version: true,
  icon: true,
  runtime_platform: true,
  categories: true,
  tags: true,
  deprecated: true,
  supported_architectures: true,
  available: true,
  cihub_app_version: true,
  cihub_version: true,
  min_hub_version: true,
  exposable: true,
  no_gui: true,
  dynamic_config: true,
  form_fields: true,
  force_pull: true,
  url_suffix: true,
  hub_integration: true,
  mcp: true,
  screenshots: true,
  demo_video: true,
  replaces: true,
};

const CACHED_CATALOG_FIELD_NAMES = Object.keys(CACHED_CATALOG_FIELDS) as (keyof PortalCatalogApp)[];

function cacheableCatalogRow(app: PortalCatalogApp): PortalCatalogApp {
  const row: Record<string, unknown> = {};
  for (const field of CACHED_CATALOG_FIELD_NAMES) {
    const value = app[field];
    if (value !== undefined) row[field] = value;
  }
  return row as PortalCatalogApp;
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

/**
 * One `/store` answer, mapped for the store views and indexed by slug for per-app metadata
 * lookups. `error` is set when the Portal round-trip failed and the answer is whatever was
 * already cached.
 */
type CatalogFetchResult = {
  entries: PortalCatalogEntry[];
  rows: Map<string, PortalCatalogApp>;
  /** True when this answer came from a fetch that bypassed Portal's own cache. */
  bypassedPortalCache: boolean;
  error?: unknown;
};

export type PortalCatalogUpdateInfo = {
  latestVersion: number;
  latestDockerVersion: string;
  minHubVersion: number | null;
};

@Injectable()
export class PortalCatalogService {
  private cache: PortalCatalogEntry[] | null = null;
  /**
   * The raw `/store` rows behind `cache`, indexed by slug. `PortalCatalogEntry` is narrower than a
   * listing row and drops the fields full app metadata needs (author, port, mcp, form_fields,
   * url_suffix, hub_integration, screenshots, …), and it is filtered, so per-app lookups read these
   * rows instead. Published, expired and invalidated together with `cache`.
   */
  private rawCache: Map<string, PortalCatalogApp> | null = null;
  private cacheUpdatedAt = 0;
  private alternativesCache: StoreSearchCatalog | null = null;
  private alternativesCacheUpdatedAt = 0;
  private alternativesInflight: Promise<StoreSearchCatalog> | null = null;
  private readonly cacheTtlMs = 1000 * 60 * 15;
  private inflightFetch: Promise<CatalogFetchResult> | null = null;
  /** True when `inflightFetch` was started with Portal cache-busting. */
  private inflightBypassCache = false;
  /** Bumped on invalidate so a fetch that started against a stale catalog cannot republish. */
  private cacheGeneration = 0;
  /** When the last catalog refresh for a slug the cached rows lacked was started; null when none. */
  private missingSlugRefreshAt: number | null = null;
  /**
   * At most one forced catalog refresh per window for slugs the cached rows lack, however many
   * such lookups arrive: a fan-out over unknown apps must not fetch the whole listing per app.
   */
  private readonly missingSlugRefreshCooldownMs = 1000 * 60;

  constructor(
    private readonly portalClient: PortalClientService,
    private readonly logger: LoggerService,
  ) {}

  invalidateCache() {
    this.cache = null;
    this.rawCache = null;
    this.cacheUpdatedAt = 0;
    this.missingSlugRefreshAt = null;
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
        const message = describeNetworkError(error);
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

  /**
   * Index raw `/store` rows by the slug a marketplace URN names, keeping the fields full app
   * metadata is mapped from. Unfiltered on purpose: unlike the browseable catalog, a per-app lookup
   * still has to answer for a deprecated or unavailable app the Hub already knows about.
   */
  private indexCatalogRows(rows: unknown[]): Map<string, PortalCatalogApp> {
    const index = new Map<string, PortalCatalogApp>();
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const app = row as PortalCatalogApp;
      const slug = app.slug ?? app.id;
      // First listing for a slug wins, as a scan over the rows did.
      if (!slug || index.has(slug)) continue;
      index.set(slug, cacheableCatalogRow(app));
    }
    return index;
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
        void this.fetchCatalog(false);
      }
      return this.cache;
    }

    return (await this.fetchCatalog(force)).entries;
  }

  /**
   * The raw listing rows for per-app metadata, from the same cache, TTL, stale-while-revalidate and
   * in-flight dedupe as `getCatalogEntries`: a single-app lookup must not download the catalog.
   */
  private async getRawCatalogRows(force = false): Promise<CatalogFetchResult> {
    if (!force && this.rawCache) {
      if (Date.now() - this.cacheUpdatedAt >= this.cacheTtlMs && !this.inflightFetch) {
        void this.fetchCatalog(false);
      }
      return { entries: this.cache ?? [], rows: this.rawCache, bypassedPortalCache: false };
    }

    return this.fetchCatalog(force);
  }

  /**
   * One forced refresh for slugs the cached rows lack — an app published since this catalog was
   * cached must still be installable. Bounded two ways so a fan-out over unknown apps cannot fetch
   * the listing per app: a cooldown window, and joining a cache-busting fetch already in flight
   * instead of starting another. `null` when the window has not reopened. The window is only spent
   * when the refresh could not find `appName` either; see below.
   */
  private async refreshRawCatalogForMissingSlug(appName: string): Promise<CatalogFetchResult | null> {
    const now = Date.now();
    if (this.missingSlugRefreshAt !== null && now - this.missingSlugRefreshAt < this.missingSlugRefreshCooldownMs) {
      return this.inflightFetch && this.inflightBypassCache ? this.inflightFetch : null;
    }

    // Claimed before the await so concurrent lookups join this fetch rather than queue another.
    this.missingSlugRefreshAt = now;
    const refreshed = await this.getRawCatalogRows(true);
    // A refresh that made its own slug resolvable proves the catalog moved on, so it must not hold
    // the window shut against the next app published after it — that would fail an install Portal
    // can answer. A slug Portal really does not list still spends the window, which is the fan-out
    // over unknown apps this throttle exists for.
    if (this.missingSlugRefreshAt === now && this.rawCache?.has(appName)) {
      this.missingSlugRefreshAt = null;
    }
    return refreshed;
  }

  private fetchCatalog(force: boolean): Promise<CatalogFetchResult> {
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
        const raw = await this.portalClient.fetchStoreCatalog({ bypassCache: force, timeoutMs: PORTAL_STORE_LISTING_TIMEOUT_MS });
        const rawRows = Array.isArray(raw) ? raw : [];
        const result: CatalogFetchResult = {
          entries: this.mapCatalogRows(rawRows),
          rows: this.indexCatalogRows(rawRows),
          bypassedPortalCache: force,
        };
        if (generation !== this.cacheGeneration) {
          return this.inflightFetch ?? result;
        }
        this.cache = result.entries;
        this.rawCache = result.rows;
        this.cacheUpdatedAt = Date.now();
        return result;
      } catch (error) {
        const message = describeNetworkError(error);
        this.logger.warn(`Portal catalog fetch failed: ${message}`);
        return { entries: this.cache ?? [], rows: this.rawCache ?? new Map(), bypassedPortalCache: false, error };
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
   * `searchCatalog`, without waiting on Portal: alias matches use the alternatives in memory, and a
   * cold or expired alternatives cache refreshes in the background for the next search.
   */
  searchCatalogEntries(entries: PortalCatalogEntry[], params: CatalogSearchParams) {
    if (params.search?.trim()) {
      void this.getAlternativesCatalog();
    }
    return this.searchEntries(entries, params, this.alternativesCache ?? {});
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

    const start = cursor ? this.pageStart(filtered, cursor, Boolean(search?.trim())) : 0;
    const end = start + (pageSize ?? CATALOG_PAGE_SIZE);
    const data = filtered.slice(start, end);

    return {
      data,
      total: filtered.length,
      nextCursor: filtered[end]?.urn ?? null,
    };
  }

  /**
   * Where the page that starts at `cursor` begins. A cursor from the other catalog source (the synced
   * snapshot or Portal's catalog) can name an app this list lacks. Without a search the list is in URN
   * order, so paging resumes where that app would sit instead of starting over and repeating a page.
   */
  private pageStart(entries: PortalCatalogEntry[], cursor: string, searching: boolean): number {
    const index = entries.findIndex((app) => app.urn === cursor);
    if (index >= 0 || searching) {
      return Math.max(0, index);
    }
    const next = entries.findIndex((app) => app.urn.localeCompare(cursor) > 0);
    return next >= 0 ? next : entries.length;
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
      const cached = await this.getRawCatalogRows();
      let app = cached.rows.get(appName);
      let error = cached.error;

      // Not in the catalog in hand: it may have been published since. One cache-busting refresh,
      // bounded by `refreshRawCatalogForMissingSlug`. A Portal that just failed is not asked again.
      if (!app && !error && !cached.bypassedPortalCache) {
        const refreshed = await this.refreshRawCatalogForMissingSlug(appName);
        if (refreshed) {
          app = refreshed.rows.get(appName);
          error = refreshed.error;
        }
      }

      if (!app) {
        if (error) {
          const message = describeNetworkError(error);
          this.logger.warn(`Portal catalog app info fetch failed for ${appUrn}: ${message}`);
        }
        return null;
      }

      const slug = app.slug ?? app.id;
      const markdownDescription = slug ? await this.fetchDescriptionMarkdown(slug) : null;
      return this.mapPortalAppToAppInfo(app, appUrn, markdownDescription);
    } catch (error) {
      const message = describeNetworkError(error);
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
      const message = describeNetworkError(error);
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
      const message = describeNetworkError(error);
      this.logger.warn(`Portal screenshot fetch failed for ${appUrn}/${filename}: ${message}`);
      return null;
    }
  }
}
