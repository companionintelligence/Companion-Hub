import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';

@Injectable()
export class MarketplaceTools implements OnModuleInit {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly appStoreService: AppStoreService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_search_apps',
      description: 'Search the app marketplace by keyword, category, or store. Returns paginated results.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search keyword' },
          category: { type: 'string', description: 'App category filter (e.g. media, ai, development)' },
          storeId: { type: 'string', description: 'Filter to a specific app store' },
          pageSize: { type: 'number', description: 'Results per page (1-100, default 24)' },
          cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        },
        required: [],
      },
      handler: (p) => this.searchApps(p as { search?: string; category?: string; storeId?: string; pageSize?: number; cursor?: string }),
    });
    this.registry.register({
      name: 'hub_list_app_stores',
      description: 'List all configured app stores.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listAppStores(),
    });
    this.registry.register({
      name: 'hub_list_enabled_stores',
      description: 'List only enabled app stores.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listEnabledStores(),
    });
    this.registry.register({
      name: 'hub_add_app_store',
      description: 'Add a new app store by name and URL.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Store name (1-16 chars)' },
          url: { type: 'string', description: 'Store repository URL' },
        },
        required: ['name', 'url'],
      },
      handler: (p) => this.addAppStore(p as { name: string; url: string }),
    });
    this.registry.register({
      name: 'hub_update_app_store',
      description: 'Update an app store name and enabled state.',
      inputSchema: {
        type: 'object',
        properties: {
          storeId: { type: 'string', description: 'Store ID' },
          name: { type: 'string', description: 'New name' },
          enabled: { type: 'boolean', description: 'Enable/disable' },
        },
        required: ['storeId', 'name', 'enabled'],
      },
      handler: (p) => this.updateAppStore(p as { storeId: string; name: string; enabled: boolean }),
    });
    this.registry.register({
      name: 'hub_delete_app_store',
      description: 'Delete an app store. Installed apps from this store are not removed.',
      inputSchema: { type: 'object', properties: { storeId: { type: 'string', description: 'Store ID to delete' } }, required: ['storeId'] },
      handler: (p) => this.deleteAppStore(p as { storeId: string }),
    });
    this.registry.register({
      name: 'hub_pull_app_stores',
      description: 'Pull latest app definitions from all enabled stores.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.pullAppStores(),
    });
  }

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
    return { appStores: await this.appStoreService.getAllAppStores() };
  }
  async listEnabledStores() {
    return { appStores: await this.appStoreService.getEnabledAppStores() };
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
