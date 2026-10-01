/**
 * Milliseconds since the epoch for a `timestamp` column read in Drizzle's `string` mode.
 *
 * Postgres returns the zoneless `updated_at` value with a space (`2026-10-01 12:34:56.789`), which
 * `Date` otherwise reads in local time. The Hub writes these columns from `new Date().toISOString()`,
 * so the stored wall time is UTC: reading it as UTC keeps every comparison independent of the
 * container's timezone. A value that already names its zone is read as written.
 */
export function parseDbTimestampMs(value: string): number {
  const trimmed = value.trim();
  const hasZone = /[Zz]$|[+-]\d\d(:?\d\d)?$/.test(trimmed);
  return new Date(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`).getTime();
}
