import { describe, expect, it } from 'vitest';
import { formatAgo, formatBytes, formatDuration, formatMb, formatPercent, meterTone, niceCeiling } from '../format';

const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);

describe('Resources number formatting', () => {
  it('writes sizes the way Home does', () => {
    expect(formatBytes(659_394_560)).toBe('629 MB');
    expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB');
    expect(formatBytes(48 * 1024 ** 3)).toBe('48 GB');
    expect(formatBytes(123 * 1024 ** 3)).toBe('123 GB');
    expect(formatBytes(0)).toBe('0 GB');
    expect(formatBytes(null)).toBe('—');
    expect(formatMb(5847)).toBe('5.7 GB');
  });

  it('keeps a tiny share distinct from none', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.04)).toBe('<0.1%');
    expect(formatPercent(1.07)).toBe('1.1%');
    expect(formatPercent(91.3)).toBe('91%');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('writes durations short', () => {
    expect(formatDuration(780)).toBe('780 ms');
    expect(formatDuration(6_200)).toBe('6.2 s');
    expect(formatDuration(10 * 60_000)).toBe('10 min');
    expect(formatDuration(20 * 3_600_000)).toBe('20 h');
    expect(formatDuration(3 * 86_400_000)).toBe('3 d');
  });

  it('says how long ago in the page language', () => {
    const now = Date.parse('2026-11-12T05:00:00Z');
    expect(formatAgo(null, now, t)).toBe('RESOURCES_NEVER');
    expect(formatAgo('2026-11-12T04:59:30Z', now, t)).toBe('RESOURCES_JUST_NOW');
    expect(formatAgo('2026-11-12T04:50:00Z', now, t)).toBe('RESOURCES_AGO:{"time":"10 min"}');
  });

  it('colours a meter as Home does', () => {
    expect(meterTone(40)).toBe('bg-primary');
    expect(meterTone(75)).toBe('bg-warning');
    expect(meterTone(97)).toBe('bg-destructive');
  });

  it('never scales a quiet machine to look busy', () => {
    expect(niceCeiling(1.8, 10)).toBe(10);
    expect(niceCeiling(23, 10)).toBe(50);
    expect(niceCeiling(96, 10)).toBe(200);
  });
});
