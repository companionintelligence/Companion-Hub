import type { SystemSnapshot } from './core-server-banner';

/** Thresholds for "low spec" detection — shared with banner copy selection. */
export const CORE_SERVER_LOW_RAM_GB = 8;
export const CORE_SERVER_LOW_DISK_GB = 100;
export const CORE_SERVER_LOW_CPU_CORES = 2;

/** Companion Core Server units use FRANM-prefixed serials as device IDs. */
const COMPANION_CORE_DEVICE_ID_PREFIX = 'FRANM';

export type ClientPlatform = 'windows' | 'macos' | 'linux';

export function detectClientPlatform(): ClientPlatform {
  const ua = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

export function isCompanionCoreDevice(deviceId: string | undefined | null): boolean {
  const id = deviceId?.trim().toUpperCase();
  return Boolean(id?.startsWith(COMPANION_CORE_DEVICE_ID_PREFIX));
}

export function isBelowCoreServerHardwareThresholds(system: SystemSnapshot): boolean {
  return system.memoryTotal < CORE_SERVER_LOW_RAM_GB || system.diskSize < CORE_SERVER_LOW_DISK_GB || system.cpuCores <= CORE_SERVER_LOW_CPU_CORES;
}

/**
 * Upsell banner: macOS/Windows clients with below-threshold hardware only.
 * Never shown on Linux or Companion Core Server devices (FRANM serials).
 */
export function shouldShowCoreServerBanner(options: { clientPlatform: ClientPlatform; deviceId?: string | null; system?: SystemSnapshot }): boolean {
  if (options.clientPlatform === 'linux') {
    return false;
  }
  if (options.clientPlatform !== 'windows' && options.clientPlatform !== 'macos') {
    return false;
  }
  if (isCompanionCoreDevice(options.deviceId)) {
    return false;
  }
  if (!options.system) {
    return false;
  }
  return isBelowCoreServerHardwareThresholds(options.system);
}
