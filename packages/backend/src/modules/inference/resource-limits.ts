const MIN_RAM_GB = 16;
const MID_RAM_GB = 32;
const HIGH_RAM_GB = 64;

const MIN_APPS = 4;
const MID_APPS = 12;
const HIGH_APPS = 24;

function lerpFloor(x: number, x0: number, y0: number, x1: number, y1: number): number {
  const ratio = (x - x0) / (x1 - x0);
  return Math.floor(y0 + ratio * (y1 - y0));
}

export function calculateMaxConcurrentApps(totalRamMb: number): number {
  const ramGb = totalRamMb / 1024;

  if (!Number.isFinite(ramGb) || ramGb <= 0) return 1;

  if (ramGb <= MIN_RAM_GB) {
    return Math.max(1, Math.floor((ramGb / MIN_RAM_GB) * MIN_APPS));
  }

  if (ramGb <= MID_RAM_GB) {
    return lerpFloor(ramGb, MIN_RAM_GB, MIN_APPS, MID_RAM_GB, MID_APPS);
  }

  if (ramGb <= HIGH_RAM_GB) {
    return lerpFloor(ramGb, MID_RAM_GB, MID_APPS, HIGH_RAM_GB, HIGH_APPS);
  }

  const aboveHigh = ramGb - HIGH_RAM_GB;
  return Math.floor(HIGH_APPS + aboveHigh * ((HIGH_APPS - MID_APPS) / (HIGH_RAM_GB - MID_RAM_GB)));
}
