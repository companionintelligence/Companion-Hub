import type { HardwareProfile, HardwareTier } from '@ci-hub/common/types';
import i18next from 'i18next';

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
  high: { label: i18next.t('ONBOARDING_TIER_HIGH'), color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200', emoji: '🚀' },
  medium: { label: i18next.t('ONBOARDING_TIER_MEDIUM'), color: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', emoji: '⚡' },
  low: { label: i18next.t('ONBOARDING_TIER_LOW'), color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200', emoji: '💡' },
  'cpu-only': {
    label: i18next.t('ONBOARDING_TIER_CPU_ONLY'),
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    emoji: '🔧',
  },
  insufficient: { label: i18next.t('ONBOARDING_TIER_INSUFFICIENT'), color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200', emoji: '☁️' },
};

export function resolveTierBadge(tier: HardwareTier, hardware: HardwareProfile) {
  if (isAmdApu(hardware)) {
    return {
      label: i18next.t('ONBOARDING_TIER_APU'),
      color: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
      emoji: '🎮',
    };
  }
  if (isAppleSiliconGpu(hardware)) {
    return {
      label: i18next.t('COMMON_APPLE_SILICON'),
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
    return i18next.t('ONBOARDING_APU_AMD_LABEL');
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
      title: i18next.t('ONBOARDING_HOST_ROCM_DETECTED'),
      body: isAmdApu(hardware)
        ? i18next.t('ONBOARDING_HOST_ROCM_DETECTED_APU_BODY', { model: hardware.gpu.model })
        : i18next.t('ONBOARDING_HOST_ROCM_DETECTED_BODY'),
    };
  }

  return {
    tone: 'hint',
    title: i18next.t('ONBOARDING_AMD_GPU_DETECTED'),
    body: isAmdApu(hardware)
      ? i18next.t('ONBOARDING_AMD_GPU_DETECTED_APU_BODY', { model: hardware.gpu.model })
      : i18next.t('ONBOARDING_AMD_GPU_DETECTED_BODY'),
  };
}

export function resolveVramDisplay(hardware: HardwareProfile): { value: string; sub?: string } {
  if (!hardware.gpu.available) {
    return { value: i18next.t('COMMON_DASH') };
  }
  if (hardware.gpu.unifiedMemory) {
    return {
      value: formatMemoryMb(hardware.ram.totalMb),
      sub: isAmdApu(hardware) ? i18next.t('ONBOARDING_SHARED_APU') : i18next.t('ONBOARDING_UNIFIED_MEMORY'),
    };
  }
  return { value: formatMemoryMb(hardware.gpu.vramMb) };
}
