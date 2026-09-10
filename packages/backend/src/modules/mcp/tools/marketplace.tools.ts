import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { CATALOG_PAGE_SIZE } from '@/modules/marketplace/catalog-page-size';
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
      category: 'Marketplace',
      name: 'hub_search_apps',
      access: 'read',
      description: 'Search the app marketplace by keyword, category, or store. Returns paginated results.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search keyword' },
          category: { type: 'string', description: 'App category filter (e.g. media, ai, development)' },
          storeId: { type: 'string', description: 'Filter to a specific app store' },
          pageSize: { type: 'number', description: 'Results per page (1-100, default 16)' },
          cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        },
        required: [],
      },
      handler: (p) => this.searchApps(p as { search?: string; category?: string; storeId?: string; pageSize?: number; cursor?: string }),
    });
    this.registry.register({
      category: 'Marketplace',
      name: 'hub_list_app_stores',
      access: 'read',
      description: 'List all configured app stores.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listAppStores(),
    });
    this.registry.register({
      category: 'Marketplace',
      name: 'hub_list_enabled_stores',
      access: 'read',
      description: 'List only enabled app stores.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listEnabledStores(),
    });
    this.registry.register({
      category: 'Marketplace',
      name: 'hub_add_app_store',
      access: 'write',
      // R2-HUBHOSTESCAPE-5: makes a caller-chosen git repo an install source for the whole appliance,
      // whose compose files can ask for privileged/capAdd/host paths — a strictly larger grant than
      // hub_delete_app_store below, which was already gated. Pairs with hub_install_app to reach root.
      destructive: true,
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
      category: 'Marketplace',
      name: 'hub_update_app_store',
      access: 'write',
      destructive: true, // R2-HUBHOSTESCAPE-5: re-enabling a disabled store re-arms it as an install source.
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
      category: 'Marketplace',
      name: 'hub_delete_app_store',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: deletes a configured app store.
      description: 'Delete an app store. Installed apps from this store are not removed.',
      inputSchema: { type: 'object', properties: { storeId: { type: 'string', description: 'Store ID to delete' } }, required: ['storeId'] },
      handler: (p) => this.deleteAppStore(p as { storeId: string }),
    });
    this.registry.register({
      category: 'Marketplace',
      name: 'hub_pull_app_stores',
      access: 'write',
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
      pageSize: params.pageSize ?? CATALOG_PAGE_SIZE,
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
