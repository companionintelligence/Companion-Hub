import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { AppsService } from '@/modules/apps/apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { ToolRegistry } from './tool-registry';

@Injectable()
export class AppTools implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly marketplaceService: MarketplaceService,
    private readonly appsService: AppsService,
  ) {}

  onModuleInit() {
    this.toolRegistry.register({
      name: 'search_apps',
      description: 'Search the app catalogue by name, category, or description. Returns matching apps with their details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (name, description, or use case)' },
          category: { type: 'string', description: 'Filter by category (optional)' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const result = await this.marketplaceService.searchApps({
          search: args.query as string,
          category: (args.category as string) || null,
          pageSize: 10,
          cursor: null,
          storeId: '',
        });
        const apps = result.data.map((a) => ({
          urn: a.urn,
          name: a.name,
          description: a.short_desc,
          categories: a.categories,
        }));
        return JSON.stringify({ apps, total: result.total });
      },
    });

    this.toolRegistry.register({
      name: 'list_installed_apps',
      description: 'List all currently installed apps with their status.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const apps = await this.appsService.getInstalledApps();
        const summary = apps
          .filter((a) => a !== null)
          .map((a) => ({
            name: a.info?.name || a.app.appName,
            urn: `${a.app.appName}:${a.app.appStoreSlug}`,
            status: a.app.status,
          }));
        return JSON.stringify({ apps: summary, count: summary.length });
      },
    });

    this.toolRegistry.register({
      name: 'get_app_status',
      description: 'Get detailed status of a specific app by its URN (e.g. "libreoffice:latest").',
      parameters: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'The app URN (e.g. "immich:latest")' },
        },
        required: ['appUrn'],
      },
      execute: async (args) => {
        try {
          const result = await this.appsService.getApp(castAppUrn(args.appUrn as string));
          return JSON.stringify({
            name: result.info?.name || result.app?.appName,
            urn: args.appUrn,
            status: result.app?.status,
            version: result.app?.version,
            description: result.info?.short_desc,
          });
        } catch {
          return JSON.stringify({ error: `App ${args.appUrn} not found` });
        }
      },
    });
  }
}
