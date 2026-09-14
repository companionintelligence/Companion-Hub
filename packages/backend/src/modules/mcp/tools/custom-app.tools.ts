import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import type { CreateCustomAppDto, UpdateCustomAppDto } from '@/modules/custom-apps/dto/custom-apps.dto';
import { assertMcpCallerMay } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

@Injectable()
export class CustomAppTools implements OnModuleInit {
  constructor(
    private readonly customAppService: CustomAppService,
    private readonly registry: McpToolRegistry,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'Custom Apps',
      name: 'hub_create_custom_app',
      access: 'write',
      description: 'Create a custom app from a dynamic docker-compose config. Returns the new app URN.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Display name (1-50 chars). A URL-safe identifier is derived from it.' },
          config: { type: 'object', description: 'Docker compose service config' },
        },
        required: ['name', 'config'],
      },
      handler: (p) => this.createCustomApp(p as { name: string; config: Record<string, unknown> }),
    });
    this.registry.register({
      category: 'Custom Apps',
      name: 'hub_update_custom_app',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: rewrites the app's raw docker-compose (can change/remove volume mounts).
      description: 'Update a custom app docker-compose configuration.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, config: { type: 'object', description: 'New compose config' } },
        required: ['appUrn', 'config'],
      },
      handler: (p) => this.updateCustomApp(p as { appUrn: string; config: Record<string, unknown> }),
    });
    this.registry.register({
      category: 'Custom Apps',
      name: 'hub_update_app_metadata',
      access: 'write',
      description: 'Update an app frontmatter metadata string.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, data: { type: 'string', description: 'Metadata string' } },
        required: ['appUrn', 'data'],
      },
      handler: (p) => this.updateAppMetadata(p as { appUrn: string; data: string }),
    });
  }

  async createCustomApp(params: { name: string; config: Record<string, unknown> }) {
    const dto = { name: params.name, config: params.config } as CreateCustomAppDto;
    return this.customAppService.createCustomApp(dto);
  }

  /*
   * A change to an existing app asks the lifecycle's actor gate for `configure` first
   * (`assertMcpCallerMay`). `CustomAppService` serves `/api/custom-apps` routes that assert no grant of
   * their own, so a required actor there would change what those routes allow (CI-Hub#1397).
   */
  async updateCustomApp(params: { appUrn: string; config: Record<string, unknown> }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    const config = params.config as UpdateCustomAppDto['config'];
    await this.customAppService.updateCustomApp(appUrn, config);
    return { success: true };
  }
  async updateAppMetadata(params: { appUrn: string; data: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    await this.customAppService.updateAppMetadata(appUrn, params.data);
    return { success: true };
  }
}
