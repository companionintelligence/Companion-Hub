import { Test, TestingModule } from '@nestjs/testing';
import { AppStoreService } from '../app-store.service';
import { LoggerService } from '@/core/logger/logger.service';
import { RepoEventsQueue } from '@/modules/queue/entities/repo-events';
import { AppStoreRepository } from '../app-store.repository';
import { ReposHelpers } from '../repos.helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { mock, MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('AppStoreService', () => {
  let service: AppStoreService;
  let logger: MockProxy<LoggerService>;
  let repoQueue: MockProxy<RepoEventsQueue>;
  let repoHelpers: MockProxy<ReposHelpers>;
  let configService: MockProxy<ConfigurationService>;
  let appStoreRepository: MockProxy<AppStoreRepository>;
  let marketplaceService: MockProxy<MarketplaceService>;
  let portalClient: MockProxy<PortalClientService>;
  let capturedQueueCallback: any;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    repoQueue = mock<RepoEventsQueue>();
    repoHelpers = mock<ReposHelpers>();
    configService = mock<ConfigurationService>();
    appStoreRepository = mock<AppStoreRepository>();
    marketplaceService = mock<MarketplaceService>();
    portalClient = mock<PortalClientService>();
    portalClient.fetchStoreListings.mockResolvedValue([{ id: 'app1', title: 'App One' }]);

    repoQueue.onEvent.mockImplementation((cb) => {
      capturedQueueCallback = cb;
      return vi.fn() as any;
    });

    configService.getConfig.mockReturnValue({ ciCloudUrl: 'cloud-url' } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppStoreService,
        { provide: LoggerService, useValue: logger },
        { provide: RepoEventsQueue, useValue: repoQueue },
        { provide: ReposHelpers, useValue: repoHelpers },
        { provide: ConfigurationService, useValue: configService },
        { provide: AppStoreRepository, useValue: appStoreRepository },
        { provide: MarketplaceService, useValue: marketplaceService },
        { provide: PortalClientService, useValue: portalClient },
      ],
    }).compile();

    service = module.get<AppStoreService>(AppStoreService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should pull repositories including ci_cloud_api stores', async () => {
    appStoreRepository.getEnabledAppStores.mockResolvedValue([
      { id: 1, name: 'Main', url: 'http://test', slug: 'main', enabled: true, type: 'git' } as any,
      { id: 2, name: 'CI Marketplace', url: 'http://portal/api', slug: 'ci-marketplace', enabled: true, type: 'ci_cloud_api' } as any,
    ]);
    await service.pullRepositories();
    expect(repoHelpers.pullRepo).toHaveBeenCalledWith('http://test', 'main', 'git');
    expect(repoHelpers.pullRepo).toHaveBeenCalledWith('http://portal/api', 'ci-marketplace', 'ci_cloud_api');
    expect(marketplaceService.invalidateCache).toHaveBeenCalled();
  });

  it('should register cloud app store if configured', async () => {
    appStoreRepository.getAppStoreBySlug.mockResolvedValue(null as any);
    appStoreRepository.getAllAppStores.mockResolvedValue([] as any); // Mock getAllAppStores
    await service.registerCloudAppStore();
    expect(appStoreRepository.createAppStore).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'ci-marketplace',
        url: 'cloud-url/api',
      }),
    );
  });

  it('rejects a user store whose name slugifies to the reserved ci-marketplace slug', async () => {
    // Provenance guard: a git store named "CI Marketplace" slugifies to
    // 'ci-marketplace' and would id-squat the official store (→ memory-provider
    // trust + forward-auth secret). createAppStore must reject it on the derived
    // slug, before any repo write.
    await expect(service.createAppStore({ url: 'http://evil.example/repo.git', name: 'CI Marketplace' })).rejects.toThrow(
      'SERVER_ERROR_APP_STORE_NAME_RESERVED',
    );
    expect(appStoreRepository.createAppStore).not.toHaveBeenCalled();
  });

  it('should prevent deleting last app store', async () => {
    appStoreRepository.getAllAppStores.mockResolvedValue([{ slug: 'only-one' } as any]);
    await expect(service.deleteAppStore('only-one')).rejects.toThrow('APP_STORE_DELETE_ERROR_LAST_STORE');
  });

  it('should handle update_all queue event for all enabled stores', async () => {
    const reply = vi.fn();
    appStoreRepository.getEnabledAppStores.mockResolvedValue([
      { id: 1, url: 'http://test', slug: 'main', enabled: true, type: 'git' } as any,
      { id: 2, url: 'http://portal/api', slug: 'ci-marketplace', enabled: true, type: 'ci_cloud_api' } as any,
    ]);
    repoHelpers.pullRepo.mockResolvedValue({ success: true, message: '' });

    await capturedQueueCallback({ command: 'update_all' }, reply);

    expect(repoHelpers.pullRepo).toHaveBeenCalledWith('http://test', 'main', 'git');
    expect(repoHelpers.pullRepo).toHaveBeenCalledWith('http://portal/api', 'ci-marketplace', 'ci_cloud_api');
    expect(marketplaceService.invalidateCache).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success: true, message: 'All repos updated' });
  });

  it('should proxy store listings from CI Cloud', async () => {
    const mockApps = [{ id: 'app1', title: 'App One' }];
    portalClient.fetchStoreListings.mockResolvedValue(mockApps);

    const result = await service.fetchCiCloudStoreListings({ tags: 'featured' });

    expect(portalClient.fetchStoreListings).toHaveBeenCalledWith({ tags: 'featured' });
    expect(result).toEqual(mockApps);
  });
});
