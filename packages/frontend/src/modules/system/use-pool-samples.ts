import { appendPoolSample, EMPTY_SAMPLE_WINDOW, type PoolNodeCard, type PoolSampleWindow, sampleInFlight } from '@/modules/system/pool-node-series';
import { useEffect, useRef, useState } from 'react';

/**
 * The browser's own record of what the pool was doing while this page was open.
 *
 * The pool publishes capability, not history — no endpoint anywhere returns a peer's past — so the
 * only per-node trend this page can honestly draw is one accumulated here. Two rules do the work,
 * and both are about NOT recording:
 *
 * 1. IT SAMPLES `dataUpdatedAt`, NOT A TIMER. The query's fetch timestamp is the only thing that
 *    marks a genuinely new observation. A `setInterval` beside a 15s poll would re-record the same
 *    payload three or four times and manufacture a flat run indistinguishable from a measured idle
 *    node — the exact class of bug this page has already shipped three times.
 *
 * 2. A FAILED POLL RECORDS NOTHING. The backend's load service returns 0 for a node it holds no
 *    entry for, so once a dropped poll is written into the array a network failure and an idle
 *    machine are the same picture forever. A failed query therefore appends no sample at all and
 *    the series simply stops advancing; the panel's own failed state says why.
 *
 * The window is per-tab and dies with it. Every chart built on it has to say so.
 */
export function usePoolSamples(cards: PoolNodeCard[], updatedAt: number, failed: boolean): PoolSampleWindow {
  const [samples, setSamples] = useState<PoolSampleWindow>(EMPTY_SAMPLE_WINDOW);

  // The cards are rebuilt on every render, but only a new `updatedAt` marks a new observation.
  // Holding them in a ref keeps the fetch timestamp as the effect's sole trigger without making
  // the sample depend on how many times React happened to re-render between two polls.
  const latestCards = useRef(cards);
  latestCards.current = cards;

  useEffect(() => {
    if (failed || !Number.isFinite(updatedAt) || updatedAt <= 0) return;

    // `appendPoolSample` returns the same reference when the timestamp is not newer than the one
    // already held, so a re-render that brought no new fetch bails React out here.
    setSamples((current) => appendPoolSample(current, { at: updatedAt, inFlight: sampleInFlight(latestCards.current) }));
  }, [updatedAt, failed]);

  return samples;
}
