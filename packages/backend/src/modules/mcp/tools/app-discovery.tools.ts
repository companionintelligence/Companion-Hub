import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { AppsService } from '@/modules/apps/apps.service';
import { DockerService } from '@/modules/docker/docker.service';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Injectable()
export class AppDiscoveryTools {
  constructor(
    private readonly appsService: AppsService,
    private readonly dockerService: DockerService,
  ) {}

  async listInstalledApps() {
    return this.appsService.getInstalledApps();
  }

  async getApp(params: { appUrn: string }) {
    return this.appsService.getApp(castAppUrn(params.appUrn));
  }

  async getAppLogs(params: { appUrn: string; maxLines?: number }): Promise<{ lines: string[] }> {
    const maxLines = Math.max(1, Math.min(params.maxLines ?? 100, 1000));
    const appUrn = castAppUrn(params.appUrn) as AppUrn;

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
    const result = await this.appsService.checkAppAvailability(castAppUrn(params.appUrn));
    return {
      available: result.available,
      url: result.appUrl,
      error: result.reason,
    };
  }

  async resolveAppAvailability(params: { appUrn: string }) {
    const result = await this.appsService.resolveAppAvailability(castAppUrn(params.appUrn));
    return {
      success: result.success,
      message: result.detail,
    };
  }

  async getComposeDiff(params: { appUrn: string }) {
    return this.appsService.getAppComposeDiff(castAppUrn(params.appUrn));
  }

  async getConfigDiff(params: { appUrn: string }) {
    return this.appsService.getAppConfigDiff(castAppUrn(params.appUrn));
  }
}
