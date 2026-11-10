import { BadRequestException, Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { CustomAppService } from '@/modules/custom-apps/custom-apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { CreateCustomAppDto, UpdateCustomAppDto } from '@/modules/custom-apps/dto/custom-apps.dto';
import { assertMcpCallerMay, mcpCallerLifecycleActor } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

/**
 * Runs a tool's arguments through the schema the `/api/custom-apps` route uses, so an agent is refused
 * what the form refuses (CI-Hub#2372). The refusal lists each issue as `<path>: <message>`, the message
 * being the key the form translates, e.g. `config.services.0.capAdd.0: CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED`.
 */
function parseOrRefuse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);
    throw new BadRequestException(`Invalid custom app config. ${issues.join('; ')}`);
  }
  return parsed.data;
}

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

  /** Creating one takes an organization owner or admin behind the call, as the HTTP route does. */
  async createCustomApp(params: { name: string; config: Record<string, unknown> }) {
    await this.appLifecycleService.assertActorMayCreateCustomApp(mcpCallerLifecycleActor('install'));
    const dto = parseOrRefuse(CreateCustomAppDto.schema, { name: params.name, config: params.config });
    return this.customAppService.createCustomApp(dto);
  }

  /*
   * A change to an existing app asks the lifecycle's actor gate for `configure` first
   * (`assertMcpCallerMay`). `CustomAppService` takes no actor: its `/api/custom-apps` routes assert the
   * session's grant in the controller, and creating an app asserts none (CI-Hub#1397).
   */
  async updateCustomApp(params: { appUrn: string; config: Record<string, unknown> }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    const { config } = parseOrRefuse(UpdateCustomAppDto.schema, { config: params.config });
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
