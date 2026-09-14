import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppsService } from '@/modules/apps/apps.service';
import { DockerService } from '@/modules/docker/docker.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { assertMcpCallerMay } from '../mcp-tool-call';
import { McpToolRegistry } from '../mcp-tool-registry.service';

@Injectable()
export class AppDiscoveryTools implements OnModuleInit {
  constructor(
    private readonly appsService: AppsService,
    private readonly dockerService: DockerService,
    private readonly registry: McpToolRegistry,
    private readonly appLifecycleService: AppLifecycleService,
  ) {}

  onModuleInit() {
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_list_installed_apps',
      access: 'read',
      description: 'List all installed apps with status, ports, domains, and metadata. Use to get an overview of what is running on the Hub.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.listInstalledApps(),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_get_app',
      access: 'read',
      description: 'Get detailed info for a specific app including form fields, description, version, and supported architectures.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format (e.g. nextcloud:ci-store)' } },
        required: ['appUrn'],
      },
      handler: (p) => this.getApp(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_get_app_logs',
      access: 'read',
      description: 'Retrieve recent container log lines for a running app. Useful for debugging issues.',
      inputSchema: {
        type: 'object',
        properties: {
          appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' },
          maxLines: { type: 'number', description: 'Max log lines to return (1-1000, default 100)' },
        },
        required: ['appUrn'],
      },
      handler: (p) => this.getAppLogs(p as { appUrn: string; maxLines?: number }),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_check_app_availability',
      access: 'read',
      description: 'Check whether an app is reachable via its configured URL. Returns availability status and URL.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' } },
        required: ['appUrn'],
      },
      handler: (p) => this.checkAppAvailability(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_resolve_app_availability',
      access: 'write',
      description: 'Attempt to fix availability issues for an app. Use after hub_check_app_availability returns unavailable.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' } },
        required: ['appUrn'],
      },
      handler: (p) => this.resolveAppAvailability(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_get_compose_diff',
      access: 'read',
      description: 'Get the difference between current and new docker-compose config for an app.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' } },
        required: ['appUrn'],
      },
      handler: (p) => this.getComposeDiff(p as { appUrn: string }),
    });
    this.registry.register({
      category: 'App Discovery',
      name: 'hub_get_config_diff',
      access: 'read',
      description: 'Get the difference between current and new app configuration.',
      inputSchema: {
        type: 'object',
        properties: { appUrn: { type: 'string', description: 'App identifier in appName:storeSlug format' } },
        required: ['appUrn'],
      },
      handler: (p) => this.getConfigDiff(p as { appUrn: string }),
    });
  }

  async listInstalledApps() {
    return this.appsService.getInstalledApps();
  }

  /*
   * Each call on one app asks the lifecycle's actor gate first (`assertMcpCallerMay`): `view` to read
   * it, `configure` to repair it — the verbs the app routes assert. The gate cannot sit in
   * `AppsService` or `DockerService`, which the lifecycle module itself depends on (CI-Hub#1397).
   */
  async getApp(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    return this.appsService.getApp(appUrn);
  }

  async getAppLogs(params: { appUrn: string; maxLines?: number }): Promise<{ lines: string[] }> {
    const maxLines = Math.max(1, Math.min(params.maxLines ?? 100, 1000));
    const appUrn = castAppUrn(params.appUrn) as AppUrn;
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');

    return new Promise((resolve) => {
      const lines: string[] = [];
      let resolved = false;
      const finish = (result: { lines: string[] }) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        resolve(result);
      };

      const timeout = setTimeout(() => {
        stream?.kill();
        finish({ lines });
      }, 5000);

      let stream: { on: (event: string, cb: (data: Buffer) => void) => void; kill: () => void } | null = null;

      this.dockerService
        .getLogsStream(maxLines, appUrn)
        .then((s) => {
          stream = s;
          s.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            if (text) {
              for (const line of text.split('\n')) {
                lines.push(line);
              }
            }
          });
          s.on('end' as string, () => {
            finish({ lines: lines.slice(-maxLines) });
          });
          s.on('error' as string, () => {
            finish({ lines });
          });
        })
        .catch((_err) => {
          finish({ lines: [] });
        });
    });
  }

  async checkAppAvailability(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    const result = await this.appsService.checkAppAvailability(appUrn);
    return { available: result.available, url: result.appUrl, error: result.reason };
  }

  async resolveAppAvailability(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'configure');
    const result = await this.appsService.resolveAppAvailability(appUrn);
    return { success: result.success, message: result.detail };
  }

  async getComposeDiff(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    return this.appsService.getAppComposeDiff(appUrn);
  }

  async getConfigDiff(params: { appUrn: string }) {
    const appUrn = castAppUrn(params.appUrn);
    await assertMcpCallerMay(this.appLifecycleService, appUrn, 'view');
    return this.appsService.getAppConfigDiff(appUrn);
  }
}
