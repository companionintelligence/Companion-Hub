import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import si from 'systeminformation';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const INCOMPLETE_GPU_PROFILE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
// systeminformation can return the PCIe BAR/framebuffer size (e.g. 32 MB) instead
// of actual GDDR VRAM when GPU device passthrough is unavailable inside a container.
// Any reading below this threshold is treated as unreliable for a discrete GPU.
const MIN_PLAUSIBLE_DISCRETE_VRAM_MB = 512;
// Windows WMI Win32_VideoController.AdapterRAM is a 32-bit field that saturates near 4 GB, so any
// NVIDIA GPU with >=4 GB VRAM reports ~4095 MB there. Readings in this band on Windows are treated
// as suspect and cross-checked against nvidia-smi; values above it are trusted as-is.
const WMI_VRAM_CAP_MIN_MB = 4000;
const WMI_VRAM_CAP_MAX_MB = 4096;

type IntegratedGpuInference = {
  vendor: 'amd' | 'intel';
  model: string;
};

/** Hardware data written by the Tauri desktop app on macOS hosts. */
interface MacOsHostProbe {
  platform: 'darwin';
  cpuArch: 'arm64' | 'x86_64';
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  availableRamMb: number;
  isAppleSilicon: boolean;
  source: string;
}

@Injectable()
export class HardwareInspectorService implements OnModuleInit {
  private cachedProfile: HardwareProfile | null = null;
  private lastIncompleteDiscreteGpuRefreshAt = 0;

  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly hostMetrics: HostMetricsService,
  ) {}

  async onModuleInit() {
    try {
      this.updateCachedProfile(await this.detect());
      this.logger.info(
        `[HardwareInspector] Detected tier: ${this.cachedProfile?.tier}, GPU: ${this.cachedProfile?.gpu.vendor} ${this.cachedProfile?.gpu.model}`,
      );
    } catch (err) {
      this.logger.error(`[HardwareInspector] Failed to detect hardware: ${err}`);
    }
  }

  /** Get the cached hardware profile, or re-detect if not available */
  async getProfile(): Promise<HardwareProfile> {
    if (!this.cachedProfile) {
      return this.updateCachedProfile(await this.detect());
    }

    if (this.hasIncompleteDiscreteGpuProfile(this.cachedProfile)) {
      const now = Date.now();
      if (now - this.lastIncompleteDiscreteGpuRefreshAt >= INCOMPLETE_GPU_PROFILE_REFRESH_COOLDOWN_MS) {
        return this.updateCachedProfile(await this.detect());
      }
    }

    return this.cachedProfile;
  }

  /** Force a re-scan of hardware */
  async rescan(): Promise<HardwareProfile> {
    return this.updateCachedProfile(await this.detect());
  }

  private updateCachedProfile(profile: HardwareProfile): HardwareProfile {
    this.cachedProfile = profile;
    if (this.hasIncompleteDiscreteGpuProfile(profile)) {
      this.lastIncompleteDiscreteGpuRefreshAt = Date.now();
    } else {
      this.lastIncompleteDiscreteGpuRefreshAt = 0;
    }
    return profile;
  }

  /** Main detection routine */
  async detect(): Promise<HardwareProfile> {
    const [gpuInfo, rawRamInfo, rawCpuInfo, nvidiaRuntime, rocmSupport] = await Promise.all([
      this.detectGpu(),
      this.detectRam(),
      this.detectCpu(),
      this.detectNvidiaRuntime(),
      this.detectRocmSupport(),
    ]);

    // Read cross-platform host probe (init-host-probe, Tauri desktop, or legacy macOS file).
    const hostProbe = await this.hostMetrics.readHostProbe();
    const macOsProbe = hostProbe?.platform === 'darwin' ? this.toMacOsHostProbe(hostProbe) : null;
    if (macOsProbe) {
      this.logger.info(
        `[HardwareInspector] Using host probe: ${macOsProbe.cpuModel}, totalRam=${macOsProbe.totalRamMb} MB, isAppleSilicon=${macOsProbe.isAppleSilicon}`,
      );
    } else if (hostProbe) {
      this.logger.info(`[HardwareInspector] Using host probe: ${hostProbe.host.cpuModel ?? 'unknown CPU'}, totalRam=${hostProbe.host.totalRamMb} MB`);
    }

    const ramInfo = hostProbe ? { totalMb: hostProbe.host.totalRamMb, availableMb: hostProbe.host.availableRamMb } : rawRamInfo;

    const cpuInfo = hostProbe
      ? {
          arch: hostProbe.cpuArch as 'x86_64' | 'arm64',
          cores: hostProbe.host.cpuCores || rawCpuInfo.cores,
          model: hostProbe.host.cpuModel || rawCpuInfo.model,
        }
      : rawCpuInfo;

    const nvidiaHostProbe = await this.readNvidiaHostProbe();
    const effectiveGpuInfo =
      nvidiaHostProbe && (gpuInfo.vendor === 'nvidia' || !gpuInfo.available)
        ? {
            available: gpuInfo.available || !!nvidiaHostProbe.model,
            vendor: 'nvidia' as const,
            model: gpuInfo.model || nvidiaHostProbe.model,
            vramMb: gpuInfo.vramMb >= MIN_PLAUSIBLE_DISCRETE_VRAM_MB ? gpuInfo.vramMb : nvidiaHostProbe.vramMb,
            driverVersion: gpuInfo.driverVersion || nvidiaHostProbe.driverVersion,
          }
        : gpuInfo;

    if (!gpuInfo.available && hostProbe) {
      this.logger.info('[HardwareInspector] Using host NVIDIA probe cache fallback for GPU detection.');
    } else if (hostProbe && gpuInfo.vendor === 'nvidia' && gpuInfo.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB) {
      this.logger.info('[HardwareInspector] Augmenting NVIDIA GPU detection with host probe VRAM data (SI reported unreliable value).');
    }

    // Host probe platform is authoritative on Docker Desktop (macOS/Windows); the container reports linux.
    const hostPlatform = hostProbe?.platform;
    const platform = hostPlatform ?? this.getHostPlatform();
    const isAppleSilicon =
      macOsProbe?.isAppleSilicon === true ||
      (hostProbe?.platform === 'darwin' && hostProbe.cpuArch === 'arm64' && (hostProbe.host.cpuModel?.startsWith('Apple') ?? false));

    let gpu: HardwareProfile['gpu'] = {
      // Apple Silicon always has an integrated GPU; don't rely on container detection.
      available: isAppleSilicon ? true : effectiveGpuInfo.available,
      vendor: isAppleSilicon ? 'apple' : effectiveGpuInfo.vendor,
      model: isAppleSilicon ? `${cpuInfo.model} (Apple Silicon)` : effectiveGpuInfo.model,
      vramMb: isAppleSilicon ? ramInfo.totalMb : effectiveGpuInfo.vramMb,
      unifiedMemory: isAppleSilicon,
      driverVersion: effectiveGpuInfo.driverVersion,
      runtimeAvailable: isAppleSilicon || (effectiveGpuInfo.vendor === 'nvidia' ? nvidiaRuntime : rocmSupport),
    };

    if (!isAppleSilicon) {
      gpu = this.applyIntegratedGpuInference(gpu, cpuInfo.model, ramInfo.totalMb, rocmSupport);
    }

    if (gpu.vendor === 'amd') {
      const hostRocmProbe = await this.readRocmHostProbe();
      gpu = { ...gpu, hostRocmAvailable: hostRocmProbe?.available ?? false };
      if (gpu.hostRocmAvailable) {
        this.logger.info('[HardwareInspector] AMD GPU detected and host ROCm is available.');
      } else if (gpu.available) {
        this.logger.info('[HardwareInspector] AMD GPU detected; host ROCm not detected (install on host for Ollama GPU acceleration).');
      }
    }

    if (gpu.vendor === 'nvidia') {
      if (gpu.runtimeAvailable) {
        this.logger.info('[HardwareInspector] NVIDIA GPU detected and NVIDIA container runtime is available.');
      } else {
        this.logger.warn(
          '[HardwareInspector] NVIDIA GPU detected but NVIDIA container runtime is unavailable. Verify NVIDIA drivers, nvidia-container-toolkit, and container GPU passthrough configuration.',
        );
      }
    }

    const effectiveInferenceMemoryMb = gpu.unifiedMemory ? ramInfo.availableMb : gpu.available ? gpu.vramMb : ramInfo.availableMb;

    const tier = this.computeTier(gpu, ramInfo);
    const os = await this.detectOs(platform, hostPlatform === 'darwin' || hostPlatform === 'win32');

    return {
      gpu,
      npu: { available: false, model: '' },
      ram: ramInfo,
      cpu: cpuInfo,
      os,
      effectiveInferenceMemoryMb,
      tier,
    };
  }

  /**
   * Host OS name + release codename. In dev (backend on the host) systeminformation reports the real
   * OS (e.g. macOS "Tahoe"). When a macOS or Windows host probe is present the backend runs inside
   * Docker, so si.osInfo() would describe the Linux VM — report the probed host OS instead.
   */
  private async detectOs(
    platform: NodeJS.Platform | 'darwin',
    fromVmHostProbe: boolean,
  ): Promise<{ platform: string; name: string; version: string }> {
    if (fromVmHostProbe && platform === 'darwin') {
      return { platform: 'darwin', name: 'macOS', version: '' };
    }
    if (fromVmHostProbe && platform === 'win32') {
      return { platform: 'win32', name: 'Windows', version: '' };
    }
    try {
      const info = await si.osInfo();
      const name = info.distro || (platform === 'darwin' ? 'macOS' : String(platform));
      return { platform: info.platform || String(platform), name, version: info.codename || info.release || '' };
    } catch {
      return { platform: String(platform), name: platform === 'darwin' ? 'macOS' : String(platform), version: '' };
    }
  }

  /**
   * Infer an integrated GPU (APU / SoC) from the host CPU marketing name when container
   * GPU passthrough is unavailable — e.g. AMD Ryzen AI MAX+ with Radeon 8060S.
   */
  inferIntegratedGpuFromCpu(cpuModel: string): IntegratedGpuInference | null {
    const normalized = cpuModel.trim();
    if (!normalized) {
      return null;
    }

    const lower = normalized.toLowerCase();

    const amdSuffixMatch = normalized.match(/\bw\/\s*(Radeon\s+.+)$/i) ?? normalized.match(/\bwith\s+(Radeon\s+.+)$/i);
    const radeonInNameMatch = normalized.match(/\b(Radeon\s+[\w\s+]+)/i);

    if (
      lower.includes('ryzen ai') ||
      lower.includes('radeon graphics') ||
      amdSuffixMatch ||
      (radeonInNameMatch && (lower.includes('ryzen') || lower.includes('amd')))
    ) {
      const model = amdSuffixMatch?.[1]?.trim() ?? radeonInNameMatch?.[1]?.trim() ?? 'AMD Radeon Graphics';
      return { vendor: 'amd', model };
    }

    if (lower.includes('iris xe') || lower.includes('iris graphics') || lower.includes('uhd graphics') || lower.includes('intel arc graphics')) {
      const model =
        normalized.match(/\b(Iris(?:\s+Xe)?(?:\s+Graphics)?|UHD\s+Graphics\s+\d+|Intel\s+Arc\s+Graphics)/i)?.[1]?.trim() ??
        'Intel Integrated Graphics';
      return { vendor: 'intel', model };
    }

    return null;
  }

  private applyIntegratedGpuInference(
    gpu: HardwareProfile['gpu'],
    cpuModel: string,
    totalRamMb: number,
    rocmRuntimeAvailable: boolean,
  ): HardwareProfile['gpu'] {
    const integrated = this.inferIntegratedGpuFromCpu(cpuModel);
    const looksLikeDiscreteAmd = gpu.available && gpu.vendor === 'amd' && !gpu.unifiedMemory && gpu.vramMb >= MIN_PLAUSIBLE_DISCRETE_VRAM_MB;

    if (!integrated || looksLikeDiscreteAmd) {
      return gpu;
    }

    const shouldTreatAsUnifiedApu =
      !gpu.available ||
      gpu.vendor === 'none' ||
      (gpu.vendor === 'amd' && gpu.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB) ||
      gpu.vendor === integrated.vendor;

    if (!shouldTreatAsUnifiedApu) {
      return gpu;
    }

    const model = integrated.model || gpu.model || 'Integrated Graphics';
    const runtimeAvailable = integrated.vendor === 'amd' ? rocmRuntimeAvailable : gpu.runtimeAvailable;

    this.logger.info(
      `[HardwareInspector] Inferred ${integrated.vendor.toUpperCase()} integrated GPU (${model}) from CPU "${cpuModel}" with ${totalRamMb} MB shared memory.`,
    );

    return {
      available: true,
      vendor: integrated.vendor,
      model,
      vramMb: totalRamMb,
      unifiedMemory: true,
      driverVersion: gpu.driverVersion,
      runtimeAvailable,
    };
  }

  computeTier(gpu: HardwareProfile['gpu'], ram: HardwareProfile['ram']): HardwareTier {
    if (gpu.available && gpu.runtimeAvailable) {
      const effectiveVram = gpu.unifiedMemory ? ram.totalMb : gpu.vramMb;
      if (effectiveVram >= 16384) return 'high';
      if (effectiveVram >= 8192) return 'medium';
      if (effectiveVram >= 4096) return 'low';
      if (!gpu.unifiedMemory && effectiveVram < MIN_PLAUSIBLE_DISCRETE_VRAM_MB && (gpu.vendor === 'nvidia' || gpu.vendor === 'amd')) {
        this.logger.warn(
          `[HardwareInspector] ${gpu.vendor.toUpperCase()} GPU detected with unreliable VRAM reading (${effectiveVram} MB); defaulting tier to low until probe data is available.`,
        );
        return 'low';
      }
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
      const platform = this.getHostPlatform();
      if (platform === 'darwin') {
        return await this.detectMacGpu();
      }

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
          modelLower.includes('gtx') ||
          modelLower.includes('quadro') ||
          modelLower.includes('tesla')
        ) {
          return 'nvidia';
        }
        if (vendorLower.includes('amd') || vendorLower.includes('advanced micro') || modelLower.includes('radeon') || modelLower.includes('rx ')) {
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
        return await this.detectNvidiaFallback();
      }

      if (best.vendor !== 'nvidia') {
        const fromNvidiaFallback = await this.detectNvidiaFallback();
        if (fromNvidiaFallback.available) {
          return fromNvidiaFallback;
        }
      }

      let vramMb = best.vramMb;
      let model = best.model;
      let driverVersion = best.driverVersion;
      // Only cross-check NVIDIA VRAM against nvidia-smi when the systeminformation reading looks
      // unreliable: a sub-512 MB PCIe BAR/framebuffer (any platform), or a value in the Windows WMI
      // 32-bit AdapterRAM cap band (~4095 MB). Such a capped >4 GB card also lands below the 4096 MB
      // tier threshold and mislabels the host as "CPU Only". A plausible reading is trusted as-is,
      // avoiding the external nvidia-smi call (and its 5s timeout) on the common path.
      const siVramLooksUnreliable =
        vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB || (platform === 'win32' && vramMb >= WMI_VRAM_CAP_MIN_MB && vramMb <= WMI_VRAM_CAP_MAX_MB);
      if (best.vendor === 'nvidia' && siVramLooksUnreliable) {
        // nvidia-smi reports true memory; cross-check against the most capable GPU it lists (as a unit,
        // since multiple WMI-capped controllers can tie at 4095 MB).
        const smiGpu = await this.detectLargestNvidiaGpuViaSmi();
        // Prefer nvidia-smi when it reports more memory than systeminformation (WMI cap), and always
        // defer to it for implausibly small SI readings (PCIe BAR/framebuffer) — even when it reports 0,
        // so the unreliable value is discarded. When the runtime is available, that sub-512 MB value also
        // marks the profile incomplete (see hasIncompleteDiscreteGpuProfile), triggering a later refresh.
        if (smiGpu.vramMb > vramMb || vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB) {
          vramMb = smiGpu.vramMb;
          // Adopt the matching GPU's identity so model/driver stay consistent with the corrected VRAM —
          // otherwise `best` may still point at a different (tied) controller than the one we now report.
          if (smiGpu.model) {
            model = smiGpu.model;
            driverVersion = smiGpu.driverVersion || driverVersion;
          }
        }
        if (vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB && !model) {
          const fromSmi = await this.detectNvidiaFallback();
          if (fromSmi.available) {
            return fromSmi;
          }
        }
      } else if (best.vendor === 'amd' && vramMb <= 0) {
        vramMb = await this.detectAmdVram();
      }

      return {
        available: vramMb > 0 || !!model,
        vendor: best.vendor,
        model,
        vramMb,
        driverVersion,
      };
    } catch (err) {
      this.logger.warn(
        `[HardwareInspector] GPU detection failed. Verify container GPU device passthrough and nvidia-smi availability. Error: ${err}`,
      );
      return await this.detectNvidiaFallback();
    }
  }

  private async detectNvidiaFallback(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    const fromSmi = await this.detectNvidiaViaSmi();
    if (fromSmi.available) {
      return fromSmi;
    }

    const fromProc = await this.detectNvidiaViaProcfs();
    if (fromProc.available) {
      return fromProc;
    }

    return await this.detectNvidiaViaHostCache();
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

  private async detectNvidiaViaProcfs(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      const cached = await this.readNvidiaHostProbe();
      const infoStdout = await execAsync('cat /proc/driver/nvidia/gpus/*/information 2>/dev/null || true')
        .then((result) => result.stdout)
        .catch(() => '');
      const versionStdout = await execAsync('cat /proc/driver/nvidia/version 2>/dev/null || true')
        .then((result) => result.stdout)
        .catch(() => '');

      const model =
        infoStdout
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.startsWith('Model:'))
          ?.split(':')
          .slice(1)
          .join(':')
          .trim() ?? '';

      const driverVersion = versionStdout.match(/NVRM version:\s+[^\n]*?\s([0-9]+(?:\.[0-9]+)+)\b/)?.[1] ?? '';

      if (!model) {
        return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
      }

      return {
        available: true,
        vendor: 'nvidia',
        model,
        vramMb: cached?.vramMb ?? 0,
        driverVersion,
      };
    } catch {
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }
  }

  private async detectNvidiaViaHostCache(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    const cached = await this.readNvidiaHostProbe();
    if (!cached?.model) {
      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    }

    return {
      available: true,
      vendor: 'nvidia',
      model: cached.model,
      vramMb: cached.vramMb,
      driverVersion: cached.driverVersion,
    };
  }

  private async readRocmHostProbe(): Promise<{ available: boolean } | null> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/rocm.json');
      if (!raw) return null;

      const parsed = JSON.parse(raw) as { available?: boolean };
      return { available: parsed.available === true };
    } catch {
      return null;
    }
  }

  private async readNvidiaHostProbe(): Promise<{ model: string; vramMb: number; driverVersion: string } | null> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/nvidia.json');
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        model?: string;
        vramMb?: number;
        driverVersion?: string;
      };

      if (!parsed.model || typeof parsed.model !== 'string') return null;
      return {
        model: parsed.model,
        vramMb: typeof parsed.vramMb === 'number' && Number.isFinite(parsed.vramMb) && parsed.vramMb > 0 ? parsed.vramMb : 0,
        driverVersion: typeof parsed.driverVersion === 'string' ? parsed.driverVersion : '',
      };
    } catch {
      return null;
    }
  }

  private getHostPlatform(): NodeJS.Platform {
    if (
      process.env.CI_HUB_HOST_PLATFORM === 'darwin' ||
      process.env.CI_HUB_HOST_PLATFORM === 'linux' ||
      process.env.CI_HUB_HOST_PLATFORM === 'win32'
    ) {
      return process.env.CI_HUB_HOST_PLATFORM;
    }
    return os.platform();
  }

  private toMacOsHostProbe(hostProbe: NonNullable<Awaited<ReturnType<HostMetricsService['readHostProbe']>>>): MacOsHostProbe {
    const cpuModel = hostProbe.host.cpuModel ?? '';
    return {
      platform: 'darwin',
      cpuArch: hostProbe.cpuArch,
      cpuModel,
      cpuCores: hostProbe.host.cpuCores,
      totalRamMb: hostProbe.host.totalRamMb,
      availableRamMb: hostProbe.host.availableRamMb,
      isAppleSilicon: hostProbe.cpuArch === 'arm64' && cpuModel.startsWith('Apple'),
      source: hostProbe.source,
    };
  }

  private async detectMacGpu(): Promise<{
    available: boolean;
    vendor: 'nvidia' | 'amd' | 'intel' | 'none';
    model: string;
    vramMb: number;
    driverVersion: string;
  }> {
    try {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json', { timeout: 10000 });
      const data = JSON.parse(stdout);

      const displays = data?.SPDisplaysDataType || [];
      for (const display of displays) {
        const model = display.sppci_model || display.spdisplays_device_name || '';
        const vramStr = display.sppci_vram || display.spdisplays_vram || '0';

        let vramMb = 0;
        const vramMatch = vramStr.match(/(\d+)\s*(GB|MB)/i);
        if (vramMatch) {
          const value = Number.parseInt(vramMatch[1], 10);
          const unit = vramMatch[2].toUpperCase();
          vramMb = unit === 'GB' ? value * 1024 : value;
        }

        const modelLower = model.toLowerCase();
        let vendor: 'nvidia' | 'amd' | 'intel' | 'none' = 'none';

        if (modelLower.includes('nvidia') || modelLower.includes('geforce') || modelLower.includes('rtx') || modelLower.includes('gtx')) {
          vendor = 'nvidia';
        } else if (modelLower.includes('amd') || modelLower.includes('radeon') || modelLower.includes('rx ')) {
          vendor = 'amd';
        } else if (modelLower.includes('intel') || modelLower.includes('iris') || modelLower.includes('uhd')) {
          vendor = 'intel';
        }

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

      return { available: false, vendor: 'none', model: '', vramMb: 0, driverVersion: '' };
    } catch (err) {
      this.logger.warn(`[HardwareInspector] macOS GPU detection failed: ${err}`);
      return await this.detectGpuFallback();
    }
  }

  /** Fallback GPU detection using systeminformation */
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
   * Query each NVIDIA GPU's identity + VRAM via nvidia-smi and return the one with the largest VRAM.
   * Selecting the GPU as a unit keeps model/VRAM/driver consistent on multi-GPU hosts rather than
   * pairing the largest VRAM with whichever GPU nvidia-smi happens to list first.
   */
  private async detectLargestNvidiaGpuViaSmi(): Promise<{ model: string; vramMb: number; driverVersion: string }> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits', {
        timeout: 5000,
      });
      let largest = { model: '', vramMb: 0, driverVersion: '' };
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [modelRaw, memoryRaw, driverRaw] = trimmed.split(',').map((part) => part?.trim() ?? '');
        const vramMb = Number.parseInt(memoryRaw ?? '', 10);
        if (Number.isFinite(vramMb) && vramMb > largest.vramMb) {
          largest = { model: modelRaw || '', vramMb, driverVersion: driverRaw || '' };
        }
      }
      return largest;
    } catch {
      return { model: '', vramMb: 0, driverVersion: '' };
    }
  }

  /** Detect AMD VRAM using rocm-smi */
  private async detectAmdVram(): Promise<number> {
    try {
      const { stdout } = await execAsync('rocm-smi --showmeminfo vram --csv', { timeout: 5000 });
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const [headerLine, ...dataLines] = lines;
      if (!headerLine || dataLines.length === 0) {
        return 0;
      }

      const headers = headerLine.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
      const totalVramIndex = headers.findIndex(
        (header) => /vram/i.test(header) && /total/i.test(header) && /memory/i.test(header) && !/used/i.test(header),
      );
      if (totalVramIndex === -1) {
        return 0;
      }

      let largestVramMb = 0;
      for (const line of dataLines) {
        const values = line.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
        const vramBytes = Number.parseInt(values[totalVramIndex] ?? '', 10);
        if (Number.isNaN(vramBytes) || vramBytes <= 0) {
          continue;
        }

        const vramMb = Math.round(vramBytes / (1024 * 1024));
        if (vramMb > largestVramMb) {
          largestVramMb = vramMb;
        }
      }

      return largestVramMb;
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

  private hasIncompleteDiscreteGpuProfile(profile: HardwareProfile): boolean {
    return (
      profile.gpu.available &&
      profile.gpu.runtimeAvailable &&
      !profile.gpu.unifiedMemory &&
      (profile.gpu.vendor === 'nvidia' || profile.gpu.vendor === 'amd') &&
      profile.gpu.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB
    );
  }
}
