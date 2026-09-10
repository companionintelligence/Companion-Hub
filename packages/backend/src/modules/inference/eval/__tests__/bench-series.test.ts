/**
 * The measurement plumbing: the one rate-rounding rule, and the ring buffer the statistics are read
 * from.
 *
 * `ratePerSec` is the single place a throughput number is produced, so its boundary behaviour is the
 * boundary behaviour of every tokens/sec and chars/sec figure the tool prints. The contract it has
 * to keep is not "round to one decimal" — it is that a value only comes back when a rate was
 * actually measured, because anything that renders as a number in a throughput chart is read as a
 * measurement.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConcurrencySeries,
  DEFAULT_SAMPLE_CAP,
  DEFAULT_SAMPLE_INTERVAL_MS,
  MIN_SAMPLE_CAP,
  MIN_SAMPLE_INTERVAL_MS,
  ratePerSec,
} from '../bench-series';

describe('ratePerSec', () => {
  it('rounds to exactly one decimal', () => {
    expect(ratePerSec(100, 1000)).toBe(100);
    expect(ratePerSec(1, 3000)).toBe(0.3);
    expect(ratePerSec(2, 3000)).toBe(0.7);
    expect(ratePerSec(1000, 999)).toBe(1001);
    // 1/8 s of a single token is 8/s exactly; the interesting case is one that does not divide.
    expect(ratePerSec(7, 900)).toBe(7.8);
  });

  it('rounds half away from zero at the .05 boundary', () => {
    // The boundary that decides whether two adjacent runs print the same number. 1.25 -> 1.3, and
    // the tie must not silently become 1.2 on some inputs and 1.3 on others.
    expect(ratePerSec(1.25, 1000)).toBe(1.3);
    expect(ratePerSec(1.35, 1000)).toBe(1.4);
    expect(ratePerSec(0.05, 1000)).toBe(0.1);
    expect(ratePerSec(0.04999, 1000)).toBe(0);
  });

  it('returns 0 for a real zero and null for an absent count', () => {
    // A backend that generated nothing measurably is not the same as a backend that reported no
    // usage at all, and the two must not render alike.
    expect(ratePerSec(0, 1000)).toBe(0);
    expect(ratePerSec(Number.NaN, 1000)).toBeNull();
    expect(ratePerSec(Number.POSITIVE_INFINITY, 1000)).toBeNull();
  });

  it('never divides by a duration that is zero or negative', () => {
    // Producing Infinity here would put "produced 40 tokens instantaneously" into a chart.
    expect(ratePerSec(40, 0)).toBeNull();
    expect(ratePerSec(40, -1)).toBeNull();
  });

  it('returns null rather than NaN when the duration itself is not a number', () => {
    // A duration computed from a missing timestamp arrives as NaN, and NaN passes a `<= 0` guard.
    // The contract is that an unmeasurable rate is absent, not a value that renders as "NaN".
    expect(ratePerSec(40, Number.NaN)).toBeNull();
    expect(ratePerSec(40, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('ConcurrencySeries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps cadence and buffer length to values that can show a queue', () => {
    const tooFast = new ConcurrencySeries({ intervalMs: 10, cap: 2 });
    expect(tooFast.intervalMs).toBe(MIN_SAMPLE_INTERVAL_MS);
    expect(tooFast.cap).toBe(MIN_SAMPLE_CAP);
    const defaults = new ConcurrencySeries();
    expect(defaults.intervalMs).toBe(DEFAULT_SAMPLE_INTERVAL_MS);
    expect(defaults.cap).toBe(DEFAULT_SAMPLE_CAP);
  });

  it('keeps the most recent samples when the ring buffer overflows', () => {
    // A run longer than the cap must lose its opening samples, never its recent ones — the recent
    // end is the half a saturation reading is computed from.
    const series = new ConcurrencySeries({ cap: MIN_SAMPLE_CAP });
    for (let i = 0; i < MIN_SAMPLE_CAP + 10; i++) series.record({ inFlight: i, queued: 0, perTarget: {} });
    const samples = series.samples();
    expect(samples).toHaveLength(MIN_SAMPLE_CAP);
    expect(samples[0]?.inFlight).toBe(10);
    expect(samples[samples.length - 1]?.inFlight).toBe(MIN_SAMPLE_CAP + 9);
  });

  it('records the terminal sample after the timer has stopped', () => {
    // The draining-queue sample is taken on the completion path, where the sampler is already
    // stopped. Gating `record` on a live timer would drop it on every single run.
    const series = new ConcurrencySeries();
    series.record({ inFlight: 3, queued: 2, perTarget: { 'target-a': [3, 2] } });
    series.stop();
    expect(series.sampling).toBe(false);
    const terminal = series.record({ inFlight: 0, queued: 0, perTarget: {} });
    expect(series.samples()).toHaveLength(2);
    expect(terminal.inFlight).toBe(0);
    expect(terminal.ts).toBeGreaterThan(0);
  });

  it('runs one sampler at a time and stops idempotently', () => {
    vi.useFakeTimers();
    const series = new ConcurrencySeries({ intervalMs: MIN_SAMPLE_INTERVAL_MS });
    const first = vi.fn();
    const second = vi.fn();
    series.start(first);
    series.start(second);
    expect(series.sampling).toBe(true);
    vi.advanceTimersByTime(MIN_SAMPLE_INTERVAL_MS * 3);
    // A replaced sampler must actually be replaced: two live timers would double every sample.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(3);
    series.stop();
    series.stop();
    expect(series.sampling).toBe(false);
    vi.advanceTimersByTime(MIN_SAMPLE_INTERVAL_MS * 3);
    expect(second).toHaveBeenCalledTimes(3);
  });

  it('is per-run state, so one run never reads the buffer of another', () => {
    const a = new ConcurrencySeries();
    const b = new ConcurrencySeries();
    a.record({ inFlight: 1, queued: 0, perTarget: {} });
    expect(b.samples()).toEqual([]);
    a.reset();
    expect(a.samples()).toEqual([]);
  });
});
