import { parseHubTimestamp } from '@/components/ui/dense/dense';
import type { AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';

/**
 * Two samples closer than this are one observation taken twice.
 *
 * The backend's timer and a page GET could both collect at once (fixed in the backend, but a Hub
 * still on an older build keeps serving them): core-2 held samples at 18:00:49.803 and 18:00:50.491.
 * Charted by index they are two slots, so a 0.7-second interval was drawn as wide as a minute and
 * the trace grew a step nobody measured. The monitor samples every 60s; 20s is well clear of both.
 */
export const DUPLICATE_SAMPLE_MS = 20_000;

/**
 * Two samples further apart than this have an interval between them that nobody watched.
 *
 * 2.5 monitor intervals: one late tick is a slow Docker call and is still a continuous reading; a
 * gap this wide is a Hub that was not running. fzzy's restored history held samples from 10:22 to
 * 10:32Z and then from 17:48Z — seven hours with the Hub down, drawn as one continuous minute.
 */
export const SAMPLE_GAP_MS = 150_000;

/** One slot of a charted history: a sample, or a stretch with no sample in it. */
export type TimelineSlot = { kind: 'sample'; sample: AppRuntimeHistorySample } | { kind: 'gap'; durationMs: number };

/**
 * A history as the chart should draw it: near-duplicates dropped, and a `gap` slot wherever the Hub
 * was not sampling, so the line BREAKS there instead of joining across hours it never saw.
 *
 * The x axis stays by index, not by time — each sample is one slot and a gap is one slot — because a
 * seven-hour gap drawn to scale would squeeze twenty minutes of real readings into a sliver at each
 * end. The break says "time passed here"; `gaps` carries how much, for the caption.
 *
 * A sample whose timestamp cannot be parsed is kept and never gapped against: dropping it would
 * lose a real reading, and gapping needs a time.
 */
export function sampleTimeline(history: AppRuntimeHistorySample[]): { slots: TimelineSlot[]; samples: AppRuntimeHistorySample[]; gapsMs: number[] } {
  const slots: TimelineSlot[] = [];
  const samples: AppRuntimeHistorySample[] = [];
  const gapsMs: number[] = [];
  let previousAt = Number.NaN;

  for (const sample of history) {
    const at = parseHubTimestamp(sample.sampledAt);

    if (Number.isFinite(at) && Number.isFinite(previousAt)) {
      const interval = at - previousAt;
      if (interval >= 0 && interval < DUPLICATE_SAMPLE_MS) continue;
      if (interval > SAMPLE_GAP_MS) {
        slots.push({ kind: 'gap', durationMs: interval });
        gapsMs.push(interval);
      }
    }

    slots.push({ kind: 'sample', sample });
    samples.push(sample);
    if (Number.isFinite(at)) previousAt = at;
  }

  return { slots, samples, gapsMs };
}

/**
 * A history timestamp as a wall-clock time in the READER'S zone.
 *
 * Through `parseHubTimestamp` because a Hub that restarted serves its restored history straight out
 * of a zoneless Postgres column, and `new Date()` read those as browser-local: fzzy's chart was
 * labelled "10:22 AM → 11:00 AM" in a PDT browser for a window that really ran 03:22 → 11:00 local.
 */
export function formatSampleTime(value: string | undefined): string {
  const at = parseHubTimestamp(value);

  return Number.isFinite(at) ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at)) : (value ?? '');
}

/** Y-axis scale for Docker-style CPU % (can exceed 100% when a workload uses multiple cores). */
export function computeCpuChartScale(cpuPercents: number[]): { max: number; ticks: number[] } {
  const finiteValues = cpuPercents.filter((value) => Number.isFinite(value) && value >= 0);
  const dataMax = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;

  if (dataMax <= 100) {
    return { max: 100, ticks: [0, 25, 50, 75, 100] };
  }

  // Headroom so spikes do not clip against the top edge; round to readable grid steps.
  const padded = dataMax * 1.1;
  const ceilingIncrement = padded <= 500 ? 50 : 100;
  const max = Math.ceil(padded / ceilingIncrement) * ceilingIncrement;

  const tickStep = max <= 200 ? 50 : max <= 500 ? 100 : 200;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max; tick += tickStep) {
    ticks.push(tick);
  }
  if (ticks.at(-1) !== max) {
    ticks.push(max);
  }

  return { max, ticks };
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/**
 * Y-axis scale for per-workload memory, in BYTES.
 *
 * A separate function rather than a reuse of {@link computeCpuChartScale}, which floors its
 * ceiling at 100 because a Docker CPU percentage is meaningfully compared to one core. Handed
 * bytes, that floor would put every workload on this fleet — hundreds of megabytes at the low
 * end — at the very top of a 100-byte axis, and every row would read as full.
 *
 * The ceiling is rounded up to a step an operator already thinks in, so two tiles drawn a minute
 * apart do not silently rescale under a value that moved by a few megabytes: 256 MiB steps below
 * 2 GiB, 1 GiB below 16 GiB, 4 GiB above. Every step is a power of two, so the quarter ticks are
 * always exact byte counts rather than a rounding to be re-rounded by `humanBytes` at render.
 *
 * `dataMax === 0` returns a nominal 256 MiB axis. That is NOT a claim that anything is using
 * 256 MiB — it is the smallest readable box to draw a measured zero inside, and the caller's own
 * empty and waiting states handle the cases where there is nothing measured at all.
 */
export function computeMemoryChartScale(byteValues: number[]): { max: number; ticks: number[] } {
  const finiteValues = byteValues.filter((value) => Number.isFinite(value) && value >= 0);
  const dataMax = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;

  if (dataMax === 0) {
    return { max: 256 * MIB, ticks: [0, 256 * MIB] };
  }

  // Headroom so a peak does not clip against the top edge, then up to the next readable step.
  const padded = dataMax * 1.1;
  const step = padded < 2 * GIB ? 256 * MIB : padded < 16 * GIB ? GIB : 4 * GIB;
  const max = Math.ceil(padded / step) * step;

  return { max, ticks: [0, max / 4, max / 2, (max * 3) / 4, max] };
}

/**
 * Y-axis scale for per-workload GPU VRAM, in BYTES — the same bytes the caller hands `humanBytes`
 * at render, so the axis ceiling and its label cannot disagree about the unit. The backend's
 * `gpuVramMb` is megabytes; the caller converts before it gets here, not after. Computing the
 * ceiling from raw megabytes with {@link computeMemoryChartScale} and THEN converting printed
 * its 256 MiB floor (268,435,456) as if it were megabytes: "scale to 256 TB" above a 10 GB card,
 * on every Hub whose workloads hold no VRAM at all.
 *
 * Same rounding as memory, with a floor of 1 GiB instead of 256 MiB. Nothing measured is the
 * COMMON case for this axis — a Hub whose workloads are all CPU-bound draws it every minute —
 * and the box drawn around nothing should be sized to what a workload that does hold VRAM holds,
 * which is a model, i.e. gigabytes, not to the container-memory floor.
 */
export function computeVramChartScale(byteValues: number[]): { max: number; ticks: number[] } {
  const scale = computeMemoryChartScale(byteValues);

  return scale.max >= GIB ? scale : { max: GIB, ticks: [0, GIB / 4, GIB / 2, (GIB * 3) / 4, GIB] };
}
