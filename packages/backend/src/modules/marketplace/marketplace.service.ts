import { extractAppUrn } from '@/common/helpers/app-helpers';
import { notEmpty, pLimit } from '@/common/helpers/file-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, Inject, forwardRef } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppInfo } from '@ci-hub/common/schemas';
import MiniSearch from 'minisearch';
import { PortalCatalogService } from '@/core/portal/portal-catalog.service';
import { CI_MARKETPLACE_STORE_SLUG } from '@/core/portal/portal.constants';
import { AppStoreFilesManager } from '../app-stores/app-store-files-manager';
import { AppStoreService, RESERVED_APP_STORE_SLUGS } from '../app-stores/app-store.service';
import {
  extractScreenshotFilename,
  isSafeMediaFilename,
  marketplaceDemoVideoPath,
  marketplaceScreenshotPath,
  portalScreenshotPath,
} from './app-media.helpers';

type AppList = Awaited<ReturnType<InstanceType<typeof MarketplaceService>['getAllAppFromStores']>>;

const sortApps = (a: AppList[number], b: AppList[number]) => a.urn.localeCompare(b.urn);
/** Keep incompatible-arch apps visible in the store; install UI/backend gates them. */
const filterApp = (app: AppList[number]): boolean => !app.deprecated;

@Injectable()
export class MarketplaceService {
  private stores: Map<string, AppStoreFilesManager> = new Map();
  private appsAvailable: AppList | null = null;
  private miniSearch: MiniSearch<AppList[number]> | null = null;
  private cacheTimeout = 1000 * 60 * 15; // 15 minutes
  private cacheLastUpdated = 0;

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
    private readonly portalCatalog: PortalCatalogService,
    @Inject(forwardRef(() => AppStoreService)) private readonly appStoreService: AppStoreService,
  ) {}

  async initialize() {
    this.stores.clear();

    const stores = await this.appStoreService.getAllAppStores();

    for (const config of stores) {
      const store = new AppStoreFilesManager(this.configuration, this.filesystem, this.logger, config);
      this.stores.set(config.slug, store);
    }

    // TODO: This is a temporary fix to ensure that internal app stores are always present.
    for (const reservedSlug of RESERVED_APP_STORE_SLUGS) {
      if (!this.stores.has(reservedSlug)) {
        const store = new AppStoreFilesManager(this.configuration, this.filesystem, this.logger, {
          branch: 'main',
          createdAt: '',
          enabled: false,
          hash: reservedSlug,
          name: reservedSlug,
          slug: reservedSlug,
          url: 'https://example.com',
          updatedAt: '',
          type: 'git',
        });
        this.stores.set(reservedSlug, store);
      }
    }

    this.invalidateCache();
    void this.portalCatalog.warmCacheInBackground();

    this.logger.debug('Marketplace service initialized with stores', Array.from(this.stores.keys()).join(', '));
  }

  private getStoreFromUrn(appUrn: AppUrn) {
    const { appStoreId } = extractAppUrn(appUrn);

    const store = this.stores.get(appStoreId);
    if (!store) {
      this.logger.warn(`Store ${appStoreId} not found. Available stores: ${Array.from(this.stores.keys()).join(', ')}`);
      return { store: null };
    }

    return { store };
  }

  public async getAppInfoFromAppStore(appUrn: AppUrn): Promise<AppInfo | null> {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    const local = await store.getAppInfoFromAppStore(appUrn);
    const info = local ?? (await this.portalCatalog.getAppInfoForUrn(appUrn));
    if (!info) return null;
    return this.enrichAppInfoDescription(appUrn, info, store);
  }

  async getAppInfoFromAppStoreOrInstalled(appUrn: AppUrn): Promise<AppInfo | undefined> {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    const local = await store.getAppInfoFromAppStoreOrInstalled(appUrn);
    const info = local ?? (await this.portalCatalog.getAppInfoForUrn(appUrn));
    if (!info) return undefined;
    return this.enrichAppInfoDescription(appUrn, info, store);
  }

  async getPortalIconUrl(appUrn: AppUrn): Promise<string | null> {
    if (!this.portalCatalog.isCiMarketplaceUrn(appUrn)) return null;
    return this.portalCatalog.getIconUrlForUrn(appUrn);
  }

  async resolveAppDescription(appUrn: AppUrn, info: AppInfo): Promise<AppInfo> {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) return info;
    return this.enrichAppInfoDescription(appUrn, info, store);
  }

  private async enrichAppInfoDescription(appUrn: AppUrn, info: AppInfo, store: AppStoreFilesManager): Promise<AppInfo> {
    const localMarkdown = await store.readDescriptionMarkdown(appUrn);
    const { appName } = extractAppUrn(appUrn);
    const portalMarkdown =
      localMarkdown || !this.portalCatalog.isCiMarketplaceUrn(appUrn) ? null : await this.portalCatalog.fetchDescriptionMarkdown(appName);
    const description = localMarkdown?.trim() || portalMarkdown?.trim() || '';
    return { ...info, description };
  }

  async getAvailableAppUrns(): Promise<AppUrn[]> {
    const allUrns: AppUrn[] = [];
    for (const store of this.stores.values()) {
      if (store.storeConfig.enabled) {
        const urns = await store.getAvailableAppUrns();
        allUrns.push(...urns);
      }
    }
    return allUrns.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get all available apps from the catalog
   * @returns All available apps
   */
  private async getAllAppFromStores() {
    const appUrns = await this.getAvailableAppUrns();

    const limit = pLimit(10);
    const apps = await Promise.all(
      appUrns.map(async (appUrn) => {
        return limit(async () => {
          const { store } = this.getStoreFromUrn(appUrn);
          if (!store) return null;
          return store.getAppInfoFromAppStoreLite(appUrn);
        });
      }),
    );

    return apps.filter(notEmpty);
  }

  /**
   * Filter deprecated apps out of the catalog. Architecture mismatches stay listed
   * so users can browse them; install is blocked separately.
   */
  private filterApps(apps: AppList): AppList {
    return apps.sort(sortApps).filter(filterApp);
  }

  /**
   * Invalidate the cache
   */
  public invalidateCache() {
    this.appsAvailable = null;
    if (this.miniSearch) {
      this.miniSearch.removeAll();
    }
    this.portalCatalog.invalidateCache();
  }

  /**
   * Get all available apps from all stores
   * @returns All available apps
   */
  public async getAvailableApps(): Promise<AppList> {
    if (this.cacheLastUpdated && Date.now() - this.cacheLastUpdated > this.cacheTimeout) {
      this.invalidateCache();
    }

    if (!this.appsAvailable?.length) {
      const apps = await this.getAllAppFromStores();

      this.appsAvailable = this.filterApps(apps);

      this.miniSearch = new MiniSearch<(typeof this.appsAvailable)[number]>({
        fields: ['name', 'short_desc', 'categories'],
        storeFields: ['urn'],
        idField: 'urn',
        searchOptions: {
          boost: { name: 2 },
          fuzzy: 0.2,
          prefix: true,
        },
      });
      this.miniSearch.addAll(this.appsAvailable);

      this.cacheLastUpdated = Date.now();
    }

    return this.appsAvailable;
  }

  /**
   * Search for apps in the catalog
   * @param params - The search parameters
   * @returns The search results
   */
  public async searchApps(params: { search?: string | null; category?: string | null; pageSize?: number; cursor?: string | null; storeId?: string }) {
    const { storeId } = params;
    const usePortalCatalog = !storeId || storeId === CI_MARKETPLACE_STORE_SLUG;

    if (usePortalCatalog) {
      const portalResult = await this.portalCatalog.searchCatalog(params);
      if (portalResult && portalResult.data.length > 0) {
        return portalResult;
      }
    }

    const { search, category, pageSize, cursor } = params;

    let filteredApps = await this.getAvailableApps();

    if (storeId) {
      filteredApps = filteredApps.filter((app) => {
        const { appStoreId } = extractAppUrn(app.urn);
        return appStoreId === storeId;
      });
    }

    if (category) {
      filteredApps = filteredApps.filter((app) => app.categories.some((c: string) => c === category));
    }

    if (search && this.miniSearch) {
      const result = this.miniSearch.search(search);
      const searchIds = result.map((app) => app.id);
      filteredApps = filteredApps.filter((app) => searchIds.includes(app.urn)).sort((a, b) => searchIds.indexOf(a.urn) - searchIds.indexOf(b.urn));
    }

    const start = cursor ? filteredApps.findIndex((app) => app.urn === cursor) : 0;
    const end = start + (pageSize ?? 24);
    const data = filteredApps.slice(start, end);

    return {
      data,
      total: filteredApps.length,
      nextCursor: filteredApps[end]?.urn ?? null,
    };
  }

  /**
   * Get the image of an app
   * @param appUrn - The ID of the app
   * @returns The image of the app
   */
  public async getAppImage(appUrn: AppUrn) {
    try {
      const { store } = this.getStoreFromUrn(appUrn);
      if (this.portalCatalog.isCiMarketplaceUrn(appUrn)) {
        const hasLocalLogo = store ? await store.hasAppLogo(appUrn) : false;
        if (!hasLocalLogo) {
          const portalImage = await this.portalCatalog.fetchIconImage(appUrn);
          if (portalImage?.image) {
            return portalImage;
          }
        }
      }

      if (!store) return { image: null, etag: '', contentType: 'image/jpeg' };
      return await store.getAppImage(appUrn);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to get image for ${appUrn}: ${message}`);
      return { image: null, etag: '', contentType: 'image/jpeg' };
    }
  }

  public async getAppUpdateInfo(appUrn: AppUrn) {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);

    const localInfo = await store.getAppUpdateInfo(appUrn);

    if (!this.portalCatalog.isCiMarketplaceUrn(appUrn)) {
      return localInfo;
    }

    // Cache-only read (never a blocking network call) — see PortalCatalogService.getUpdateInfoForUrn.
    const portalInfo = this.portalCatalog.getUpdateInfoForUrn(appUrn);
    if (!portalInfo) {
      return localInfo;
    }

    const localVersion = Number(localInfo.latestVersion ?? 0);
    const portalVersion = Number(portalInfo.latestVersion ?? 0);
    if (portalVersion <= localVersion) {
      return localInfo;
    }

    return {
      ...localInfo,
      latestVersion: portalInfo.latestVersion,
      latestDockerVersion: portalInfo.latestDockerVersion,
      minHubVersion: portalInfo.minHubVersion ?? localInfo.minHubVersion,
    };
  }

  public async copyAppFromRepoToInstalled(appUrn: AppUrn) {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    return store.copyAppFromRepoToInstalled(appUrn);
  }

  public async copyDataDir(appUrn: AppUrn, envMap: Map<string, string>) {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    return store.copyDataDir(appUrn, envMap);
  }

  public async getDockerComposeJson(appUrn: AppUrn) {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    return store.getDockerComposeJson(appUrn);
  }

  public async getConfigJson(appUrn: AppUrn) {
    const { store } = this.getStoreFromUrn(appUrn);
    if (!store) throw new Error(`Store not found for ${appUrn}`);
    return store.getConfigJson(appUrn);
  }

  public async getAppMedia(appUrn: AppUrn): Promise<{ screenshots: string[]; demoVideoUrl: string | null }> {
    const info = await this.getAppInfoFromAppStore(appUrn).catch(() => null);
    const { store } = this.getStoreFromUrn(appUrn);
    const { appName } = extractAppUrn(appUrn);
    const publicPortalUrl = this.portalCatalog.isCiMarketplaceUrn(appUrn) ? (this.configuration.getConfig().ciCloudUrl?.trim() ?? '') : '';
    const screenshots: string[] = [];
    const seen = new Set<string>();

    const pushScreenshot = (url: string) => {
      if (!seen.has(url)) {
        seen.add(url);
        screenshots.push(url);
      }
    };

    const resolveScreenshotRef = (ref: string) => {
      const trimmed = ref.trim();
      if (!trimmed) {
        return;
      }

      if (/^https?:\/\//i.test(trimmed)) {
        pushScreenshot(trimmed);
        return;
      }

      const filename = extractScreenshotFilename(trimmed);
      if (filename) {
        pushScreenshot(marketplaceScreenshotPath(appUrn, filename));
        return;
      }

      if (publicPortalUrl && this.portalCatalog.isCiMarketplaceUrn(appUrn)) {
        const portalFilename = trimmed.split('/').pop();
        if (portalFilename && isSafeMediaFilename(portalFilename)) {
          pushScreenshot(portalScreenshotPath(publicPortalUrl, appName, portalFilename));
        }
      }
    };

    for (const ref of info?.screenshots ?? []) {
      resolveScreenshotRef(ref);
    }

    if (store) {
      for (const filename of await store.listLocalScreenshotFilenames(appUrn)) {
        if (isSafeMediaFilename(filename)) {
          pushScreenshot(marketplaceScreenshotPath(appUrn, filename));
        }
      }
    }

    let demoVideoUrl: string | null = null;
    let portalDetails: { screenshots?: string[]; demo_video?: string } | null = null;
    if (this.portalCatalog.isCiMarketplaceUrn(appUrn)) {
      portalDetails = await this.portalCatalog.fetchStoreAppDetails(appName);
    }

    if (screenshots.length === 0 && portalDetails) {
      for (const ref of portalDetails.screenshots ?? []) {
        if (typeof ref === 'string') {
          if (/^https?:\/\//i.test(ref)) {
            pushScreenshot(ref);
          } else {
            const filename = extractScreenshotFilename(ref) ?? ref.split('/').pop();
            if (filename && isSafeMediaFilename(filename) && publicPortalUrl) {
              pushScreenshot(portalScreenshotPath(publicPortalUrl, appName, filename));
            }
          }
        }
      }
    }

    const demoVideoRef = info?.demo_video ?? portalDetails?.demo_video;
    if (typeof demoVideoRef === 'string' && demoVideoRef.trim()) {
      if (/^https?:\/\//i.test(demoVideoRef.trim())) {
        demoVideoUrl = demoVideoRef.trim();
      } else if (store && (await store.findDemoVideoPath(appUrn, demoVideoRef))) {
        demoVideoUrl = marketplaceDemoVideoPath(appUrn);
      }
    }

    return { screenshots, demoVideoUrl };
  }

  public async getAppScreenshot(appUrn: AppUrn, filename: string) {
    if (!isSafeMediaFilename(filename)) {
      return { image: null, etag: '', contentType: 'image/jpeg' };
    }

    try {
      const { store } = this.getStoreFromUrn(appUrn);
      if (store) {
        const local = await store.getScreenshot(appUrn, filename);
        if (local.image) {
          return local;
        }
      }

      if (this.portalCatalog.isCiMarketplaceUrn(appUrn)) {
        const portalImage = await this.portalCatalog.fetchScreenshotImage(appUrn, filename);
        if (portalImage?.image) {
          return portalImage;
        }
      }

      return { image: null, etag: '', contentType: 'image/jpeg' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to get screenshot for ${appUrn}/${filename}: ${message}`);
      return { image: null, etag: '', contentType: 'image/jpeg' };
    }
  }

  public async getAppDemoVideo(appUrn: AppUrn) {
    try {
      const info = await this.getAppInfoFromAppStore(appUrn).catch(() => null);
      const demoVideoRef = info?.demo_video;
      if (!demoVideoRef || /^https?:\/\//i.test(demoVideoRef.trim())) {
        return { video: null, etag: '', contentType: 'video/mp4' };
      }

      const { store } = this.getStoreFromUrn(appUrn);
      if (!store) {
        return { video: null, etag: '', contentType: 'video/mp4' };
      }

      return store.getDemoVideo(appUrn, demoVideoRef);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to get demo video for ${appUrn}: ${message}`);
      return { video: null, etag: '', contentType: 'video/mp4' };
    }
  }
}
