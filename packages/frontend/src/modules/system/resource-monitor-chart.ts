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
