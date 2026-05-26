import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import si from 'systeminformation';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

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

    const isAppleSilicon = cpuInfo.arch === 'arm64' && os.platform() === 'darwin';

    const gpu: HardwareProfile['gpu'] = {
      available: gpuInfo.available,
      vendor: isAppleSilicon ? 'apple' : gpuInfo.vendor,
      model: isAppleSilicon ? `${cpuInfo.model} (Apple Silicon)` : gpuInfo.model,
      vramMb: isAppleSilicon ? ramInfo.totalMb : gpuInfo.vramMb,
      unifiedMemory: isAppleSilicon,
      driverVersion: gpuInfo.driverVersion,
      runtimeAvailable: isAppleSilicon || (gpuInfo.vendor === 'nvidia' ? nvidiaRuntime : rocmSupport),
    };

    if (gpu.vendor === 'nvidia' && !gpu.runtimeAvailable) {
      this.logger.warn(
        '[HardwareInspector] NVIDIA GPU detected but NVIDIA container runtime is unavailable. Verify NVIDIA drivers, nvidia-container-toolkit, and container GPU passthrough configuration.',
      );
    }

    const effectiveInferenceMemoryMb = gpu.unifiedMemory ? ramInfo.availableMb : gpu.available ? gpu.vramMb : ramInfo.availableMb;

    const tier = this.computeTier(gpu, ramInfo);

    return {
      gpu,
      npu: { available: false, model: '' },
      ram: ramInfo,
      cpu: cpuInfo,
      effectiveInferenceMemoryMb,
      tier,
    };
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
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      const graphics = await si.graphics();
      const controllers = graphics.controllers ?? [];

      const detectVendor = (vendorValue: string, modelValue: string): 'nvidia' | 'amd' | 'intel' | 'none' => {
        const modelLower = modelValue.toLowerCase();
        const vendorLower = vendorValue.toLowerCase();
        if (
          vendorLower.includes('nvidia') ||
          modelLower.includes('nvidia') ||
          modelLower.includes('geforce') ||
          modelLower.includes('rtx') ||
          modelLower.includes('gtx')
        ) {
          return 'nvidia';
        }
        if (vendorLower.includes('amd') || vendorLower.includes('advanced micro') || modelLower.includes('radeon')) {
          return 'amd';
        }
        if (vendorLower.includes('intel')) {
          return 'intel';
        }
        return 'none';
      };

      const rankedControllers = controllers
        .map((controller) => {
          const model = controller.model || '';
          const vendor = detectVendor(controller.vendor || '', model);
          const vramMb = controller.vram || 0;
          const vendorRank = vendor === 'nvidia' ? 3 : vendor === 'amd' ? 2 : vendor === 'intel' ? 1 : 0;
          return {
            vendor,
            model,
            vramMb,
            driverVersion: controller.driverVersion || '',
            score: vendorRank * 1_000_000 + vramMb,
          };
        })
        .sort((a, b) => b.score - a.score);

      const best = rankedControllers[0];
      if (!best || best.vendor === 'none') {
        return await this.detectNvidiaViaSmi();
      }

      if (best.vendor === 'nvidia' && (best.vramMb <= 0 || !best.model)) {
        const fromSmi = await this.detectNvidiaViaSmi();
        if (fromSmi.available) {
          return fromSmi;
        }
      }

      return {
        available: best.vramMb > 0 || !!best.model,
        vendor: best.vendor,
        model: best.model,
        vramMb: best.vramMb,
        driverVersion: best.driverVersion,
      };
    } catch (err) {
      this.logger.warn(
        `[HardwareInspector] GPU detection failed. Verify container GPU device passthrough and nvidia-smi availability. Error: ${err}`,
      );
      return await this.detectNvidiaViaSmi();
    }
  }

  private async detectNvidiaViaSmi(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits');
      const firstGpuLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (!firstGpuLine) {
        return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
      }

      const parts = firstGpuLine.split(',').map((part) => part?.trim() ?? '');
      if (parts.length < 2) {
        return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
      }
      const [modelRaw, memoryRaw, driverRaw] = parts;
      const vramMb = Number.parseInt(memoryRaw ?? '', 10);
      const model = modelRaw || 'NVIDIA GPU';
      const driverVersion = driverRaw || '';

      return {
        available: true,
        vendor: 'nvidia',
        model,
        vramMb: Number.isFinite(vramMb) && vramMb > 0 ? vramMb : 0,
        driverVersion,
      };
    } catch {
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }
  }

  private async detectRam(): Promise<{ totalMb: number; availableMb: number }> {
    try {
      const content = await this.filesystem.readTextFile('/host/proc/meminfo');
      if (!content) throw new Error('Empty meminfo');
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
      return {
        totalMb: Math.floor(totalKb / 1024),
        availableMb: Math.floor(availKb / 1024),
      };
    } catch {
      // Fallback to os module
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
