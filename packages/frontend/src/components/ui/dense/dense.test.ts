import { describe, expect, it } from 'vitest';
import { DASH, humanBytes, humanCount, relativeAge } from './dense';

/*
 * The formatting helpers, which carry the dashboard's absence-vs-zero contract.
 *
 * Every one of these takes null or undefined and must render a dash. That is not a
 * cosmetic preference: "0 B" and "we could not read it" are read as the same thing on a
 * monitoring page, and only one of them is ever true.
 */

describe('humanBytes', () => {
  it('scales through the units', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(humanBytes(20 * 1024 ** 2)).toBe('20 MB');
  });

  it('renders a dash, not "0 B", when the value was never measured', () => {
    expect(humanBytes(null)).toBe(DASH);
    expect(humanBytes(undefined)).toBe(DASH);
    expect(humanBytes(Number.NaN)).toBe(DASH);
  });

  it('still renders a real measured zero as a number', () => {
    expect(humanBytes(0)).toBe('0 B');
  });
});

describe('humanCount', () => {
  it('separates an unread counter from an idle one', () => {
    expect(humanCount(0)).toBe('0');
    expect(humanCount(null)).toBe(DASH);
    expect(humanCount(undefined)).toBe(DASH);
  });
});

describe('relativeAge', () => {
  const now = Date.parse('2026-09-10T02:31:00.000Z');

  it('shortens an age to its largest useful unit', () => {
    expect(relativeAge('2026-09-10T02:30:50.000Z', now)).toBe('10s');
    expect(relativeAge('2026-09-10T02:26:00.000Z', now)).toBe('5m');
    expect(relativeAge('2026-09-10T00:31:00.000Z', now)).toBe('2h');
    expect(relativeAge('2026-09-07T02:31:00.000Z', now)).toBe('3d');
  });

  it('reads the space-separated timestamps the peer table stores as UTC', () => {
    // hub_pool_peer.last_seen_at comes back as "2026-09-10 02:30:55.100" with no zone;
    // parsing it as local time would show a peer seen seconds ago as hours stale.
    expect(relativeAge('2026-09-10 02:30:55.100', now)).toBe('5s');
  });

  it('renders a dash for a missing or unparseable timestamp', () => {
    expect(relativeAge(null, now)).toBe(DASH);
    expect(relativeAge(undefined, now)).toBe(DASH);
    expect(relativeAge('not-a-date', now)).toBe(DASH);
  });

  it('never reports a negative age from a peer whose clock runs ahead', () => {
    expect(relativeAge('2026-09-10T02:35:00.000Z', now)).toBe('0s');
  });
});
