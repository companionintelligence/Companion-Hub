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

// NOT migrated to @companionintelligence/tokens' new `--level-*` scale (unlike
// ai-setup/levels.ts and recommendations-step.tsx, see companionintelligence/CI-Common#217):
// this tier order is green(best) -> sky -> yellow -> orange -> red(worst), while `--level-*`
// runs red -> orange -> gold -> green -> blue with green in the MIDDLE, not best. Forcing
// this onto that scale would either put "high" on blue (breaking every "green = good"
// reading elsewhere in this file, e.g. resourceColor in ai-setup/levels.ts) or leave it on
// green while reusing the level palette's *different* green — a real polarity conflict, not
// a hex to swap. Needs a decision on canonical direction before this can migrate.
const TIER_BADGES: Record<HardwareTier, { labelKey: string; dot: string }> = {
  high: { labelKey: 'ONBOARDING_TIER_HIGH', dot: 'bg-success' },
  medium: { labelKey: 'ONBOARDING_TIER_MEDIUM', dot: 'bg-primary' },
  low: { labelKey: 'ONBOARDING_TIER_LOW', dot: 'bg-warning' },
  'cpu-only': { labelKey: 'ONBOARDING_TIER_CPU_ONLY', dot: 'bg-warning' },
  insufficient: { labelKey: 'ONBOARDING_TIER_INSUFFICIENT', dot: 'bg-destructive' },
};

export function resolveTierBadge(tier: HardwareTier, hardware: HardwareProfile) {
  if (isAmdApu(hardware)) {
    return { label: i18next.t('ONBOARDING_TIER_APU'), dot: 'bg-primary' };
  }
  if (isAppleSiliconGpu(hardware)) {
    return { label: i18next.t('COMMON_APPLE_SILICON'), dot: 'bg-muted-foreground' };
  }
  const tierBadge = TIER_BADGES[tier];
  return {
    label: i18next.t(tierBadge.labelKey),
    dot: tierBadge.dot,
  };
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

  if (hardware.gpu.hostRocmKfdAvailable ?? hardware.gpu.hostRocmAvailable) {
    return {
      tone: 'ready',
      title: i18next.t('AI_ROCM_DETECTED_TITLE'),
      body: isAmdApu(hardware) ? i18next.t('AI_ROCM_DETECTED_APU_BODY', { model: hardware.gpu.model }) : i18next.t('AI_ROCM_DETECTED_BODY'),
    };
  }

  return {
    tone: 'hint',
    title: i18next.t('AI_ROCM_AMD_DETECTED_TITLE'),
    body: isAmdApu(hardware) ? i18next.t('AI_ROCM_AMD_DETECTED_APU_BODY', { model: hardware.gpu.model }) : i18next.t('AI_ROCM_AMD_DETECTED_BODY'),
  };
}

/**
 * The VRAM tile. On unified memory it is what the GPU can address (`gpu.vramMb`): on an AMD APU the
 * driver's carve-out plus GTT, which is less than the machine's RAM; on Apple Silicon all of it. A
 * discrete card whose memory the Hub could not read (`vramMb` 0) says so instead of "0 MB".
 */
export function resolveVramDisplay(hardware: HardwareProfile): { value: string; sub?: string } {
  if (!hardware.gpu.available) {
    return { value: i18next.t('COMMON_DASH') };
  }
  if (hardware.gpu.unifiedMemory) {
    return {
      value: formatMemoryMb(hardware.gpu.vramMb > 0 ? hardware.gpu.vramMb : hardware.ram.totalMb),
      sub: isAmdApu(hardware) ? i18next.t('ONBOARDING_SHARED_APU') : i18next.t('ONBOARDING_UNIFIED_MEMORY'),
    };
  }
  if (hardware.gpu.vramMb <= 0) {
    return { value: i18next.t('COMMON_UNKNOWN') };
  }
  return { value: formatMemoryMb(hardware.gpu.vramMb) };
}
