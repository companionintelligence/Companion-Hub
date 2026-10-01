import { afterEach, describe, expect, it } from 'vitest';
import { parseDbTimestampMs } from '../db-timestamp';

const EXPECTED = Date.UTC(2026, 9, 1, 10, 0, 0);
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) {
    process.env.TZ = undefined as unknown as string;
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

// The process zone is what the bug was about: the Hub container runs in the host's.
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Karachi', 'Asia/Kolkata', 'Pacific/Auckland'];

describe('parseDbTimestampMs', () => {
  describe.each(ZONES)('in a process running in %s', (zone) => {
    const inZone = <T>(fn: () => T): T => {
      process.env.TZ = zone;
      return fn();
    };

    it('reads a zoneless Postgres timestamp as UTC', () => {
      expect(inZone(() => parseDbTimestampMs('2026-10-01 10:00:00'))).toBe(EXPECTED);
    });

    it('keeps the fractional seconds of a zoneless timestamp', () => {
      expect(inZone(() => parseDbTimestampMs('2026-10-01 10:00:00.123456'))).toBe(EXPECTED + 123);
    });

    it('reads a zoneless ISO timestamp as UTC', () => {
      expect(inZone(() => parseDbTimestampMs('2026-10-01T10:00:00'))).toBe(EXPECTED);
    });

    it.each([
      ['an ISO string ending in Z', '2026-10-01T10:00:00.000Z', 0],
      ['a lowercase z', '2026-10-01T10:00:00z', 0],
      ['a timestamptz with a short offset', '2026-10-01 10:00:00+00', 0],
      ['a timestamptz with an hour offset', '2026-10-01 12:00:00+02', 0],
      ['a timestamptz with an hour and minute offset', '2026-10-01 15:30:00+05:30', 0],
      ['a timestamptz with a negative offset', '2026-10-01 05:00:00-05', 0],
      ['an offset without a colon', '2026-10-01T12:00:00+0200', 0],
    ])('reads %s exactly as written', (_name, text) => {
      expect(inZone(() => parseDbTimestampMs(text))).toBe(EXPECTED);
    });

    it('reads a bare date as UTC midnight', () => {
      expect(inZone(() => parseDbTimestampMs('2026-10-01'))).toBe(Date.UTC(2026, 9, 1));
    });
  });

  it('is what separates the old reading from the right one: Date.parse of the same text moves with the zone', () => {
    process.env.TZ = 'America/New_York';
    const old = Date.parse('2026-10-01 10:00:00');
    process.env.TZ = 'Asia/Karachi';
    const other = Date.parse('2026-10-01 10:00:00');

    expect(old).not.toBe(other);
    expect(parseDbTimestampMs('2026-10-01 10:00:00')).toBe(EXPECTED);
  });

  it.each([null, undefined, '', '   ', 'not a date', '2026-13-45 99:99:99'])('returns NaN for %j, as Date.parse does', (value) => {
    expect(parseDbTimestampMs(value)).toBeNaN();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDbTimestampMs('  2026-10-01 10:00:00 ')).toBe(EXPECTED);
  });
});
