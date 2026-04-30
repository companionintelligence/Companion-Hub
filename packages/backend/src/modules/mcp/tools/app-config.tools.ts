import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UserConfigService } from '@/modules/user-config/user-config.service';
import { AppsService } from '@/modules/apps/apps.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in storeSlug:appName format' } as const;

@Injectable()
export class AppConfigTools implements OnModuleInit {
  constructor(
    private readonly userConfigService: UserConfigService,
    private readonly appsService: AppsService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_get_user_config',
      description: 'Get user-level docker-compose and env overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.getUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_update_user_config',
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
      name: 'hub_enable_user_config',
      description: 'Enable user config overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.enableUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_disable_user_config',
      description: 'Disable user config overrides for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.disableUserConfig(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_ignore_app_version',
      description: 'Ignore the current available update for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.ignoreAppVersion(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_unignore_app_version',
      description: 'Stop ignoring available updates for an app.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.unignoreAppVersion(p as { appUrn: string }),
    });
  }

  async getUserConfig(params: { appUrn: string }) {
    return this.userConfigService.getUserConfig(castAppUrn(params.appUrn));
  }
  async updateUserConfig(params: { appUrn: string; dockerCompose: string; appEnv: string }) {
    await this.userConfigService.updateUserConfig(castAppUrn(params.appUrn), { dockerCompose: params.dockerCompose, appEnv: params.appEnv });
    return { success: true };
  }
  async enableUserConfig(params: { appUrn: string }) {
    await this.userConfigService.enableUserConfig(castAppUrn(params.appUrn));
    return { success: true };
  }
  async disableUserConfig(params: { appUrn: string }) {
    await this.userConfigService.disableUserConfig(castAppUrn(params.appUrn));
    return { success: true };
  }
  async ignoreAppVersion(params: { appUrn: string }) {
    return this.appsService.ignoreAppVersion(castAppUrn(params.appUrn));
  }
  async unignoreAppVersion(params: { appUrn: string }) {
    return this.appsService.unignoreAppVersion(castAppUrn(params.appUrn));
  }
}
