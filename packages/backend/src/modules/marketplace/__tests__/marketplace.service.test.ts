import { Test, TestingModule } from '@nestjs/testing';
import { MarketplaceService } from '../marketplace.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '../../app-stores/app-store.service';
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
  let spies: any;

  beforeEach(async () => {
    configService = mock<ConfigurationService>();
    filesystemService = mock<FilesystemService>();
    loggerService = mock<LoggerService>();
    appStoreService = mock<AppStoreService>();

    configService.getConfig.mockReturnValue({
      architecture: 'amd64', // Default arch
    } as any);

    spies = {
      getAvailableAppUrns: vi.fn(),
      getAppInfoFromAppStore: vi.fn(),
      getAppImage: vi.fn(),
      getAppUpdateInfo: vi.fn(),
      copyAppFromRepoToInstalled: vi.fn(),
      copyDataDir: vi.fn(),
      getDockerComposeJson: vi.fn(),
      getConfigJson: vi.fn(),
    };

    spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);

    // biome-ignore lint/complexity/useArrowFunction: Constructor mock needs a function
    (AppStoreFilesManager as any).mockImplementation(function (_c: any, _f: any, _l: any, config: any) {
      return {
        storeConfig: config,
        getAvailableAppUrns: config.slug === 'store-1' ? spies.getAvailableAppUrns : vi.fn().mockResolvedValue([]),
        getAppInfoFromAppStore: spies.getAppInfoFromAppStore,
        getAppImage: spies.getAppImage,
        getAppUpdateInfo: spies.getAppUpdateInfo,
        copyAppFromRepoToInstalled: spies.copyAppFromRepoToInstalled,
        copyDataDir: spies.copyDataDir,
        getDockerComposeJson: spies.getDockerComposeJson,
        getConfigJson: spies.getConfigJson,
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
      ],
    }).compile();

    service = module.get<MarketplaceService>(MarketplaceService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize stores', async () => {
      await service.initialize();
      expect(appStoreService.getAllAppStores).toHaveBeenCalled();
      expect(AppStoreFilesManager).toHaveBeenCalled();
      expect(appStoreService.pullRepositories).toHaveBeenCalled();
    });
  });

  describe('getAvailableApps', () => {
    it('should return available apps filtered by architecture', async () => {
      await service.initialize();

      spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);
      spies.getAppInfoFromAppStore.mockResolvedValue({
        urn: 'app-1:store-1' as any,
        supported_architectures: ['amd64'],
        name: 'App 1',
        categories: [],
      });

      const result = await service.getAvailableApps();

      expect(result).toHaveLength(1);
      expect(result[0]?.urn).toBe('app-1:store-1' as any);
      expect(spies.getAppInfoFromAppStore).toHaveBeenCalledWith('app-1:store-1' as any);
    });

    it('should filter out incompatible architectures', async () => {
      await service.initialize();

      spies.getAvailableAppUrns.mockResolvedValue(['app-arm:store-1']);
      spies.getAppInfoFromAppStore.mockResolvedValue({
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
    it('should return search results', async () => {
      await service.initialize();

      spies.getAvailableAppUrns.mockResolvedValue(['app-1:store-1' as any]);
      spies.getAppInfoFromAppStore.mockResolvedValue({
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

  describe('getAppImage', () => {
    it('should return app image', async () => {
      await service.initialize();

      spies.getAppImage.mockResolvedValue({ image: 'buffer', etag: 'etag', contentType: 'image/jpeg' });

      const result = await service.getAppImage('app-1:store-1' as any);

      expect(result).toEqual({ image: 'buffer', etag: 'etag', contentType: 'image/jpeg' });
    });
  });
});
