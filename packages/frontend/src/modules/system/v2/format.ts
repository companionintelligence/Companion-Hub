import { parseHubTimestamp } from '@/components/ui/dense/dense';
import type { LegacyTranslate } from '@/lib/i18n/legacy-translate';

/*
 * Number formatting for the Resources page. One place, so a figure reads the same on every tab.
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** `629 MB`, `3.5 GB`, `123 GB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 GB';
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1).replace(/\.0$/, '')} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export function formatMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '—';
  return formatBytes(mb * MB);
}

/** A share of the whole machine: `0.2%`, `12%`, `<0.1%`. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(value)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

type Translate = LegacyTranslate;

/**
 * `5 min ago`, `just now`, `never`, in the page's language. Read through `parseHubTimestamp`, because
 * a time from a Postgres column (a peer's `lastSeenAt`) has no zone and `Date.parse` would read it
 * as the viewer's local time.
 */
export function formatAgo(iso: string | null | undefined, now: number, t: Translate): string {
  if (!iso) return t('RESOURCES_NEVER');
  const at = parseHubTimestamp(iso);
  if (!Number.isFinite(at)) return '—';
  const ms = Math.max(0, now - at);
  if (ms < 60_000) return t('RESOURCES_JUST_NOW');
  return t('RESOURCES_AGO', { time: formatDuration(ms) });
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** The meter colour Home's resource cards use, so the same 97% looks the same on both pages. */
export function meterTone(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return 'bg-primary';
  if (percent > 90) return 'bg-destructive';
  if (percent > 70) return 'bg-warning';
  return 'bg-primary';
}

/** A round ceiling for a chart axis, so a quiet machine is not drawn as a busy one. */
export function niceCeiling(peak: number, floor: number): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const target = Math.max(peak * 1.15, floor);
  return steps.find((step) => step >= target) ?? Math.ceil(target);
}
