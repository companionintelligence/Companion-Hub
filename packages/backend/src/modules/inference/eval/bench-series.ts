/**
 * Measurement plumbing for a benchmark run: the concurrency/queue time series, its cadence, and the
 * one place a rate is turned into a number.
 *
 * What this file is NOT is the statistics — those live in `bench-stats.ts`, which consumes exactly
 * the sample shape produced here. Keeping the arithmetic in one place is deliberate: a second copy
 * of a rate calculation is two numbers that agree today and diverge silently later.
 *
 * Two things worth knowing before touching the series:
 *
 *   · The ring buffer is capped (~15 minutes at the 1s default). A run longer than the cap loses its
 *     opening samples, not its recent ones.
 *   · The TERMINAL sample — 0 in flight, 0 queued — must be recorded by the driver AFTER the timer
 *     is stopped. Guarding that record on the timer still being live drops the one sample that shows
 *     the queue draining, on every single run.
 *
 * The rules that make a comparison valid — pairing by prompt, interleaving arms, serializing per
 * target — are not enforceable here, because they are properties of how a run is CONSTRUCTED, not of
 * how a sample is stored. They live in `bench-ab.ts`.
 */

/** Default cadence of the concurrency/queue-depth series (ms). */
export const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
/** Default ring-buffer length — 900 x 1s is roughly 15 minutes of history. */
export const DEFAULT_SAMPLE_CAP = 900;

/** Sampling faster than this buys noise, not resolution. */
export const MIN_SAMPLE_INTERVAL_MS = 250;
/** A buffer shorter than this cannot show a queue forming and draining. */
export const MIN_SAMPLE_CAP = 60;

export interface ConcurrencySample {
  /** Epoch ms the observation was taken. */
  ts: number;
  inFlight: number;
  queued: number;
  /** Per target: `[inFlight, queued]`. Keyed by whatever the driver calls a target. */
  perTarget: Record<string, [number, number]>;
}

export interface ConcurrencySeriesOptions {
  intervalMs?: number;
  cap?: number;
}

/**
 * One run's concurrency series.
 *
 * An instance rather than module-level state: two runs must never share a buffer, and a series from
 * a previous run says nothing about this one.
 */
export class ConcurrencySeries {
  readonly intervalMs: number;
  readonly cap: number;

  #series: ConcurrencySample[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ConcurrencySeriesOptions = {}) {
    this.intervalMs = Math.max(MIN_SAMPLE_INTERVAL_MS, Number(opts.intervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
    this.cap = Math.max(MIN_SAMPLE_CAP, Number(opts.cap) || DEFAULT_SAMPLE_CAP);
  }

  /** The live series. Read by snapshot consumers; never mutated by the reader. */
  samples(): readonly ConcurrencySample[] {
    return this.#series;
  }

  /** Drop the series. */
  reset(): void {
    this.#series = [];
  }

  /** Stamp, append and trim one observation. Returns the sample so the caller can broadcast it. */
  record(observed: Omit<ConcurrencySample, 'ts'>): ConcurrencySample {
    const sample: ConcurrencySample = { ts: Date.now(), ...observed };
    this.#series.push(sample);
    if (this.#series.length > this.cap) this.#series.shift();
    return sample;
  }

  /** Start the periodic sampler. Replaces any sampler already running. */
  start(tick: () => void): void {
    this.stop();
    this.#timer = setInterval(tick, this.intervalMs);
    // Never hold the process open for a benchmark that has otherwise finished.
    this.#timer.unref?.();
  }

  /** Stop the periodic sampler. Idempotent — safe on the completion path, where it is already stopped. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get sampling(): boolean {
    return this.#timer !== null;
  }
}

/**
 * Rate per second, to one decimal — the ONE rounding rule for tokens/sec and chars/sec.
 *
 * `null` rather than 0 or Infinity when the count is absent or the duration is zero. A backend that
 * reported no usage and a backend that produced nothing in no time must not both render as a number,
 * because a number in a throughput chart is read as a measurement.
 */
export function ratePerSec(count: number, durationMs: number): number | null {
  // The duration is checked for finiteness as well as sign: a NaN duration — an elapsed time
  // computed from a timestamp that was never recorded — passes a `<= 0` guard and yields NaN, and an
  // infinite one yields a confident 0. Both render as a measurement that was never taken.
  if (!Number.isFinite(count) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.round((count / (durationMs / 1000)) * 10) / 10;
}
