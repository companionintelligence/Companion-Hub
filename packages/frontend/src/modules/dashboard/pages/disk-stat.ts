import type { TFunction } from 'i18next';

export type DiskLoad = {
  diskUsed: number;
  diskSize: number;
  percentUsed: number;
  platformGuidance?: string;
};

export type DiskStatCopy = {
  metric: string;
  subtitle: string;
  progress: number;
};

/**
 * A zero-size disk is the VM not reporting a volume, not an empty drive.
 * The load payload already explains that; the chart should say so.
 */
export const diskStatCopy = (load: DiskLoad, t: TFunction): DiskStatCopy => {
  if (load.diskSize === 0 && load.platformGuidance) {
    return {
      metric: t('DASHBOARD_UNAVAILABLE'),
      subtitle: load.platformGuidance,
      progress: 0,
    };
  }

  return {
    metric: `${load.percentUsed}%`,
    subtitle: t('DASHBOARD_GB_OF', { used: load.diskUsed, total: load.diskSize }),
    progress: load.percentUsed,
  };
};
