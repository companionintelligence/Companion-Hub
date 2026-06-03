import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';

export function formatMemoryMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export function isAmdApu(hardware: HardwareProfile): boolean {
  return hardware.gpu.available && hardware.gpu.unifiedMemory && hardware.gpu.vendor === 'amd';
}

export function isAppleSiliconGpu(hardware: HardwareProfile): boolean {
  return hardware.gpu.available && hardware.gpu.unifiedMemory && hardware.gpu.vendor === 'apple';
}

const TIER_BADGES: Record<HardwareTier, { label: string; color: string; emoji: string }> = {
  high: { label: 'High', color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', emoji: '🚀' },
  medium: { label: 'Medium', color: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', emoji: '⚡' },
  low: { label: 'Low', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', emoji: '💡' },
  'cpu-only': { label: 'CPU Only', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200', emoji: '🔧' },
  insufficient: { label: 'Insufficient', color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200', emoji: '☁️' },
};

export function resolveTierBadge(tier: HardwareTier, hardware: HardwareProfile) {
  if (isAmdApu(hardware)) {
    return {
      label: 'APU',
      color: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
      emoji: '🎮',
    };
  }
  if (isAppleSiliconGpu(hardware)) {
    return {
      label: 'Apple Silicon',
      color: 'bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-slate-200',
      emoji: '✨',
    };
  }
  return TIER_BADGES[tier];
}

export function resolveGpuSubLabel(hardware: HardwareProfile): string | undefined {
  if (!hardware.gpu.available) {
    return undefined;
  }
  if (isAmdApu(hardware)) {
    return 'APU · AMD';
  }
  return hardware.gpu.vendor.toUpperCase();
}

export type AmdHostRocmNotice = { tone: 'ready' | 'hint'; title: string; body: string };

export function resolveAmdHostRocmNotice(hardware: HardwareProfile): AmdHostRocmNotice | null {
  if (!hardware.gpu.available || hardware.gpu.vendor !== 'amd') {
    return null;
  }

  if (hardware.gpu.hostRocmAvailable) {
    return {
      tone: 'ready',
      title: 'Host ROCm detected',
      body: isAmdApu(hardware)
        ? `ROCm is available on the host for your ${hardware.gpu.model} APU. Companion Hub uses host Ollama for GPU inference; container GPU passthrough is not required.`
        : 'ROCm is available on the host. Companion Hub uses host Ollama for GPU inference; container GPU passthrough is not required.',
    };
  }

  return {
    tone: 'hint',
    title: 'AMD GPU detected',
    body: isAmdApu(hardware)
      ? `Install ROCm on the host to use your ${hardware.gpu.model} APU with host Ollama. Container GPU passthrough is optional for Companion Hub.`
      : 'Install ROCm on the host to enable GPU-accelerated host Ollama. Container GPU passthrough is optional for Companion Hub.',
  };
}

export function resolveVramDisplay(hardware: HardwareProfile): { value: string; sub?: string } {
  if (!hardware.gpu.available) {
    return { value: '—' };
  }
  if (hardware.gpu.unifiedMemory) {
    return {
      value: formatMemoryMb(hardware.ram.totalMb),
      sub: isAmdApu(hardware) ? 'Shared · APU' : 'Unified Memory',
    };
  }
  return { value: formatMemoryMb(hardware.gpu.vramMb) };
}
