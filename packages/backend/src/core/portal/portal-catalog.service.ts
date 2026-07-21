import type { Architecture } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { appInfoSchema, APP_CATEGORIES, type AppInfo } from '@ci-hub/common/schemas';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { CI_MARKETPLACE_STORE_SLUG } from './portal.constants';
import { PortalClientService } from './portal-client.service';

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
  tipi_version?: number;
  exposable?: boolean;
  dynamic_config?: boolean;
  form_fields?: unknown[];
  force_pull?: boolean;
  url_suffix?: string;
  hub_integration?: unknown;
};

export type PortalCatalogEntry = {
  id: string;
  urn: AppUrn;
  name: string;
  short_desc: string;
  icon?: string | null;
  categories: string[];
  deprecated: boolean;
  supported_architectures?: string[];
  available: boolean;
};

@Injectable()
export class PortalCatalogService {
  private cache: PortalCatalogEntry[] | null = null;
  private cacheUpdatedAt = 0;
  private readonly cacheTtlMs = 1000 * 60 * 15;

  constructor(
    private readonly portalClient: PortalClientService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  invalidateCache() {
    this.cache = null;
    this.cacheUpdatedAt = 0;
  }

  private mapPortalApp(app: PortalCatalogApp): PortalCatalogEntry | null {
    const slug = app.slug ?? app.id;
    if (!slug) return null;
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
      icon: app.icon ?? null,
      categories: categories.size > 0 ? [...categories] : ['utilities'],
      deprecated: Boolean(app.deprecated),
      supported_architectures: app.supported_architectures,
      available: app.available !== false,
    };
  }

  private filterForArchitecture(apps: PortalCatalogEntry[]): PortalCatalogEntry[] {
    const { architecture } = this.configuration.getConfig();
    return apps.filter((app) => {
      if (app.deprecated || !app.available) return false;
      if (!app.supported_architectures?.length) return true;
      return app.supported_architectures.includes(architecture as Architecture);
    });
  }

  async getCatalogEntries(force = false): Promise<PortalCatalogEntry[]> {
    if (!force && this.cache && Date.now() - this.cacheUpdatedAt < this.cacheTtlMs) {
      return this.cache;
    }

    try {
      const raw = await this.portalClient.fetchStoreCatalog();
      const list = Array.isArray(raw) ? raw : [];
      const mapped = list.map((item) => this.mapPortalApp(item as PortalCatalogApp)).filter((entry): entry is PortalCatalogEntry => entry !== null);
      this.cache = this.filterForArchitecture(mapped);
      this.cacheUpdatedAt = Date.now();
      return this.cache;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Portal catalog fetch failed: ${message}`);
      return this.cache ?? [];
    }
  }

  async searchCatalog(params: { search?: string | null; category?: string | null; pageSize?: number; cursor?: string | null; storeId?: string }) {
    const { search, category, pageSize, cursor, storeId } = params;

    if (storeId && storeId !== CI_MARKETPLACE_STORE_SLUG) {
      return null;
    }

    let filtered = await this.getCatalogEntries();

    if (category) {
      filtered = filtered.filter((app) => app.categories.includes(category));
    }

    if (search?.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (app) =>
          app.name.toLowerCase().includes(q) || app.short_desc.toLowerCase().includes(q) || app.categories.some((c) => c.toLowerCase().includes(q)),
      );
    }

    filtered = filtered.sort((a, b) => a.urn.localeCompare(b.urn));

    const start = cursor
      ? Math.max(
          0,
          filtered.findIndex((app) => app.urn === cursor),
        )
      : 0;
    const end = start + (pageSize ?? 24);
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
    const parsed = appInfoSchema.safeParse({
      id: slug,
      urn: appUrn,
      name,
      author: typeof app.author === 'string' ? app.author : 'CI',
      available: app.available !== false,
      deprecated: Boolean(app.deprecated),
      short_desc,
      description: markdownDescription?.trim() || '',
      categories: categories.length > 0 ? categories : ['utilities'],
      port: typeof app.port === 'number' ? app.port : 8080,
      version: typeof app.version === 'string' ? app.version : 'latest',
      cihub_app_version:
        typeof app.cihub_app_version === 'number' ? app.cihub_app_version : typeof app.tipi_version === 'number' ? app.tipi_version : 1,
      source: typeof app.source === 'string' ? app.source : 'https://companionintelligence.com',
      website: typeof app.website === 'string' ? app.website : undefined,
      supported_architectures: app.supported_architectures?.length ? app.supported_architectures : ['amd64', 'arm64'],
      runtime_platform: typeof app.runtime_platform === 'string' ? app.runtime_platform : undefined,
      exposable: app.exposable !== false,
      dynamic_config: app.dynamic_config !== false,
      form_fields: Array.isArray(app.form_fields) ? app.form_fields : undefined,
      force_pull: app.force_pull === true ? true : undefined,
      url_suffix: typeof app.url_suffix === 'string' ? app.url_suffix : undefined,
      hub_integration: app.hub_integration,
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
}
