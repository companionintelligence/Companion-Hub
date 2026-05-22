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
      // Special handling for macOS to get better GPU info
      if (os.platform() === 'darwin') {
        return await this.detectMacGpu();
      }

      const graphics = await si.graphics();
      const controller = graphics.controllers?.[0];

      if (!controller?.model) {
        return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
      }

      const model = controller.model || '';
      let vramMb = controller.vram || 0;
      const driverVersion = controller.driverVersion || '';

      let vendor: 'nvidia' | 'amd' | 'intel' | 'none' = 'none';
      const vendorStr = (controller.vendor || '').toLowerCase();
      const modelLower = model.toLowerCase();

      if (
        vendorStr.includes('nvidia') ||
        modelLower.includes('nvidia') ||
        modelLower.includes('geforce') ||
        modelLower.includes('rtx') ||
        modelLower.includes('gtx') ||
        modelLower.includes('quadro') ||
        modelLower.includes('tesla')
      ) {
        vendor = 'nvidia';
        // Try to detect VRAM via nvidia-smi if not already detected
        if (vramMb === 0) {
          vramMb = await this.detectNvidiaVram();
        }
      } else if (vendorStr.includes('amd') || vendorStr.includes('advanced micro') || modelLower.includes('radeon') || modelLower.includes('rx ')) {
        vendor = 'amd';
        // Try to detect VRAM via rocm-smi if not already detected
        if (vramMb === 0) {
          vramMb = await this.detectAmdVram();
        }
      } else if (vendorStr.includes('intel') || modelLower.includes('intel')) {
        vendor = 'intel';
      }

      return { available: vendor !== 'none' && vramMb > 0, vendor, model, vramMb, driverVersion };
    } catch (err) {
      this.logger.warn(`[HardwareInspector] GPU detection failed: ${err}`);
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }
  }

  /**
   * Detect GPU on macOS using system_profiler
   */
  private async detectMacGpu(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      // Use system_profiler to get GPU info
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json', { timeout: 10000 });
      const data = JSON.parse(stdout);

      const displays = data?.SPDisplaysDataType || [];
      for (const display of displays) {
        const model = display.sppci_model || display.spdisplays_device_name || '';
        const vramStr = display.sppci_vram || display.spdisplays_vram || '0';

        // Parse VRAM (format like "8 GB" or "8192 MB")
        let vramMb = 0;
        const vramMatch = vramStr.match(/(\d+)\s*(GB|MB)/i);
        if (vramMatch) {
          const value = Number.parseInt(vramMatch[1], 10);
          const unit = vramMatch[2].toUpperCase();
          vramMb = unit === 'GB' ? value * 1024 : value;
        }

        // Detect vendor from model name
        const modelLower = model.toLowerCase();
        let vendor: 'nvidia' | 'amd' | 'intel' | 'none' = 'none';

        if (modelLower.includes('nvidia') || modelLower.includes('geforce') || modelLower.includes('rtx') || modelLower.includes('gtx')) {
          vendor = 'nvidia';
        } else if (modelLower.includes('amd') || modelLower.includes('radeon') || modelLower.includes('rx ')) {
          vendor = 'amd';
        } else if (modelLower.includes('intel') || modelLower.includes('iris') || modelLower.includes('uhd')) {
          vendor = 'intel';
        }

        // Return first discrete GPU found
        if (vendor !== 'none' && vramMb > 0) {
          return {
            available: true,
            vendor,
            model,
            vramMb,
            driverVersion: '',
          };
        }
      }

      // No discrete GPU found
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    } catch (err) {
      this.logger.warn(`[HardwareInspector] macOS GPU detection failed: ${err}`);
      // Fallback to systeminformation
      return await this.detectGpuFallback();
    }
  }

  /**
   * Fallback GPU detection using systeminformation
   */
  private async detectGpuFallback(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    const graphics = await si.graphics();
    const controller = graphics.controllers?.[0];

    if (!controller?.model) {
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }

    const model = controller.model || '';
    const vramMb = controller.vram || 0;
    const driverVersion = controller.driverVersion || '';
    const vendorStr = (controller.vendor || '').toLowerCase();
    const modelLower = model.toLowerCase();

    let vendor: 'nvidia' | 'amd' | 'intel' | 'none' = 'none';
    if (vendorStr.includes('nvidia') || modelLower.includes('nvidia')) vendor = 'nvidia';
    else if (vendorStr.includes('amd') || modelLower.includes('radeon')) vendor = 'amd';
    else if (vendorStr.includes('intel')) vendor = 'intel';

    return { available: vendor !== 'none' && vramMb > 0, vendor, model, vramMb, driverVersion };
  }

  /**
   * Detect NVIDIA VRAM using nvidia-smi
   */
  private async detectNvidiaVram(): Promise<number> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { timeout: 5000 });
      const vramMb = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(vramMb) ? 0 : vramMb;
    } catch {
      return 0;
    }
  }

  /**
   * Detect AMD VRAM using rocm-smi
   */
  private async detectAmdVram(): Promise<number> {
    try {
      const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv', { timeout: 5000 });
      // Parse CSV output to extract VRAM
      const lines = stdout.trim().split('\n');
      if (lines.length > 1 && lines[1]) {
        const values = lines[1].split(',');
        if (values[0]) {
          const vramMb = Number.parseInt(values[0], 10);
          return Number.isNaN(vramMb) ? 0 : vramMb;
        }
      }
      return 0;
    } catch {
      return 0;
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
