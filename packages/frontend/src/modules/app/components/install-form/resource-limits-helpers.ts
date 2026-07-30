/**
 * Shared bounds/formatting helpers for the CPU + memory resource sliders in the install wizard.
 * Mirrors the compose-time contract in packages/backend/src/common/validation/{cpu,memory}-limit.ts
 * and the auto-allocation policy in packages/backend/src/modules/system/resource-allocator.service.ts.
 */

export const CPU_LIMIT_MIN = 0.1;
export const CPU_LIMIT_STEP = 0.1;
/** Used only when the Docker capacity probe (GET /system/resources) hasn't returned yet or failed. */
export const CPU_LIMIT_FALLBACK_MAX = 8;
export const CPU_LIMIT_FALLBACK_DEFAULT = 1;

export const MEMORY_LIMIT_MIN_MB = 128;
export const MEMORY_LIMIT_STEP_MB = 128;
/** Used only when the Docker capacity probe hasn't returned yet or failed. */
export const MEMORY_LIMIT_FALLBACK_MAX_MB = 8192;
export const MEMORY_LIMIT_FALLBACK_DEFAULT_MB = 1024;

const MEMORY_UNIT_TO_MB: Record<string, number> = {
  '': 1 / (1024 * 1024), // bare bytes
  k: 1 / 1024,
  m: 1,
  g: 1024,
};

/** Parses a compose-style memory limit ("2048M", "2g", "512m") into whole megabytes. */
export function parseMemoryLimitToMb(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([kmg]?)b?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const unitMultiplier = MEMORY_UNIT_TO_MB[unit];
  if (unitMultiplier === undefined) return undefined;
  return Math.round(amount * unitMultiplier);
}

/** Formats whole megabytes back into the compose-style string the backend expects (e.g. "2048M"). */
export function formatMemoryLimitMb(mb: number): string {
  return `${Math.max(1, Math.round(mb))}M`;
}

/** Formats a CPU core count into the plain decimal string the backend expects (e.g. "1.5"). */
export function formatCpuLimit(cores: number): string {
  return String(Math.round(Math.max(0, cores) * 100) / 100);
}

export function formatMemoryReadout(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

export function formatCpuReadout(cores: number): string {
  const rounded = Math.round(cores * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'core' : 'cores'}`;
}
