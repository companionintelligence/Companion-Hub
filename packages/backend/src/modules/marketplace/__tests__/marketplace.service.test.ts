import { Test, TestingModule } from '@nestjs/testing';
import { MarketplaceService } from '../marketplace.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '../../app-stores/app-store.service';
import { PortalCatalogService } from '@/core/portal/portal-catalog.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { AppStoreFilesManager } from '../../app-stores/app-store-files-manager';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../app-stores/app-store-files-manager');

describe('MarketplaceService', () => {
  let service: MarketplaceService;
  let configService: MockProxy<ConfigurationService>;
  let filesystemService: MockProxy<FilesystemService>;
  let loggerService: MockProxy<LoggerService>;
  let appStoreService: MockProxy<AppStoreService>;
  let portalCatalog: MockProxy<PortalCatalogService>;
  let spies: any;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    loggerService = mock<LoggerService>();
    appStoreService = mock<AppStoreService>();
    portalCatalog = mock<PortalCatalogService>();
    portalCatalog.warmCacheInBackground.mockReturnValue(undefined);

    configService.getConfig.mockReturnValue({
      architecture: 'amd64', // Default arch
    } as any);

    spies = {
      getAvailableAppUrns: vi.fn(),
      getAppInfoFromAppStore: vi.fn(),
      getAppInfoFromAppStoreLite: vi.fn(),
      getAppImage: vi.fn(),
      hasAppLogo: vi.fn(),
      getAppUpdateInfo: vi.fn(),
      copyAppFromRepoToInstalled: vi.fn(),
      copyDataDir: vi.fn(),
      getDockerComposeJson: vi.fn(),
      getConfigJson: vi.fn(),
      readDescriptionMarkdown: vi.fn().mockResolvedValue(null),
    };

    spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);

    // biome-ignore lint/complexity/useArrowFunction: Constructor mock needs a function
    (AppStoreFilesManager as any).mockImplementation(function (_c: any, _f: any, _l: any, config: any) {
      return {
        storeConfig: config,
        getAvailableAppUrns: config.slug === 'store-1' ? spies.getAvailableAppUrns : vi.fn().mockResolvedValue([]),
        getAppInfoFromAppStore: spies.getAppInfoFromAppStore,
        getAppInfoFromAppStoreLite: spies.getAppInfoFromAppStoreLite,
        getAppImage: spies.getAppImage,
        hasAppLogo: spies.hasAppLogo,
        getAppUpdateInfo: spies.getAppUpdateInfo,
        copyAppFromRepoToInstalled: spies.copyAppFromRepoToInstalled,
        copyDataDir: spies.copyDataDir,
        getDockerComposeJson: spies.getDockerComposeJson,
        getConfigJson: spies.getConfigJson,
        readDescriptionMarkdown: spies.readDescriptionMarkdown,
      };
    });

    appStoreService.getAllAppStores.mockResolvedValue([
      { slug: 'store-1', name: 'Store 1', url: 'http://store1.com', enabled: true, type: 'git', branch: 'main' } as any,
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        { provide: ConfigurationService, useValue: configService },
        { provide: FilesystemService, useValue: filesystemService },
        { provide: LoggerService, useValue: loggerService },
        { provide: AppStoreService, useValue: appStoreService },
        { provide: PortalCatalogService, useValue: portalCatalog },
      ],
    }).compile();

    service = module.get<MarketplaceService>(MarketplaceService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize stores without blocking catalog sync', async () => {
      await service.initialize();
      expect(appStoreService.getAllAppStores).toHaveBeenCalled();
      expect(AppStoreFilesManager).toHaveBeenCalled();
      expect(portalCatalog.warmCacheInBackground).toHaveBeenCalled();
      expect(appStoreService.pullRepositories).not.toHaveBeenCalled();
    });
  });

  describe('getAvailableApps', () => {
    it('should return available apps filtered by architecture', async () => {
      await service.initialize();

      spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);
      spies.getAppInfoFromAppStoreLite.mockResolvedValue({
        urn: 'app-1:store-1' as any,
        supported_architectures: ['amd64'],
        name: 'App 1',
        categories: [],
      });

      const result = await service.getAvailableApps();

      expect(result).toHaveLength(1);
      expect(result[0]?.urn).toBe('app-1:store-1' as any);
      expect(spies.getAppInfoFromAppStoreLite).toHaveBeenCalledWith('app-1:store-1' as any);
    });

    it('should filter out incompatible architectures', async () => {
      await service.initialize();

      spies.getAvailableAppUrns.mockResolvedValue(['app-arm:store-1']);
      spies.getAppInfoFromAppStoreLite.mockResolvedValue({
        urn: 'app-arm:store-1',
        supported_architectures: ['arm64'], // Config is amd64
        name: 'App ARM',
        categories: [],
      });

      const result = await service.getAvailableApps();
      expect(result).toHaveLength(0);
    });
  });

  describe('searchApps', () => {
    it('should return portal catalog results when populated', async () => {
      await service.initialize();

      portalCatalog.searchCatalog.mockResolvedValue({
        data: [{ id: 'ghost', urn: 'ghost:ci-marketplace', name: 'Ghost', short_desc: '', categories: [], available: true, deprecated: false }],
        total: 1,
        nextCursor: null,
      });

      const result = await service.searchApps({ pageSize: 50 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe('ghost');
      expect(spies.getAppInfoFromAppStoreLite).not.toHaveBeenCalled();
    });

    it('falls back to local store when portal catalog is empty', async () => {
      await service.initialize();

      portalCatalog.searchCatalog.mockResolvedValue({ data: [], total: 0, nextCursor: null });
      spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);
      spies.getAppInfoFromAppStoreLite.mockResolvedValue({
        id: 'app-1',
        urn: 'app-1:store-1' as any,
        supported_architectures: ['amd64'],
        name: 'Local App',
        categories: ['utilities'],
        available: true,
        deprecated: false,
        short_desc: '',
      });

      const result = await service.searchApps({ pageSize: 50 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.urn).toBe('app-1:store-1');
    });

    it('should return search results from local store when portal is unavailable', async () => {
      await service.initialize();

      portalCatalog.searchCatalog.mockResolvedValue(null);

      spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);
      spies.getAppInfoFromAppStoreLite.mockResolvedValue({
        urn: 'app-1:store-1' as any,
        supported_architectures: ['amd64'],
        name: 'Search Me',
        categories: ['utility'],
      });

      const result = await service.searchApps({ search: 'Search' });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getAppInfoFromAppStore', () => {
    it('falls back to portal catalog when local ci-marketplace metadata is missing', async () => {
      await service.initialize();

      appStoreService.getAllAppStores.mockResolvedValue([
        { slug: 'ci-marketplace', name: 'CI Marketplace', url: 'http://portal', enabled: true, type: 'ci_cloud_api', branch: 'main' } as any,
      ]);
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(true);
      portalCatalog.getAppInfoForUrn.mockResolvedValue({
        id: 'ghost',
        urn: 'ghost:ci-marketplace',
        name: 'Ghost',
        author: 'Ghost Foundation',
        available: true,
        short_desc: 'Blog',
        description: 'Blog',
        source: 'https://ghost.org',
        categories: ['social'],
      } as any);
      spies.getAppInfoFromAppStore.mockResolvedValue(undefined);
      portalCatalog.fetchDescriptionMarkdown.mockResolvedValue('# Ghost\n\nLong markdown description.');

      const result = await service.getAppInfoFromAppStore('ghost:ci-marketplace' as any);

      expect(portalCatalog.getAppInfoForUrn).toHaveBeenCalledWith('ghost:ci-marketplace');
      expect(portalCatalog.fetchDescriptionMarkdown).toHaveBeenCalledWith('ghost');
      expect(result).toMatchObject({
        name: 'Ghost',
        description: '# Ghost\n\nLong markdown description.',
      });
    });

    it('prefers local description.md over portal catalog config description', async () => {
      await service.initialize();

      appStoreService.getAllAppStores.mockResolvedValue([
        { slug: 'ci-marketplace', name: 'CI Marketplace', url: 'http://portal', enabled: true, type: 'ci_cloud_api', branch: 'main' } as any,
      ]);
      await service.initialize();

      spies.getAppInfoFromAppStore.mockResolvedValue({
        id: 'ghost',
        urn: 'ghost:ci-marketplace',
        name: 'Ghost',
        description: 'Config fallback',
        short_desc: 'Blog',
        categories: ['social'],
      });
      spies.readDescriptionMarkdown.mockResolvedValue('# From description.md');

      const result = await service.getAppInfoFromAppStore('ghost:ci-marketplace' as any);

      expect(portalCatalog.getAppInfoForUrn).not.toHaveBeenCalled();
      expect(result?.description).toBe('# From description.md');
    });
  });

  describe('getAppImage', () => {
    it('should return app image', async () => {
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(false);
      spies.getAppImage.mockResolvedValue({ image: 'buffer', etag: 'etag', contentType: 'image/jpeg' });

      const result = await service.getAppImage('app-1:store-1' as any);

      expect(result).toEqual({ image: 'buffer', etag: 'etag', contentType: 'image/jpeg' });
    });

    it('fetches portal icon when a ci-marketplace app has no local logo', async () => {
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(true);
      portalCatalog.fetchIconImage.mockResolvedValue({
        image: Buffer.from('png'),
        etag: '"portal-icon"',
        contentType: 'image/png',
      });

      const result = await service.getAppImage('ghost:ci-marketplace' as any);

      expect(portalCatalog.fetchIconImage).toHaveBeenCalledWith('ghost:ci-marketplace');
      expect(result.contentType).toBe('image/png');
      expect(spies.getAppImage).not.toHaveBeenCalled();
    });

    it('prefers a synced local logo over the portal icon for ci-marketplace apps', async () => {
      await service.initialize();

      appStoreService.getAllAppStores.mockResolvedValue([
        { slug: 'ci-marketplace', name: 'CI Marketplace', url: 'http://portal', enabled: true, type: 'ci_cloud_api', branch: 'main' } as any,
      ]);
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(true);
      spies.hasAppLogo.mockResolvedValue(true);
      spies.getAppImage.mockResolvedValue({ image: 'local-buffer', etag: 'local', contentType: 'image/png' });

      const result = await service.getAppImage('ghost:ci-marketplace' as any);

      expect(spies.hasAppLogo).toHaveBeenCalledWith('ghost:ci-marketplace');
      expect(portalCatalog.fetchIconImage).not.toHaveBeenCalled();
      expect(result).toEqual({ image: 'local-buffer', etag: 'local', contentType: 'image/png' });
    });
  });

  describe('getAppUpdateInfo', () => {
    it('prefers portal catalog version when newer than local repo config', async () => {
      appStoreService.getAllAppStores.mockResolvedValue([
        { slug: 'ci-marketplace', name: 'CI Marketplace', url: 'http://portal', enabled: true, type: 'ci_cloud_api', branch: 'main' } as any,
      ]);
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(true);
      spies.getAppUpdateInfo.mockResolvedValue({
        latestVersion: 10,
        latestDockerVersion: '2026.7.17',
        minHubVersion: null,
        appRepoDir: '/repo',
      });
      portalCatalog.getUpdateInfoForUrn.mockReturnValue({
        latestVersion: 42,
        latestDockerVersion: '2026.7.17.1',
        minHubVersion: null,
      });

      await expect(service.getAppUpdateInfo('ci-memory:ci-marketplace' as any)).resolves.toMatchObject({
        latestVersion: 42,
        latestDockerVersion: '2026.7.17.1',
      });
    });

    it('keeps local repo version when portal catalog is not newer', async () => {
      appStoreService.getAllAppStores.mockResolvedValue([
        { slug: 'ci-marketplace', name: 'CI Marketplace', url: 'http://portal', enabled: true, type: 'ci_cloud_api', branch: 'main' } as any,
      ]);
      await service.initialize();

      portalCatalog.isCiMarketplaceUrn.mockReturnValue(true);
      spies.getAppUpdateInfo.mockResolvedValue({
        latestVersion: 42,
        latestDockerVersion: '2026.7.17.1',
        minHubVersion: null,
      });
      portalCatalog.getUpdateInfoForUrn.mockReturnValue({
        latestVersion: 10,
        latestDockerVersion: '2026.7.17',
        minHubVersion: null,
      });

      await expect(service.getAppUpdateInfo('ci-memory:ci-marketplace' as any)).resolves.toMatchObject({
        latestVersion: 42,
        latestDockerVersion: '2026.7.17.1',
      });
    });
  });
});
