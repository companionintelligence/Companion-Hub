import { Injectable } from '@nestjs/common';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { rocmInstallPhaseSchema } from './inference.dto';
import type { z } from 'zod';

export type RocmInstallPhase = z.infer<typeof rocmInstallPhaseSchema>;

export interface RocmInstallState {
  phase: RocmInstallPhase;
  updatedAt: string;
  message?: string;
}

export interface RocmInstallStatus {
  hostRocmAvailable: boolean;
  runtimeRocmAvailable: boolean;
  installPhase: RocmInstallPhase;
  installMessage?: string;
  canAutoInstall: boolean;
  platformHint: 'linux-ubuntu' | 'linux-other' | 'windows' | 'macos' | 'unknown';
}

@Injectable()
export class RocmInstallerService {
  private readonly rocmProbePath = '/data/state/hardware/rocm.json';
  private readonly rocmInstallPath = '/data/state/hardware/rocm-install.json';

  constructor(private readonly filesystem: FilesystemService) {}

  async getStatus(): Promise<RocmInstallStatus> {
    const [hostProbe, installState, runtimeAvailable, platformHint] = await Promise.all([
      this.readHostRocmProbe(),
      this.readInstallState(),
      this.detectRuntimeRocm(),
      this.resolvePlatformHint(),
    ]);

    return {
      hostRocmAvailable: hostProbe,
      runtimeRocmAvailable: runtimeAvailable,
      installPhase: installState?.phase ?? 'idle',
      installMessage: installState?.message,
      canAutoInstall: platformHint === 'linux-ubuntu',
      platformHint,
    };
  }

  async recordInstallState(state: RocmInstallState): Promise<void> {
    await this.filesystem.writeTextFile(this.rocmInstallPath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async readHostRocmProbe(): Promise<boolean> {
    try {
      const raw = await this.filesystem.readTextFile(this.rocmProbePath);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { available?: boolean };
      return parsed.available === true;
    } catch {
      return false;
    }
  }

  private async readInstallState(): Promise<RocmInstallState | null> {
    try {
      const raw = await this.filesystem.readTextFile(this.rocmInstallPath);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { phase?: unknown; updatedAt?: string; message?: string };
      const phaseResult = rocmInstallPhaseSchema.safeParse(parsed.phase);
      if (!phaseResult.success || !parsed.updatedAt) return null;
      return {
        phase: phaseResult.data,
        updatedAt: parsed.updatedAt,
        message: parsed.message,
      };
    } catch {
      return null;
    }
  }

  private async detectRuntimeRocm(): Promise<boolean> {
    try {
      return (await this.filesystem.pathExists('/dev/kfd')) && (await this.filesystem.pathExists('/dev/dri'));
    } catch {
      return false;
    }
  }

  private async resolvePlatformHint(): Promise<RocmInstallStatus['platformHint']> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/host_metrics.json');
      if (!raw) return 'unknown';
      const parsed = JSON.parse(raw) as { platform?: string; osId?: string; osVersionId?: string };
      const platform = (parsed.platform ?? '').toLowerCase();
      const osId = (parsed.osId ?? '').toLowerCase();

      if (platform.includes('win') || osId === 'windows') return 'windows';
      if (platform.includes('mac') || osId === 'macos') return 'macos';
      if (osId === 'ubuntu') {
        const version = parsed.osVersionId ?? '';
        if (['22.04', '24.04', '26.04'].includes(version)) {
          return 'linux-ubuntu';
        }
        return 'linux-other';
      }
      if (platform.includes('linux') || osId === 'linux') return 'linux-other';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
