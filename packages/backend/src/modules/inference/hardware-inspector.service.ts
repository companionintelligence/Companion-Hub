import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { HostMetricsService } from '@/modules/system/host-metrics.service';
import { isHostRocmStackProbe, isRocmKfdPassthroughProbe } from '@/modules/inference/host-rocm-availability';
import {
  HOST_GPU_PROCESSES_FILE_PATH,
  hostGpuProcessesFileSchema,
  samplesFromHostGpuProcessesFile,
} from '@/modules/inference/gpu-process-sampler.service';
import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import si from 'systeminformation';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const INCOMPLETE_GPU_PROFILE_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const HOST_PROBE_REFRESH_CHECK_COOLDOWN_MS = 30 * 1000;
// How much host RAM is free moves minute to minute — Ollama pulling a 20 GB model into GTT,
// vLLM holding 96 GB — while the rest of the profile (GPU identity, totals, CPU) does not.
// The profile is cached for the life of the process, so `ram.availableMb` used to freeze at
// whatever the host probe recorded at boot: core-2 served "124547 MB available" while
// `free -m` on the host said 53052. On a unified-memory node that same stale number was
// `effectiveInferenceMemoryMb`, the budget the router admits model loads against, which is
// how a busy Strix Halo got over-admitted into an OOM-kill. MemAvailable is one line of one
// file, so it is re-read on demand — but no more often than this.
const LIVE_RAM_SAMPLE_INTERVAL_MS = 5 * 1000;
const HOST_MEMINFO_PATH = '/host/proc/meminfo';
// systeminformation can return the PCIe BAR/framebuffer size (e.g. 32 MB) instead
// of actual GDDR VRAM when GPU device passthrough is unavailable inside a container.
// Any reading below this threshold is treated as unreliable for a discrete GPU.
const MIN_PLAUSIBLE_DISCRETE_VRAM_MB = 512;
// `nvidia.json` is written once per `cihub up` (scripts/init-gpu-runtime.ts), right before the
// containers start; nothing rewrites it afterwards, and Docker's own restart after a host reboot
// brings the Hub back without one. So what bounds the truth of "the host's driver answered
// nvidia-smi" is not a clock — a fixed max age like the GPU-process file's would expire it a
// minute into every boot, or mean nothing — but the boot it was taken in: a loaded driver does
// not leave without a reboot, and a reboot is exactly where it fails to come back (a kernel update
// DKMS did not follow). A probe from a previous boot describes previous hardware and proves
// nothing about this one. /proc/uptime is the kernel's, not the container's, so this boot is
// known here; the tolerance covers the wall clock settling (NTP) between boot and the probe.
const HOST_NVIDIA_PROBE_BOOT_TOLERANCE_MS = 5 * 60 * 1000;
// Windows WMI Win32_VideoController.AdapterRAM is a 32-bit field that NVIDIA saturates at exactly
// 4095 MB, so any GPU with >=4 GB VRAM reports ~4095 MB there. Readings in this band on Windows are
// treated as suspect and cross-checked against nvidia-smi. A reading of 4096+ MB instead comes from
// the reliable 64-bit registry path (a genuine >=4 GB card), so it is trusted as-is.
const WMI_VRAM_CAP_MIN_MB = 4000;
const WMI_VRAM_CAP_MAX_MB = 4095;

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
export class HardwareInspectorService {
  private cachedProfile: HardwareProfile | null = null;
  private lastIncompleteDiscreteGpuRefreshAt = 0;
  private hostProbeRefreshResolved = false;
  private lastHostProbeRefreshCheckAt = 0;
  private liveRamSample: { availableMb: number; sampledAt: number } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly hostMetrics: HostMetricsService,
  ) {}

  /**
   * The cached hardware profile (re-detected if not available), with the one figure that
   * changes between detections — free host RAM — read live. See {@link withLiveRam}.
   *
   * `freshRam` skips the {@link LIVE_RAM_SAMPLE_INTERVAL_MS} reuse for this one read. The router
   * sets it while it waits for an evicted model's memory to come back: on a unified-memory node
   * MemAvailable is the figure that shows the memory returning, and a sample from before the
   * unload would keep the load refused for up to five seconds after it had room.
   */
  async getProfile(options: { freshRam?: boolean } = {}): Promise<HardwareProfile> {
    return this.withLiveRam(await this.getCachedProfile(), options.freshRam === true);
  }

  private async getCachedProfile(): Promise<HardwareProfile> {
    if (!this.cachedProfile) {
      return this.updateCachedProfile(await this.detect());
    }

    if (this.shouldCheckForHostProbeRefresh()) {
      const now = Date.now();
      if (now - this.lastHostProbeRefreshCheckAt >= HOST_PROBE_REFRESH_CHECK_COOLDOWN_MS) {
        this.lastHostProbeRefreshCheckAt = now;
        const hostProbe = await this.hostMetrics.readHostProbe();
        if (this.shouldRefreshForHostProbe(this.cachedProfile, hostProbe)) {
          return this.updateCachedProfile(await this.detect());
        }
        if (hostProbe && (hostProbe.platform === 'darwin' || hostProbe.platform === 'win32')) {
          this.hostProbeRefreshResolved = true;
        }
      }
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
    return this.withLiveRam(this.updateCachedProfile(await this.detect()));
  }

  /**
   * Overlay the live free-RAM reading on a cached profile: `ram.availableMb`, `ram.usedMb`, and
   * — on a unified-memory or CPU-only node, where models load into system RAM — the
   * `effectiveInferenceMemoryMb` the router budgets against. Totals, GPU identity and tier
   * stay as detected.
   *
   * Not on a macOS/Windows host: there the Hub runs inside Docker Desktop's VM, whose
   * `/proc/meminfo` describes the VM and not the machine Ollama runs on, so the desktop
   * host probe (the only view of host RAM the container has) stays authoritative even
   * though it is a snapshot. `hostProbeRefreshResolved` is exactly "such a probe backs this
   * profile" — it is only ever set for a darwin/win32 probe.
   */
  private async withLiveRam(profile: HardwareProfile, fresh = false): Promise<HardwareProfile> {
    if (this.hostProbeRefreshResolved) {
      return profile;
    }
    const liveAvailableMb = await this.readLiveAvailableRamMb(fresh);
    if (liveAvailableMb === null) {
      return profile;
    }
    const availableMb = Math.min(liveAvailableMb.availableMb, profile.ram.totalMb);
    const ram: HardwareProfile['ram'] = {
      ...profile.ram,
      availableMb,
      usedMb: Math.max(0, profile.ram.totalMb - availableMb),
      sampledAt: new Date(liveAvailableMb.sampledAt).toISOString(),
    };
    const effectiveInferenceMemoryMb = profile.gpu.unifiedMemory || !profile.gpu.available ? availableMb : profile.effectiveInferenceMemoryMb;
    return { ...profile, ram, effectiveInferenceMemoryMb };
  }

  /**
   * The live MemAvailable sample, at most {@link LIVE_RAM_SAMPLE_INTERVAL_MS} old. `null` when
   * this host has no live reading to give (see {@link readRam}), in which case the caller keeps
   * what it had. `fresh` reads it now whatever the age of the last sample.
   */
  private async readLiveAvailableRamMb(fresh = false): Promise<{ availableMb: number; sampledAt: number } | null> {
    const now = Date.now();
    if (!fresh && this.liveRamSample && now - this.liveRamSample.sampledAt < LIVE_RAM_SAMPLE_INTERVAL_MS) {
      return this.liveRamSample;
    }
    const ram = await this.readRam();
    if (!ram.live) {
      return null;
    }
    this.liveRamSample = { availableMb: ram.availableMb, sampledAt: now };
    return this.liveRamSample;
  }

  /**
   * Total and available RAM as this process can see them, and whether "available" is a figure
   * worth re-reading. It is when it is Linux MemAvailable: the `/host/proc/meminfo` bind mount
   * (the host's own file), or `os.freemem()` on a Linux host, which libuv reads from the same
   * line (measured on Node 22: freemem 17240 MB, MemFree 9417, MemAvailable 17240). On a
   * native macOS/Windows run `os.freemem()` is free pages only — a few hundred MB on a busy Mac
   * that the OS would hand over on demand — so it is reported once, as it always was, and
   * never sampled or budgeted against.
   */
  private async readRam(): Promise<{ totalMb: number; availableMb: number; live: boolean }> {
    let parsed: { totalMb: number; availableMb: number } | null = null;
    try {
      parsed = this.parseMeminfo(await this.filesystem.readTextFile(HOST_MEMINFO_PATH));
    } catch {
      parsed = null;
    }
    if (parsed) {
      return { ...parsed, live: parsed.availableMb > 0 };
    }
    const availableMb = Math.floor(os.freemem() / (1024 * 1024));
    return {
      totalMb: Math.floor(os.totalmem() / (1024 * 1024)),
      availableMb,
      live: this.getHostPlatform() === 'linux' && availableMb > 0,
    };
  }

  private parseMeminfo(content: string | null | undefined): { totalMb: number; availableMb: number } | null {
    if (!content) return null;
    let totalKb = 0;
    let availKb = 0;
    for (const line of content.split('\n')) {
      if (line.startsWith('MemTotal:')) {
        totalKb = Number.parseInt(line.split(/\s+/)[1] ?? '0', 10);
      } else if (line.startsWith('MemAvailable:')) {
        availKb = Number.parseInt(line.split(/\s+/)[1] ?? '0', 10);
      }
    }
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return null;
    return { totalMb: Math.floor(totalKb / 1024), availableMb: Math.floor(availKb / 1024) };
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
    const [gpuInfo, rawRamInfo, rawCpuInfo, dockerInfo, rocmSupport] = await Promise.all([
      this.detectGpu(),
      this.detectRam(),
      this.detectCpu(),
      this.detectDockerInfo(),
      this.detectRocmSupport(),
    ]);
    const { nvidiaRuntime, containerHostKind } = dockerInfo;

    // Read cross-platform host probe (init-host-probe, Tauri desktop, or legacy macOS file).
    const hostProbe = await this.hostMetrics.readHostProbe();
    this.hostProbeRefreshResolved ||= hostProbe?.platform === 'darwin' || hostProbe?.platform === 'win32';
    const macOsProbe = hostProbe?.platform === 'darwin' ? this.toMacOsHostProbe(hostProbe) : null;
    if (macOsProbe) {
      this.logger.info(
        `[HardwareInspector] Using host probe: ${macOsProbe.cpuModel}, totalRam=${macOsProbe.totalRamMb} MB, isAppleSilicon=${macOsProbe.isAppleSilicon}`,
      );
    } else if (hostProbe) {
      this.logger.info(`[HardwareInspector] Using host probe: ${hostProbe.host.cpuModel ?? 'unknown CPU'}, totalRam=${hostProbe.host.totalRamMb} MB`);
    }

    // A Linux host probe (init-host-probe) is written once, before the containers start, so its
    // `availableRamMb` is a boot-time snapshot; the meminfo bind mount is the same host, now.
    // A macOS/Windows probe is the only view of the host past the Docker Desktop VM — keep it.
    const ramIsLive = rawRamInfo.live && (!hostProbe || hostProbe.platform === 'linux');
    const ramInfo = hostProbe
      ? { totalMb: hostProbe.host.totalRamMb, availableMb: ramIsLive ? rawRamInfo.availableMb : hostProbe.host.availableRamMb }
      : { totalMb: rawRamInfo.totalMb, availableMb: rawRamInfo.availableMb };

    const cpuInfo = hostProbe
      ? {
          arch: hostProbe.cpuArch as 'x86_64' | 'arm64',
          cores: hostProbe.host.cpuCores || rawCpuInfo.cores,
          model: hostProbe.host.cpuModel || rawCpuInfo.model,
        }
      : rawCpuInfo;

    const [nvidiaHostProbe, amdHostProbe] = await Promise.all([this.readNvidiaHostProbe(), this.readAmdHostProbe()]);
    let effectiveGpuInfo = gpuInfo;
    if (nvidiaHostProbe && (gpuInfo.vendor === 'nvidia' || !gpuInfo.available)) {
      effectiveGpuInfo = {
        available: gpuInfo.available || !!nvidiaHostProbe.model,
        vendor: 'nvidia' as const,
        model: gpuInfo.model || nvidiaHostProbe.model,
        vramMb: gpuInfo.vramMb >= MIN_PLAUSIBLE_DISCRETE_VRAM_MB ? gpuInfo.vramMb : nvidiaHostProbe.vramMb,
        driverVersion: gpuInfo.driverVersion || nvidiaHostProbe.driverVersion,
      };
    } else if (amdHostProbe && (gpuInfo.vendor === 'amd' || !gpuInfo.available)) {
      // On Windows + Docker Desktop the container's systeminformation cannot see
      // the host GPU's real VRAM, and WMI's 32-bit AdapterRAM clamps at 4 GB.
      // The desktop AMD host probe reads the 64-bit qwMemorySize, so trust it
      // when the container reported nothing plausible.
      effectiveGpuInfo = {
        available: gpuInfo.available || !!amdHostProbe.model,
        vendor: 'amd' as const,
        model: gpuInfo.model || amdHostProbe.model,
        vramMb: gpuInfo.vramMb >= MIN_PLAUSIBLE_DISCRETE_VRAM_MB ? gpuInfo.vramMb : amdHostProbe.vramMb,
        driverVersion: gpuInfo.driverVersion || amdHostProbe.driverVersion,
      };
    }

    if (!gpuInfo.available && hostProbe && nvidiaHostProbe) {
      this.logger.info('[HardwareInspector] Using host NVIDIA probe cache fallback for GPU detection.');
    } else if (!gpuInfo.available && hostProbe && amdHostProbe) {
      this.logger.info('[HardwareInspector] Using host AMD probe cache fallback for GPU detection.');
    } else if (hostProbe && gpuInfo.vendor === 'nvidia' && gpuInfo.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB) {
      this.logger.info('[HardwareInspector] Augmenting NVIDIA GPU detection with host probe VRAM data (SI reported unreliable value).');
    } else if (hostProbe && gpuInfo.vendor === 'amd' && gpuInfo.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB && amdHostProbe) {
      this.logger.info('[HardwareInspector] Augmenting AMD GPU detection with host probe VRAM data (SI reported unreliable value).');
    }

    // Host probe platform is authoritative on Docker Desktop (macOS/Windows); the container reports linux.
    const hostPlatform = hostProbe?.platform;
    const platform = hostPlatform ?? this.getHostPlatform();
    // A host probe only exists when the backend runs inside a VM/container and something on the
    // host wrote one (init-host-probe, the Tauri desktop shell). Running the backend DIRECTLY on
    // an Apple Silicon Mac — `pnpm dev`, `e2e/start-backend.sh`, the video capture stage — there is
    // no probe to read, and every Apple-Silicon branch below used to be skipped: detectMacGpu()
    // asks `system_profiler SPDisplaysDataType`, which reports the integrated GPU as
    // `sppci_model: "Apple M2 Max"` with NO VRAM field, so its vendor match (nvidia/amd/intel) and
    // its `vramMb > 0` gate both fail. The Hub then told a 38-core M2 Max "No GPU detected … consider
    // installing a graphics card". os.platform()/os.arch() ARE the host's on a native run, so use them.
    const nativeAppleSilicon = !hostProbe && platform === 'darwin' && cpuInfo.arch === 'arm64';
    const isAppleSilicon =
      macOsProbe?.isAppleSilicon === true || (hostProbe?.platform === 'darwin' && hostProbe.cpuArch === 'arm64') || nativeAppleSilicon;

    if (nativeAppleSilicon) {
      this.logger.info(
        `[HardwareInspector] Apple Silicon host detected natively (${cpuInfo.model}); reporting the integrated GPU with ${ramInfo.totalMb} MB unified memory.`,
      );
    }
    const appleGpuModel = cpuInfo.model ? `${cpuInfo.model} (Apple Silicon)` : 'Apple Silicon';

    let gpu: HardwareProfile['gpu'] = {
      // Apple Silicon always has an integrated GPU; don't rely on container detection.
      available: isAppleSilicon ? true : effectiveGpuInfo.available,
      vendor: isAppleSilicon ? 'apple' : effectiveGpuInfo.vendor,
      model: isAppleSilicon ? appleGpuModel : effectiveGpuInfo.model,
      vramMb: isAppleSilicon ? ramInfo.totalMb : effectiveGpuInfo.vramMb,
      unifiedMemory: isAppleSilicon,
      driverVersion: effectiveGpuInfo.driverVersion,
      runtimeAvailable: isAppleSilicon || (effectiveGpuInfo.vendor === 'nvidia' ? nvidiaRuntime : rocmSupport),
      containerHostKind,
      ...(!isAppleSilicon && effectiveGpuInfo.deviceCount && effectiveGpuInfo.poolVramMb
        ? { deviceCount: effectiveGpuInfo.deviceCount, poolVramMb: effectiveGpuInfo.poolVramMb }
        : {}),
    };

    if (!isAppleSilicon) {
      gpu = this.applyIntegratedGpuInference(gpu, cpuInfo.model, ramInfo.totalMb, rocmSupport);
    }

    if (gpu.vendor === 'amd') {
      const hostRocmProbe = await this.readRocmHostProbe();
      const runtimeRocmDevices = await this.detectRocmSupport();
      const hostRocmKfdAvailable = isRocmKfdPassthroughProbe(hostRocmProbe) || runtimeRocmDevices;
      gpu = {
        ...gpu,
        hostRocmAvailable: isHostRocmStackProbe(hostRocmProbe) || runtimeRocmDevices,
        hostRocmKfdAvailable,
      };
      if (hostRocmKfdAvailable) {
        this.logger.info('[HardwareInspector] AMD GPU detected and host ROCm /dev/kfd passthrough is available.');
      } else if (gpu.hostRocmAvailable) {
        this.logger.info('[HardwareInspector] AMD GPU detected with ROCm drivers present; /dev/kfd not ready yet.');
      } else if (gpu.available) {
        this.logger.info('[HardwareInspector] AMD GPU detected; host ROCm not detected (install on host for Ollama GPU acceleration).');
      }
    }

    if (gpu.vendor === 'nvidia') {
      // Same shape as the AMD block above: the host's own proof that the card is driven, kept
      // apart from `runtimeAvailable`, which stays the container's view. See gpuRuntimeReady().
      // Each source vouches only for as long as its writer does: nvidia.json for the boot it was
      // written in, the GPU-process file for the sampler's max age.
      const hostNvidiaAvailable = nvidiaHostProbe?.writtenThisBoot === true || (await this.hostGpuProcessesFileNamesNvidia());
      gpu = { ...gpu, hostNvidiaAvailable };
      if (gpu.runtimeAvailable) {
        this.logger.info('[HardwareInspector] NVIDIA GPU detected and NVIDIA container runtime is available.');
      } else if (hostNvidiaAvailable) {
        this.logger.info(
          `[HardwareInspector] NVIDIA GPU detected; the host driver answers nvidia-smi (${gpu.vramMb} MB) but the Hub container has no NVIDIA runtime — tiering from the host card; CUDA stays unavailable to container apps until nvidia-container-toolkit is installed.`,
        );
      } else {
        this.logger.warn(
          '[HardwareInspector] NVIDIA GPU detected but NVIDIA container runtime is unavailable. Verify NVIDIA drivers, nvidia-container-toolkit, and container GPU passthrough configuration.',
        );
      }
    }

    const effectiveInferenceMemoryMb = gpu.unifiedMemory ? ramInfo.availableMb : gpu.available ? (gpu.poolVramMb ?? gpu.vramMb) : ramInfo.availableMb;

    const tier = this.computeTier(gpu, ramInfo);
    const os = await this.detectOs(platform, hostPlatform === 'darwin' || hostPlatform === 'win32');

    return {
      gpu,
      npu: { available: false, model: '' },
      ram: {
        ...ramInfo,
        usedMb: Math.max(0, ramInfo.totalMb - ramInfo.availableMb),
        ...(ramIsLive ? { sampledAt: new Date(rawRamInfo.sampledAt).toISOString() } : {}),
      },
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
      containerHostKind: gpu.containerHostKind,
    };
  }

  /**
   * Whether inference can actually reach this GPU.
   *
   * `runtimeAvailable` is the CONTAINER's view: `/dev/kfd` + `/dev/dri` visible to the Hub
   * process. On a Linux host the Hub container is started without device passthrough, so that
   * is false on every AMD box — while Ollama, which is what runs the models, sits on the host
   * (or in its own container with the nodes bind-mounted) and uses the card fine. The host
   * probe (`/data/state/hardware/rocm.json`, `source: host-dev-kfd`) records exactly that.
   * Measured 2026-09-17 on an RX 7900 XTX: `runtimeAvailable=false`, `hostRocmKfdAvailable=true`,
   * tier computed as `cpu-only`, so the 27B the operator had pinned was rejected as "not
   * runnable" and every app was handed a 4B model. The tier must follow the host probe.
   *
   * NVIDIA has the same split. The container's view is `docker info`'s runtime list, and a fleet
   * node without nvidia-container-toolkit reports `runtimeAvailable=false` — while the host's
   * driver runs the card for the engine that actually serves models. Measured 2026-09-21 on
   * beta-nas (RTX A1000 8 GB, driver 595, no `nvidia` runtime): the host wrote `nvidia.json`
   * (name + 8188 MB) and a fresh `gpu_processes.json` showing the host's llama-server and
   * vLLM holding VRAM, yet the tier was `cpu-only` and every app got the CPU catalog, next to
   * beta-red (RTX 3080, runtime installed) on `medium`. `hostNvidiaAvailable` is that host
   * proof; `runtimeAvailable` is left false so the router and the setup card still say the
   * container has no CUDA.
   */
  private gpuRuntimeReady(gpu: HardwareProfile['gpu']): boolean {
    if (gpu.runtimeAvailable) return true;
    if (gpu.vendor === 'amd') return gpu.hostRocmKfdAvailable === true;
    if (gpu.vendor === 'nvidia') return gpu.hostNvidiaAvailable === true;
    return false;
  }

  /**
   * Whether the host GPU-process timer file names an NVIDIA writer — `cihub fleet update
   * --gpu-probe` installs `cihub-gpu-processes.sh`, which only writes when `nvidia-smi`
   * answered on the host. A stale or foreign-schema file counts for nothing, same as it does
   * for the sampler that reads it for VRAM.
   */
  private async hostGpuProcessesFileNamesNvidia(): Promise<boolean> {
    try {
      const file = await this.filesystem.readJsonFile(HOST_GPU_PROCESSES_FILE_PATH, hostGpuProcessesFileSchema);
      if (file?.vendor !== 'nvidia') return false;
      return samplesFromHostGpuProcessesFile(file) !== null;
    } catch {
      return false;
    }
  }

  computeTier(gpu: HardwareProfile['gpu'], ram: HardwareProfile['ram']): HardwareTier {
    if (gpu.available && this.gpuRuntimeReady(gpu)) {
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
    deviceCount?: number;
    poolVramMb?: number;
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
      let multiGpu: { deviceCount: number; poolVramMb: number } | null = null;
      // Only cross-check NVIDIA VRAM against nvidia-smi when the systeminformation reading looks
      // unreliable: a sub-512 MB PCIe BAR/framebuffer (any platform), or a value in the Windows WMI
      // 32-bit AdapterRAM cap band (~4095 MB). Such a capped >4 GB card also lands below the 4096 MB
      // tier threshold and mislabels the host as "CPU Only". A plausible reading is trusted as-is,
      // avoiding the external nvidia-smi call (and its 5s timeout) on the common path.
      const inWmiCapBand = platform === 'win32' && vramMb >= WMI_VRAM_CAP_MIN_MB && vramMb <= WMI_VRAM_CAP_MAX_MB;
      const siVramLooksUnreliable = vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB || inWmiCapBand;
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
        // A reading in the WMI cap band means the field saturated, so the card has at least ~4 GB. If the
        // cross-check couldn't recover the true value (nvidia-smi missing/slow), clamp to the 4 GB floor so
        // tiering degrades to `low` rather than mislabeling a detected GPU as cpu-only at the 4096 threshold.
        if (inWmiCapBand && vramMb <= WMI_VRAM_CAP_MAX_MB) {
          vramMb = WMI_VRAM_CAP_MAX_MB + 1;
        }
        if (vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB && !model) {
          const fromSmi = await this.detectNvidiaFallback();
          if (fromSmi.available) {
            return fromSmi;
          }
        }
      } else if (best.vendor === 'amd') {
        // systeminformation derives a Linux AMD card's VRAM from its lspci BAR, which is the
        // PCIe aperture, not the memory: a 24 GB RX 7900 XTX reads 32768 with resizable BAR on
        // and 256 with it off. The amdgpu driver publishes the real total in sysfs, which the
        // Hub container can read without any device passthrough.
        const sysfsCards = await this.detectAmdCardsFromSysfs();
        const sysfsVramMb = Math.max(0, ...sysfsCards);
        if (sysfsVramMb >= MIN_PLAUSIBLE_DISCRETE_VRAM_MB) {
          if (sysfsVramMb !== vramMb) {
            this.logger.info(`[HardwareInspector] AMD VRAM from sysfs: ${sysfsVramMb} MB (systeminformation reported ${vramMb} MB).`);
          }
          vramMb = sysfsVramMb;
          // Ollama spreads a model over every card it can, and the per-process VRAM the budget counts
          // is summed over all of them, so the pool has to be. A card under half the largest is a
          // display controller or an iGPU's carve-out, not one a model is split onto.
          const cards = sysfsCards.filter((cardMb) => cardMb >= sysfsVramMb / 2);
          if (cards.length > 1) {
            multiGpu = { deviceCount: cards.length, poolVramMb: cards.reduce((total, cardMb) => total + cardMb, 0) };
            this.logger.info(`[HardwareInspector] ${cards.length} AMD cards found in sysfs; models can spread over ${multiGpu.poolVramMb} MB.`);
          }
        } else if (vramMb <= 0) {
          vramMb = await this.detectAmdVram();
        }
      }

      return {
        available: vramMb > 0 || !!model,
        vendor: best.vendor,
        model,
        vramMb,
        driverVersion,
        ...multiGpu,
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

  private async readRocmHostProbe(): Promise<{ available: boolean; source?: string } | null> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/rocm.json');
      if (!raw) return null;

      const parsed = JSON.parse(raw) as { available?: boolean; source?: string };
      return {
        available: parsed.available === true,
        source: typeof parsed.source === 'string' ? parsed.source : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * init-gpu-runtime's `nvidia.json`. `model`/`vramMb`/`driverVersion` fill in what the container
   * cannot see of the card, whatever the file's age — the card's name does not change under a
   * running Hub. `writtenThisBoot` is the stricter question `hostNvidiaAvailable` asks, whether
   * the probe can vouch for the host's driver NOW: its `updatedAt` must parse and fall inside
   * this boot (see {@link HOST_NVIDIA_PROBE_BOOT_TOLERANCE_MS}). Same shape as the GPU-process
   * file's rule — an unparseable or out-of-window stamp proves nothing, a stamp ahead of our clock
   * included — with the window set by the writer's cadence, which for this file is the boot.
   */
  private async readNvidiaHostProbe(): Promise<{ model: string; vramMb: number; driverVersion: string; writtenThisBoot: boolean } | null> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/nvidia.json');
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        model?: string;
        vramMb?: number;
        driverVersion?: string;
        updatedAt?: string;
      };

      if (!parsed.model || typeof parsed.model !== 'string') return null;
      return {
        model: parsed.model,
        vramMb: typeof parsed.vramMb === 'number' && Number.isFinite(parsed.vramMb) && parsed.vramMb > 0 ? parsed.vramMb : 0,
        driverVersion: typeof parsed.driverVersion === 'string' ? parsed.driverVersion : '',
        writtenThisBoot: this.isHostProbeFromThisBoot(typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined),
      };
    } catch {
      return null;
    }
  }

  /**
   * Whether an ISO timestamp falls inside the current host boot, with
   * {@link HOST_NVIDIA_PROBE_BOOT_TOLERANCE_MS} of tolerance on both ends. `os.uptime()` reads
   * the kernel's `/proc/uptime`, which Docker does not namespace, so inside the Hub container it
   * is the host's.
   */
  private isHostProbeFromThisBoot(updatedAt: string | undefined, now: number = Date.now()): boolean {
    if (!updatedAt) return false;
    const writtenAt = Date.parse(updatedAt);
    if (!Number.isFinite(writtenAt)) return false;
    const bootedAt = now - os.uptime() * 1000;
    return writtenAt >= bootedAt - HOST_NVIDIA_PROBE_BOOT_TOLERANCE_MS && writtenAt <= now + HOST_NVIDIA_PROBE_BOOT_TOLERANCE_MS;
  }

  private async readAmdHostProbe(): Promise<{ model: string; vramMb: number; driverVersion: string } | null> {
    try {
      const raw = await this.filesystem.readTextFile('/data/state/hardware/amd.json');
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
      isAppleSilicon: hostProbe.cpuArch === 'arm64',
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
  /**
   * Every `mem_info_vram_total` across `/sys/class/drm/card*` — the amdgpu driver's own figure, in
   * MB. Empty when sysfs is unavailable or no card publishes one. The caller takes the largest, so an
   * iGPU (a Raphael die reports 512 MB) never wins over a discrete card.
   */
  private async detectAmdCardsFromSysfs(): Promise<number[]> {
    try {
      const entries = (await this.filesystem.listFiles('/sys/class/drm')) ?? [];
      const cards = entries.filter((name) => /^card\d+$/.test(name));
      const sizesMb: number[] = [];
      for (const card of cards) {
        const raw = await this.filesystem.readTextFile(`/sys/class/drm/${card}/device/mem_info_vram_total`);
        const vramBytes = Number.parseInt(raw?.trim() ?? '', 10);
        if (!Number.isFinite(vramBytes) || vramBytes <= 0) {
          continue;
        }
        sizesMb.push(Math.round(vramBytes / (1024 * 1024)));
      }
      return sizesMb;
    } catch {
      return [];
    }
  }

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

  private async detectRam(): Promise<{ totalMb: number; availableMb: number; live: boolean; sampledAt: number }> {
    const ram = await this.readRam();
    const sampledAt = Date.now();
    // A live reading — seed the sampler so the overlay does not read it again straight away.
    if (ram.live) {
      this.liveRamSample = { availableMb: ram.availableMb, sampledAt };
    }
    return { ...ram, sampledAt };
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

  /**
   * Single `docker info` call yielding both the nvidia-runtime flag and the backend
   * classification (one daemon round-trip instead of two). Docker Desktop reports
   * OperatingSystem "Docker Desktop"; a native engine inside WSL2 reports a distro OS
   * with a `*-microsoft-standard-WSL2` kernel; any other reachable Linux daemon is
   * treated as native Linux. Runtimes JSON, OperatingSystem, and KernelVersion contain
   * no tabs, so a tab-delimited template splits cleanly.
   */
  private async detectDockerInfo(): Promise<{
    nvidiaRuntime: boolean;
    containerHostKind: NonNullable<HardwareProfile['gpu']['containerHostKind']>;
  }> {
    try {
      const { stdout } = await execAsync('docker info --format "{{json .Runtimes}}\t{{.OperatingSystem}}\t{{.KernelVersion}}"');
      const [runtimes = '', osName = '', kernel = ''] = stdout.trim().split('\t');
      const nvidiaRuntime = runtimes.includes('nvidia');

      let containerHostKind: NonNullable<HardwareProfile['gpu']['containerHostKind']> = 'unknown';
      if (osName.includes('Docker Desktop')) {
        containerHostKind = 'docker-desktop';
      } else if (kernel.toLowerCase().includes('microsoft') || kernel.toLowerCase().includes('wsl')) {
        containerHostKind = 'wsl-engine';
      } else if (osName.trim().length > 0) {
        containerHostKind = 'native-linux';
      }

      return { nvidiaRuntime, containerHostKind };
    } catch {
      return { nvidiaRuntime: false, containerHostKind: 'unknown' };
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

  /**
   * A discrete card the CONTAINER runtime drives, whose VRAM still reads as a PCIe BAR: the
   * container's own nvidia-smi / sysfs will answer once the device settles, so the profile is
   * re-detected on {@link INCOMPLETE_GPU_PROFILE_REFRESH_COOLDOWN_MS}. Deliberately
   * `runtimeAvailable`, not {@link gpuRuntimeReady}: a card proven only by the host has no
   * container-side VRAM source to wait on, and its host sources cannot change under this
   * process — `nvidia.json` is rewritten by the `cihub up` that restarts the Hub, and the
   * GPU-process file carries no total — so re-detecting would spend `docker info`, lspci and
   * the rest every five minutes for the life of the process and never resolve. Such a profile
   * stays `low` until a rescan.
   */
  private hasIncompleteDiscreteGpuProfile(profile: HardwareProfile): boolean {
    return (
      profile.gpu.available &&
      profile.gpu.runtimeAvailable &&
      !profile.gpu.unifiedMemory &&
      (profile.gpu.vendor === 'nvidia' || profile.gpu.vendor === 'amd') &&
      profile.gpu.vramMb < MIN_PLAUSIBLE_DISCRETE_VRAM_MB
    );
  }

  private shouldRefreshForHostProbe(profile: HardwareProfile, hostProbe: Awaited<ReturnType<HostMetricsService['readHostProbe']>>): boolean {
    if (!hostProbe || (hostProbe.platform !== 'darwin' && hostProbe.platform !== 'win32')) {
      return false;
    }

    if (hostProbe.platform === 'darwin' && hostProbe.cpuArch === 'arm64' && (profile.gpu.vendor !== 'apple' || !profile.gpu.unifiedMemory)) {
      return true;
    }

    if (profile.cpu.arch !== hostProbe.cpuArch) {
      return true;
    }

    if (hostProbe.host.cpuModel && profile.cpu.model !== hostProbe.host.cpuModel) {
      return true;
    }

    return profile.ram.totalMb !== hostProbe.host.totalRamMb;
  }

  private shouldCheckForHostProbeRefresh(): boolean {
    if (this.hostProbeRefreshResolved) {
      return false;
    }

    const hostPlatform = this.getHostPlatform();
    return hostPlatform === 'darwin' || hostPlatform === 'win32';
  }
}
