import { describe, expect, it } from 'vitest';
import { BASE_QUARANTINE_MS, MAX_QUARANTINE_MS, QUARANTINE_STRIKES, STRIKE_WINDOW_MS, ServingQuarantine } from '../backends/serving-quarantine';

/** A clock the test drives, so the 15-minute ceiling costs a variable assignment rather than 15 minutes. */
function atClock(): { quarantine: ServingQuarantine; advance: (ms: number) => void } {
  let now = 1_700_000_000_000;
  return {
    quarantine: new ServingQuarantine(() => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ServingQuarantine', () => {
  const MODEL = 'gemma3:1b';

  it('withholds nothing until the strike threshold is reached', () => {
    const { quarantine } = atClock();

    for (let strike = 1; strike < QUARANTINE_STRIKES; strike += 1) {
      expect(quarantine.recordFailure(MODEL, 'HTTP 500').withheld).toBe(false);
      expect(quarantine.isWithheld(MODEL)).toBe(false);
    }

    expect(quarantine.recordFailure(MODEL, 'HTTP 500')).toMatchObject({ withheld: true, forMs: BASE_QUARANTINE_MS });
    expect(quarantine.list()).toEqual([MODEL]);
  });

  it('takes a decisive observation on its own', () => {
    const { quarantine } = atClock();

    // What a rejected explicit load is worth: that request asked the engine to do nothing but load
    // the model, so there is no second reading to wait for.
    expect(quarantine.recordFailure(MODEL, 'load returned HTTP 500', QUARANTINE_STRIKES).withheld).toBe(true);
  });

  it('forgets strikes that stop arriving', () => {
    const { quarantine, advance } = atClock();

    quarantine.recordFailure(MODEL, 'HTTP 500');
    advance(STRIKE_WINDOW_MS + 1);

    // Two failures an hour apart are two blips, not a pattern.
    expect(quarantine.recordFailure(MODEL, 'HTTP 500').withheld).toBe(false);
    expect(quarantine.isWithheld(MODEL)).toBe(false);
  });

  it('doubles the wait each time the model is re-probed and fails again, up to the ceiling', () => {
    const { quarantine, advance } = atClock();
    const waits: number[] = [];

    quarantine.recordFailure(MODEL, 'HTTP 500');
    waits.push(quarantine.recordFailure(MODEL, 'HTTP 500').forMs);
    for (let round = 0; round < 6; round += 1) {
      advance(waits[waits.length - 1] + 1);
      // One failure now settles it: this model has already been withheld, so the re-probe is the test.
      waits.push(quarantine.recordFailure(MODEL, 'HTTP 500').forMs);
    }

    expect(waits.slice(0, 5)).toEqual([
      BASE_QUARANTINE_MS,
      2 * BASE_QUARANTINE_MS,
      4 * BASE_QUARANTINE_MS,
      8 * BASE_QUARANTINE_MS,
      MAX_QUARANTINE_MS,
    ]);
    // Capped, not unbounded: a node that comes back is re-probed at least this often.
    expect(waits[waits.length - 1]).toBe(MAX_QUARANTINE_MS);
  });

  it('offers the model again the moment the wait expires', () => {
    const { quarantine, advance } = atClock();
    quarantine.recordFailure(MODEL, 'HTTP 500');
    quarantine.recordFailure(MODEL, 'HTTP 500');

    advance(BASE_QUARANTINE_MS + 1);

    expect(quarantine.isWithheld(MODEL)).toBe(false);
    expect(quarantine.list()).toEqual([]);
  });

  it('drops the backoff entirely on proof the model can be served', () => {
    const { quarantine, advance } = atClock();
    quarantine.recordFailure(MODEL, 'HTTP 500');
    quarantine.recordFailure(MODEL, 'HTTP 500');

    expect(quarantine.recordSuccess(MODEL)).toBe(true);
    advance(1);

    // Back to a clean slate, not to round two: the next incident starts at one strike and the base
    // wait. Recovery must not be taxed for a fault the operator has fixed.
    expect(quarantine.recordFailure(MODEL, 'HTTP 500').withheld).toBe(false);
    expect(quarantine.recordFailure(MODEL, 'HTTP 500').forMs).toBe(BASE_QUARANTINE_MS);
  });

  it('forgets a model that has been back on offer, unpunished, for a full strike window', () => {
    const { quarantine, advance } = atClock();
    quarantine.recordFailure(MODEL, 'HTTP 500');
    quarantine.recordFailure(MODEL, 'HTTP 500');

    advance(BASE_QUARANTINE_MS + STRIKE_WINDOW_MS + 1);

    // Nothing has failed since it was re-offered, so there is no longer evidence against it — and
    // the map going empty is what takes the extra /api/ps probe back off the health poll.
    expect(quarantine.isEmpty()).toBe(true);
    expect(quarantine.recordFailure(MODEL, 'HTTP 500').withheld).toBe(false);
  });

  it('keeps each model verdict to itself', () => {
    const { quarantine } = atClock();

    quarantine.recordFailure(MODEL, 'HTTP 500');
    quarantine.recordFailure(MODEL, 'HTTP 500');

    expect(quarantine.isWithheld('qwen3:8b')).toBe(false);
    expect(quarantine.reasonFor(MODEL)).toBe('HTTP 500');
    expect(quarantine.reasonFor('qwen3:8b')).toBeUndefined();
  });
});
