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
