import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { MarketplaceTools } from '../../tools/marketplace.tools';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';

describe('MarketplaceTools', () => {
  let tools: MarketplaceTools;
  let marketplaceService: MockProxy<MarketplaceService>;
  let appStoreService: MockProxy<AppStoreService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceTools,
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: AppStoreService, useValue: mock<AppStoreService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
      ],
    }).compile();
    tools = module.get<MarketplaceTools>(MarketplaceTools);
    marketplaceService = module.get(MarketplaceService);
    appStoreService = module.get(AppStoreService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_search_apps', () => {
    it('should return paginated search results', async () => {
      marketplaceService.searchApps.mockResolvedValue({ data: [], total: 0, nextCursor: null } as any);
      const result = await tools.searchApps({});
      expect(marketplaceService.searchApps).toHaveBeenCalled();
      expect(result).toEqual({ data: [], total: 0, nextCursor: null });
    });
    it('should default pageSize to 24', async () => {
      marketplaceService.searchApps.mockResolvedValue({ data: [], total: 0, nextCursor: null } as any);
      await tools.searchApps({});
      expect(marketplaceService.searchApps).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 24 }));
    });
    it('should support text search filter', async () => {
      marketplaceService.searchApps.mockResolvedValue({ data: [], total: 0, nextCursor: null } as any);
      await tools.searchApps({ search: 'nextcloud' });
      expect(marketplaceService.searchApps).toHaveBeenCalledWith(expect.objectContaining({ search: 'nextcloud' }));
    });
  });

  describe('hub_list_app_stores', () => {
    it('should return all app stores', async () => {
      appStoreService.getAllAppStores.mockResolvedValue([{ slug: 'ci', name: 'CI Store', url: 'https://example.com', enabled: true }] as any);
      const result = await tools.listAppStores();
      expect(result.appStores).toHaveLength(1);
    });
  });

  describe('hub_list_enabled_stores', () => {
    it('should only return enabled app stores', async () => {
      appStoreService.getEnabledAppStores.mockResolvedValue([{ slug: 'ci', enabled: true }] as any);
      const result = await tools.listEnabledStores();
      expect(result.appStores).toHaveLength(1);
    });
  });

  describe('hub_add_app_store', () => {
    it('should create a new app store', async () => {
      appStoreService.createAppStore.mockResolvedValue({ slug: 'new', name: 'New', url: 'https://new.com' } as any);
      const result = await tools.addAppStore({ name: 'New', url: 'https://new.com' });
      expect(appStoreService.createAppStore).toHaveBeenCalledWith({ name: 'New', url: 'https://new.com' });
      expect(result).toBeDefined();
    });
  });

  describe('hub_update_app_store', () => {
    it('should update store and return success', async () => {
      appStoreService.updateAppStore.mockResolvedValue({} as any);
      const result = await tools.updateAppStore({ storeId: 'ci', name: 'Updated', enabled: false });
      expect(result).toEqual({ success: true });
    });
  });

  describe('hub_delete_app_store', () => {
    it('should delete the app store', async () => {
      appStoreService.deleteAppStore.mockResolvedValue({ success: true });
      const _result = await tools.deleteAppStore({ storeId: 'ci' });
      expect(appStoreService.deleteAppStore).toHaveBeenCalledWith('ci');
    });
  });

  describe('hub_pull_app_stores', () => {
    it('should pull latest definitions and return success', async () => {
      appStoreService.pullRepositories.mockResolvedValue({ success: true });
      const result = await tools.pullAppStores();
      expect(result).toEqual({ success: true });
    });
  });
});
