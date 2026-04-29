import { Injectable } from '@nestjs/common';
import { SystemService } from '@/modules/system/system.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { DockerService } from '@/modules/docker/docker.service';

@Injectable()
export class SystemTools {
  constructor(
    private readonly systemService: SystemService,
    private readonly systemUpdateService: SystemUpdateService,
    private readonly dockerService: DockerService,
  ) {}

  async getSystemLoad() {
    return this.systemService.getSystemLoad();
  }

  async getHubLogs(params: { maxLines?: number }): Promise<{ lines: string[] }> {
    const maxLines = Math.max(1, Math.min(params.maxLines ?? 100, 1000));

    return new Promise((resolve) => {
      const lines: string[] = [];
      const timeout = setTimeout(() => {
        stream?.kill();
        resolve({ lines });
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
            clearTimeout(timeout);
            resolve({ lines: lines.slice(-maxLines) });
          });
        })
        .catch(() => {
          clearTimeout(timeout);
          resolve({ lines: [] });
        });
    });
  }

  async detectServices() {
    return this.systemService.detectDockerServices();
  }

  async checkForUpdates() {
    const result = await this.systemUpdateService.checkForUpdates();
    return {
      updateAvailable: result.updateAvailable,
      currentVersion: result.current,
      latestVersion: result.latest,
    };
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
