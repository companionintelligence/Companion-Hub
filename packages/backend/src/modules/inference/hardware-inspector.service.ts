import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import si from 'systeminformation';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

const execAsync = promisify(exec);

@Injectable()
export class HardwareInspectorService implements OnModuleInit {
  private cachedProfile: HardwareProfile | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
  ) {}

  async onModuleInit() {
    try {
      this.cachedProfile = await this.detect();
      this.logger.info(
        `[HardwareInspector] Detected tier: ${this.cachedProfile.tier}, GPU: ${this.cachedProfile.gpu.vendor} ${this.cachedProfile.gpu.model}`,
      );
    } catch (err) {
      this.logger.error(`[HardwareInspector] Failed to detect hardware: ${err}`);
    }
  }

  /** Get the cached hardware profile, or re-detect if not available */
  async getProfile(): Promise<HardwareProfile> {
    if (!this.cachedProfile) {
      this.cachedProfile = await this.detect();
    }
    return this.cachedProfile;
  }

  /** Force a re-scan of hardware */
  async rescan(): Promise<HardwareProfile> {
    this.cachedProfile = await this.detect();
    return this.cachedProfile;
  }

  /** Main detection routine */
  async detect(): Promise<HardwareProfile> {
    const [gpuInfo, ramInfo, cpuInfo, nvidiaRuntime, rocmSupport] = await Promise.all([
      this.detectGpu(),
      this.detectRam(),
      this.detectCpu(),
      this.detectNvidiaRuntime(),
      this.detectRocmSupport(),
    ]);

    const isAppleSilicon = (cpuInfo.arch === 'arm64' && os.platform() === 'darwin') || gpuInfo.vendor === 'apple';

    const gpu: HardwareProfile['gpu'] = {
      available: isAppleSilicon ? true : gpuInfo.available,
      vendor: isAppleSilicon ? 'apple' : gpuInfo.vendor,
      model: isAppleSilicon ? `${cpuInfo.model || gpuInfo.model} (Apple Silicon)` : gpuInfo.model,
      vramMb: isAppleSilicon ? ramInfo.totalMb : gpuInfo.vramMb,
      unifiedMemory: isAppleSilicon,
      driverVersion: gpuInfo.driverVersion,
      runtimeAvailable: isAppleSilicon || (gpuInfo.vendor === 'nvidia' ? nvidiaRuntime : rocmSupport),
    };

    const effectiveInferenceMemoryMb = gpu.unifiedMemory ? ramInfo.availableMb : gpu.available ? gpu.vramMb : ramInfo.availableMb;

    const tier = this.computeTier(gpu, ramInfo);

    const profile = {
      gpu,
      npu: { available: false, model: '' },
      ram: ramInfo,
      cpu: cpuInfo,
      effectiveInferenceMemoryMb,
      tier,
    };

    const profilePath = path.join(DATA_DIR, 'state', 'hardware-profile.json');
    try {
      await this.filesystem.writeJsonFile(profilePath, profile);
    } catch {
      // best-effort cache persistence
    }

    return profile;
  }

  computeTier(gpu: HardwareProfile['gpu'], ram: HardwareProfile['ram']): HardwareTier {
    if (gpu.available && gpu.runtimeAvailable) {
      const effectiveVram = gpu.unifiedMemory ? ram.totalMb : gpu.vramMb;
      if (effectiveVram >= 16384) return 'high';
      if (effectiveVram >= 8192) return 'medium';
      if (effectiveVram >= 4096) return 'low';
    }
    // CPU-only with unified memory check
    if (gpu.unifiedMemory) {
      if (ram.totalMb >= 32768) return 'high';
      if (ram.totalMb >= 16384) return 'medium';
      if (ram.totalMb >= 8192) return 'low';
    }
    if (ram.totalMb >= 16384) return 'cpu-only';
    return 'insufficient';
  }

  private async detectGpu(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      const graphics = await si.graphics();
      const controllers = graphics.controllers ?? [];
      const controller =
        controllers
          .map((c) => ({ ...c, vram: Number(c.vram) || 0 }))
          .sort((a, b) => (b.vram || 0) - (a.vram || 0))
          .find((c) => c.model || c.vendor) || controllers[0];

      if (!controller?.model) {
        return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
      }

      const model = controller.model || '';
      const vramMb = controller.vram || 0;
      const driverVersion = controller.driverVersion || '';

      let vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'none' = 'none';
      const vendorStr = (controller.vendor || '').toLowerCase();
      if (
        vendorStr.includes('nvidia') ||
        model.toLowerCase().includes('nvidia') ||
        model.toLowerCase().includes('geforce') ||
        model.toLowerCase().includes('rtx') ||
        model.toLowerCase().includes('gtx')
      ) {
        vendor = 'nvidia';
      } else if (vendorStr.includes('amd') || vendorStr.includes('advanced micro') || model.toLowerCase().includes('radeon')) {
        vendor = 'amd';
      } else if (vendorStr.includes('intel')) {
        vendor = 'intel';
      } else if (vendorStr.includes('apple') || model.toLowerCase().includes('apple')) {
        vendor = 'apple';
      }

      const available = vendor === 'apple' ? true : vendor !== 'none' && vramMb > 0;
      return { available, vendor, model, vramMb, driverVersion };
    } catch (err) {
      this.logger.warn(`[HardwareInspector] GPU detection failed: ${err}`);
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }
  }

  private async detectRam(): Promise<{ totalMb: number; availableMb: number }> {
    try {
      if (os.platform() === 'linux') {
        const content = await this.filesystem.readTextFile('/host/proc/meminfo');
        if (content) {
          const lines = content.split('\n');
          let totalKb = 0;
          let availKb = 0;
          for (const line of lines) {
            if (line.startsWith('MemTotal:')) {
              totalKb = Number.parseInt(line.split(/\s+/)[1] ?? '0', 10);
            } else if (line.startsWith('MemAvailable:')) {
              availKb = Number.parseInt(line.split(/\s+/)[1] ?? '0', 10);
            }
          }
          if (totalKb > 0 && availKb > 0) {
            return {
              totalMb: Math.floor(totalKb / 1024),
              availableMb: Math.floor(availKb / 1024),
            };
          }
        }
      }

      const mem = await si.mem();
      if (mem.total > 0 && mem.available > 0) {
        return {
          totalMb: Math.floor(mem.total / (1024 * 1024)),
          availableMb: Math.floor(mem.available / (1024 * 1024)),
        };
      }

      return {
        totalMb: Math.floor(os.totalmem() / (1024 * 1024)),
        availableMb: Math.floor(os.freemem() / (1024 * 1024)),
      };
    } catch {
      const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
      const availMb = Math.floor(os.freemem() / (1024 * 1024));
      return { totalMb, availableMb: availMb };
    }
  }

  private async detectCpu(): Promise<{ arch: 'x86_64' | 'arm64'; cores: number; model: string }> {
    try {
      const cpuData = await si.cpu();
      const arch = os.arch() === 'arm64' ? ('arm64' as const) : ('x86_64' as const);
      return {
        arch,
        cores: cpuData.cores || os.cpus().length,
        model: cpuData.brand || os.cpus()[0]?.model || 'Unknown',
      };
    } catch {
      return {
        arch: os.arch() === 'arm64' ? 'arm64' : 'x86_64',
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown',
      };
    }
  }

  private async detectNvidiaRuntime(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('docker info --format "{{json .Runtimes}}"');
      return stdout.includes('nvidia');
    } catch {
      return false;
    }
  }

  private async detectRocmSupport(): Promise<boolean> {
    try {
      const [kfd, dri] = await Promise.all([this.filesystem.pathExists('/dev/kfd'), this.filesystem.pathExists('/dev/dri')]);
      return kfd && dri;
    } catch {
      return false;
    }
  }
}
