export const CORE_SERVER_DISK_USAGE_THRESHOLD = 90;

export type DiskSnapshot = {
  diskUsed: number;
  diskSize: number;
};

export function isDiskUsageAboveThreshold(system: DiskSnapshot): boolean {
  if (system.diskSize <= 0) {
    return false;
  }
  return (system.diskUsed / system.diskSize) * 100 > CORE_SERVER_DISK_USAGE_THRESHOLD;
}

export function shouldShowCoreServerBanner(options: { system?: DiskSnapshot }): boolean {
  if (!options.system) {
    return false;
  }
  return isDiskUsageAboveThreshold(options.system);
}
