import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { assertMcpCallerMay } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in appName:storeSlug format' } as const;

@Injectable()
export class AppConfigTools implements OnModuleInit {
  constructor(
    private readonly userConfigService: UserConfigService,
    private readonly appsService: AppsService,
    private readonly registry: McpToolRegistry,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_get_user_config',
      access: 'read',
      description: 'Get user-level docker-compose and env overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.getUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_update_user_config',
      access: 'write',
      destructive: true, // ISSUE-MCP-2: rewrites the app's raw compose/env override (can change/remove volume mounts).
      description: 'Update user-level docker-compose and env overrides for an app.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          dockerCompose: { type: 'string', description: 'Docker compose override' },
          appEnv: { type: 'string', description: 'App env override' },
        },
        required: ['appUrn', 'dockerCompose', 'appEnv'],
      },
      handler: (p) => this.updateUserConfig(p as { appUrn: string; dockerCompose: string; appEnv: string }),
    });
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_enable_user_config',
      access: 'write',
      description: 'Enable user config overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.enableUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_disable_user_config',
      access: 'write',
      description: 'Disable user config overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.disableUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_ignore_app_version',
      access: 'write',
      description: 'Ignore the current available update for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.ignoreAppVersion(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Configuration',
      name: 'hub_unignore_app_version',
      access: 'write',
      description: 'Stop ignoring available updates for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.unignoreAppVersion(p as { appUrn: string }),
    });
  }

  /*
   * Each call asks the lifecycle's actor gate first (`assertMcpCallerMay`): `view` to read an app's
   * overrides, `configure` to change them. The gate cannot sit in `AppsService`, which the lifecycle
   * module depends on, nor in `UserConfigService`, which is kept clear of that module and serves
   * `/api/user-config` routes that assert no grant of their own (CI-Hub#1397).
   */
  async getUserConfig(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    return this.userConfigService.getUserConfig(appUrn);
  }
  async updateUserConfig(params: { appUrn: string; dockerCompose: string; appEnv: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    await this.userConfigService.updateUserConfig(appUrn, { dockerCompose: params.dockerCompose, appEnv: params.appEnv });
    return { success: true };
  }
  async enableUserConfig(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    await this.userConfigService.enableUserConfig(appUrn);
    return { success: true };
  }
  async disableUserConfig(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    await this.userConfigService.disableUserConfig(appUrn);
    return { success: true };
  }
  async ignoreAppVersion(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    return this.appsService.ignoreAppVersion(appUrn);
  }
  async unignoreAppVersion(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    return this.appsService.unignoreAppVersion(appUrn);
  }
}
