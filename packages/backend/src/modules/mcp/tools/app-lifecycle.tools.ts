import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { StackCompositionService } from '@/modules/app-lifecycle/stack-composition.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { McpToolRegistry } from '../mcp-tool-registry.service';

const urnProp = { type: 'string', description: 'App identifier in storeSlug:appName format' } as const;

@Injectable()
export class AppLifecycleTools implements OnModuleInit {
  constructor(
    private readonly appLifecycleService: AppLifecycleService,
    private readonly stackCompositionService: StackCompositionService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'compose_stack',
      description:
        'Compose a multi-app stack from natural language or a recipe, generating shared networks/volumes/env cross-references and optionally executing installation.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'Natural language request (e.g. "set up a media server for my family")' },
          recipeId: { type: 'string', description: 'Optional known recipe id (e.g. media-server, ai-stack)' },
          includeOptionalApps: { type: 'boolean', description: 'Include optional recipe apps (default true)' },
          approved: { type: 'boolean', description: 'Set true after user approval to execute installation' },
          execute: { type: 'boolean', description: 'Alias for approved=true' },
        },
        required: [],
      },
      handler: (p) =>
        this.composeStack(
          p as {
            request?: string;
            recipeId?: string;
            includeOptionalApps?: boolean;
            approved?: boolean;
            execute?: boolean;
          },
        ),
    });
    this.registry.register({
      name: 'hub_install_app',
      description: 'Install an app from a configured app store. Returns a requestId to track progress.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: urnProp,
          form: { type: 'object', description: 'Optional install config: port, exposed, domain, and app-specific form fields' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.installApp(p as { appUrn: string; form?: Record<string, unknown> }),
    });
    this.registry.register({
      name: 'hub_start_app',
      description: 'Start a stopped app. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.startApp(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_stop_app',
      description: 'Stop a running app gracefully. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.stopApp(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_restart_app',
      description: 'Restart a running app. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.restartApp(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_uninstall_app',
      description: 'Uninstall an app. Optionally remove its backups. Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, removeBackups: { type: 'boolean', description: 'Also delete backups (default false)' } },
        required: ['appUrn'],
      },
      handler: (p) => this.uninstallApp(p as { appUrn: string; removeBackups?: boolean }),
    });
    this.registry.register({
      name: 'hub_reset_app',
      description: 'Reset an app to its default state, removing all data. Returns a requestId.',
      inputSchema: { type: 'object', properties: { appUrn: urnProp }, required: ['appUrn'] },
      handler: (p) => this.resetApp(p as { appUrn: string }),
    });
    this.registry.register({
      name: 'hub_update_app',
      description: 'Update an app to the latest version. Optionally skip backup. Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, performBackup: { type: 'boolean', description: 'Backup before updating (default true)' } },
        required: ['appUrn'],
      },
      handler: (p) => this.updateApp(p as { appUrn: string; performBackup?: boolean }),
    });
    this.registry.register({
      name: 'hub_update_app_config',
      description: 'Update an app configuration (port, domain, env vars). Returns a requestId.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: urnProp, form: { type: 'object', description: 'Config fields to update' } },
        required: ['appUrn', 'form'],
      },
      handler: (p) => this.updateAppConfig(p as { appUrn: string; form: Record<string, unknown> }),
    });
    this.registry.register({
      name: 'hub_update_all_apps',
      description: 'Update all installed apps to their latest versions.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.updateAllApps(),
    });
    this.registry.register({
      name: 'hub_start_all_apps',
      description: 'Start all installed apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.startAllApps(),
    });
    this.registry.register({
      name: 'hub_stop_all_apps',
      description: 'Stop all running apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.stopAllApps(),
    });
    this.registry.register({
      name: 'hub_restart_all_apps',
      description: 'Restart all running apps.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.restartAllApps(),
    });
  }

  async installApp(params: { appUrn: string; form?: Record<string, unknown> }) {
    return this.appLifecycleService.installApp({ appUrn: castAppUrn(params.appUrn), form: params.form ?? {} });
  }
  async composeStack(params: { request?: string; recipeId?: string; includeOptionalApps?: boolean; approved?: boolean; execute?: boolean }) {
    return this.stackCompositionService.composeStack(params);
  }
  async startApp(params: { appUrn: string }) {
    return this.appLifecycleService.startApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async stopApp(params: { appUrn: string }) {
    return this.appLifecycleService.stopApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async restartApp(params: { appUrn: string }) {
    return this.appLifecycleService.restartApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async uninstallApp(params: { appUrn: string; removeBackups?: boolean }) {
    return this.appLifecycleService.uninstallApp({ appUrn: castAppUrn(params.appUrn), removeBackups: params.removeBackups ?? false });
  }
  async resetApp(params: { appUrn: string }) {
    return this.appLifecycleService.resetApp({ appUrn: castAppUrn(params.appUrn) });
  }
  async updateApp(params: { appUrn: string; performBackup?: boolean }) {
    return this.appLifecycleService.updateApp({ appUrn: castAppUrn(params.appUrn), performBackup: params.performBackup ?? true });
  }
  async updateAppConfig(params: { appUrn: string; form: Record<string, unknown> }) {
    return this.appLifecycleService.updateAppConfig({ appUrn: castAppUrn(params.appUrn), form: params.form });
  }
  async updateAllApps() {
    return this.appLifecycleService.updateAllApps();
  }
  async startAllApps() {
    return this.appLifecycleService.startAllApps();
  }
  async stopAllApps() {
    return this.appLifecycleService.stopAllApps();
  }
  async restartAllApps() {
    return this.appLifecycleService.restartAllApps();
  }
}
