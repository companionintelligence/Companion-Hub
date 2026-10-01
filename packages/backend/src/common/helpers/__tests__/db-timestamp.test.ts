import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDbTimestampMs } from '../db-timestamp';

describe('parseDbTimestampMs', () => {
  // A zone that is not UTC, wherever the suite runs: on a UTC machine, reading the value as local
  // time would pass by accident. Node applies a TZ change to `Date` at once.
  const savedTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it('reads the zoneless value Postgres returns as the UTC time the Hub wrote', () => {
    // The Hub stores `new Date().toISOString()` in a `timestamp without time zone` column, and
    // reads back `2026-10-01 12:34:56.789`. `new Date()` would read that in the container's zone.
    expect(parseDbTimestampMs('2026-10-01 12:34:56.789')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56, 789));
    expect(parseDbTimestampMs('2026-10-01 12:34:56')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
    expect(parseDbTimestampMs(' 2026-10-01T12:34:56.789 ')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56, 789));
  });

  it('reads a value that names its zone as written', () => {
    expect(parseDbTimestampMs('2026-10-01T12:34:56.789Z')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56, 789));
    expect(parseDbTimestampMs('2026-10-01 14:34:56+02')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
    expect(parseDbTimestampMs('2026-10-01T07:34:56-05:00')).toBe(Date.UTC(2026, 9, 1, 12, 34, 56));
  });

  it('answers NaN, not a date, for something that is not a timestamp', () => {
    expect(parseDbTimestampMs('not a date')).toBeNaN();
  });
});
