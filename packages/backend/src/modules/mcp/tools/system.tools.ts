import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SystemService } from '@/modules/system/system.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { DockerService } from '@/modules/docker/docker.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';

@Injectable()
export class SystemTools implements OnModuleInit {
  constructor(
    private readonly systemService: SystemService,
    private readonly systemUpdateService: SystemUpdateService,
    private readonly dockerService: DockerService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_system_load',
      description: 'Get current system load: disk, CPU, and memory usage.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getSystemLoad(),
    });
    this.registry.register({
      name: 'hub_get_hub_logs',
      description: 'Get recent Hub container log lines. Useful for debugging Hub issues.',
      inputSchema: { type: 'object', properties: { maxLines: { type: 'number', description: 'Max log lines (1-1000, default 100)' } }, required: [] },
      handler: (p) => this.getHubLogs(p as { maxLines?: number }),
    });
    this.registry.register({
      name: 'hub_detect_services',
      description: 'Detect Docker services running on the host.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.detectServices(),
    });
    this.registry.register({
      name: 'hub_check_for_updates',
      description: 'Check if a Hub update is available.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.checkForUpdates(),
    });
    this.registry.register({
      name: 'hub_perform_update',
      destructive: true, // ISSUE-MCP-2: replaces the running Hub with a new version.
      description: 'Update the Hub to a specific or latest version.',
      inputSchema: {
        type: 'object',
        properties: { targetVersion: { type: 'string', description: 'Version to update to (omit for latest)' } },
        required: [],
      },
      handler: (p) => this.performUpdate(p as { targetVersion?: string }),
    });
    this.registry.register({
      name: 'hub_get_auto_updates',
      description: 'Check whether automatic Hub updates are enabled.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getAutoUpdates(),
    });
    this.registry.register({
      name: 'hub_set_auto_updates',
      description: 'Enable or disable automatic Hub updates.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean', description: 'Whether to enable auto-updates' } },
        required: ['enabled'],
      },
      handler: (p) => this.setAutoUpdates(p as { enabled: boolean }),
    });
  }

  async getSystemLoad() {
    return this.systemService.getSystemLoad();
  }

  async getHubLogs(params: { maxLines?: number }): Promise<{ lines: string[] }> {
    const maxLines = Math.max(1, Math.min(params.maxLines ?? 100, 1000));
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
        .getLogsStream(maxLines)
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
        .catch(() => {
          finish({ lines: [] });
        });
    });
  }

  async detectServices() {
    return this.systemService.detectDockerServices();
  }
  async checkForUpdates() {
    const r = await this.systemUpdateService.checkForUpdates();
    return { updateAvailable: r.updateAvailable, currentVersion: r.current, latestVersion: r.latest };
  }
  async performUpdate(params: { targetVersion?: string }) {
    return this.systemUpdateService.performUpdate(params.targetVersion);
  }
  async getAutoUpdates() {
    return { enabled: this.systemUpdateService.getAutoUpdatesEnabled() };
  }
  async setAutoUpdates(params: { enabled: boolean }) {
    await this.systemUpdateService.setAutoUpdatesEnabled(params.enabled);
    return { enabled: params.enabled };
  }
}
