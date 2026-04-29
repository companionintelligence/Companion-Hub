import { Injectable } from '@nestjs/common';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';

@Injectable()
export class MarketplaceTools {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly appStoreService: AppStoreService,
  ) {}

  async searchApps(params: { search?: string; category?: string; storeId?: string; pageSize?: number; cursor?: string }) {
    return this.marketplaceService.searchApps({
      search: params.search,
      category: params.category,
      storeId: params.storeId,
      pageSize: params.pageSize ?? 24,
      cursor: params.cursor,
    });
  }

  async listAppStores() {
    const appStores = await this.appStoreService.getAllAppStores();
    return { appStores };
  }

  async listEnabledStores() {
    const appStores = await this.appStoreService.getEnabledAppStores();
    return { appStores };
  }

  async addAppStore(params: { name: string; url: string }) {
    return this.appStoreService.createAppStore({ name: params.name, url: params.url });
  }

  async updateAppStore(params: { storeId: string; name: string; enabled: boolean }) {
    await this.appStoreService.updateAppStore(params.storeId, { name: params.name, enabled: params.enabled });
    return { success: true };
  }

  async deleteAppStore(params: { storeId: string }) {
    return this.appStoreService.deleteAppStore(params.storeId);
  }

  async pullAppStores() {
    return this.appStoreService.pullRepositories();
  }
}
