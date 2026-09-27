import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compactTokens, DASH, humanBytes, humanCount, humanDuration, parseHubTimestamp, relativeAge, relativeUntil } from './dense';

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

describe('humanDuration', () => {
  it('prints each duration in the unit a person reads it in', () => {
    expect(humanDuration(850)).toBe('850 ms');
    expect(humanDuration(12_500)).toBe('12.5 s');
    // core-2's slowest first byte, which the feed used to print as "399710ms".
    expect(humanDuration(399_710)).toBe('6m 40s');
    expect(humanDuration(7 * 3_600_000 + 16 * 60_000)).toBe('7h 16m');
  });

  it('rounds before choosing a unit, so a value at a boundary never prints as "1000 ms" or "60.0 s"', () => {
    expect(humanDuration(999.7)).toBe('1.0 s');
    expect(humanDuration(59_960)).toBe('1m 0s');
  });

  it('renders a dash for a duration nobody measured', () => {
    expect(humanDuration(null)).toBe(DASH);
    expect(humanDuration(undefined)).toBe(DASH);
    expect(humanDuration(Number.NaN)).toBe(DASH);
  });
});

describe('compactTokens', () => {
  it('shortens a prompt-size estimate', () => {
    expect(compactTokens(850)).toBe('850');
    expect(compactTokens(7_641)).toBe('7.6k');
    expect(compactTokens(38_979)).toBe('39k');
    expect(compactTokens(null)).toBe(DASH);
  });
});

describe('parseHubTimestamp', () => {
  it("reads a zoneless timestamp from a Postgres column as UTC, not as the browser's local time", () => {
    // fzzy's restored history, 2026-09-27: the chart labelled this "10:22 AM" in a PDT browser.
    expect(parseHubTimestamp('2026-09-27 10:22:22.896')).toBe(Date.parse('2026-09-27T10:22:22.896Z'));
    expect(parseHubTimestamp('2026-09-27T10:22:22')).toBe(Date.parse('2026-09-27T10:22:22Z'));
  });

  it('leaves a timestamp that names its zone at the instant it names', () => {
    expect(parseHubTimestamp('2026-09-27T16:55:51.867513154-07:00')).toBe(Date.parse('2026-09-27T23:55:51.867Z'));
  });

  it('is NaN for nothing at all, so callers fall through to their dash', () => {
    expect(parseHubTimestamp(null)).toBeNaN();
    expect(parseHubTimestamp('')).toBeNaN();
  });
});

describe('relativeUntil', () => {
  it('counts down to an engine expiry written with an offset and nanoseconds, as Ollama writes it', () => {
    expect(relativeUntil('2026-09-27T16:55:51.867513154-07:00', Date.parse('2026-09-27T18:00:54Z'))).toBe('6h');
  });

  /*
   * The case `parseHubTimestamp` changed. An offset (above) parsed the same either way; a ZONELESS
   * Hub timestamp — Postgres `timestamp` columns, as the telemetry table serves them — is UTC, and
   * `Date.parse` alone read it as browser-local. Pinned west of UTC because CI runs in UTC, where the
   * two readings coincide and this would pass against the bug.
   */
  describe('in a browser west of UTC', () => {
    beforeAll(() => {
      vi.stubEnv('TZ', 'America/Los_Angeles');
    });
    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('reads a zoneless Hub timestamp as UTC, not as browser-local time', () => {
      const now = Date.parse('2026-09-27T18:00:54Z');
      // The pin took: read as local time, the same string is seven hours later.
      expect(Date.parse('2026-09-27T23:55:51')).toBe(Date.parse('2026-09-28T06:55:51Z'));

      expect(relativeUntil('2026-09-27 23:55:51', now)).toBe('6h');
      // The `T` form too, which `relativeAge` used to hand to `Date.parse` as it was.
      expect(relativeAge('2026-09-27T17:55:54', now)).toBe('5m');
    });
  });
});
