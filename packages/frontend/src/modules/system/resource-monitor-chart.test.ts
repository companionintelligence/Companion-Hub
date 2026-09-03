import { describe, expect, it } from 'vitest';

import { computeCpuChartScale } from './resource-monitor-chart';

describe('computeCpuChartScale', () => {
  it('uses a 0–100% axis when all samples are at or below one core', () => {
    expect(computeCpuChartScale([0, 13.7, 72, 100])).toEqual({
      max: 100,
      ticks: [0, 25, 50, 75, 100],
    });
  });

  it('extends the axis above 100% for multi-core CPU spikes', () => {
    const scale = computeCpuChartScale([12, 180, 95]);
    expect(scale.max).toBeGreaterThan(180);
    expect(scale.max % 50).toBe(0);
    expect(scale.ticks[0]).toBe(0);
    expect(scale.ticks.at(-1)).toBe(scale.max);
    expect(scale.ticks.every((tick) => tick <= scale.max)).toBe(true);
  });

  it('chooses a higher ceiling for very large spikes', () => {
    expect(computeCpuChartScale([620])).toEqual({
      max: 700,
      ticks: [0, 200, 400, 600, 700],
    });
  });

  it('defaults to 100% when there is no data', () => {
    expect(computeCpuChartScale([])).toEqual({
      max: 100,
      ticks: [0, 25, 50, 75, 100],
    });
  });
});
