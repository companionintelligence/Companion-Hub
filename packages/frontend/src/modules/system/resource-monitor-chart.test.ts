import { describe, expect, it } from 'vitest';

import { computeCpuChartScale, computeMemoryChartScale, computeVramChartScale } from './resource-monitor-chart';

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

describe('computeMemoryChartScale', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;

  it('rounds a sub-gigabyte peak up to the next 256 MiB step', () => {
    const scale = computeMemoryChartScale([120 * MIB, 700 * MIB, 96 * MIB]);

    // 700 MiB padded is 770 MiB, which lands in the fourth 256 MiB step.
    expect(scale.max).toBe(1024 * MIB);
    expect(scale.max % (256 * MIB)).toBe(0);
    expect(scale.ticks[0]).toBe(0);
    expect(scale.ticks.at(-1)).toBe(scale.max);
  });

  it('switches to gigabyte steps once the axis leaves the megabyte range', () => {
    const scale = computeMemoryChartScale([3.2 * GIB]);

    expect(scale.max % GIB).toBe(0);
    expect(scale.max).toBeGreaterThan(3.2 * GIB);
    expect(scale.max).toBeLessThanOrEqual(5 * GIB);
  });

  it('takes four-gigabyte steps for a large host so the axis does not re-scale on every sample', () => {
    const scale = computeMemoryChartScale([40 * GIB]);

    expect(scale.max % (4 * GIB)).toBe(0);
    expect(scale.max).toBeGreaterThanOrEqual(44 * GIB);
  });

  it('keeps every tick an exact byte count', () => {
    for (const scale of [computeMemoryChartScale([700 * MIB]), computeMemoryChartScale([3.2 * GIB]), computeMemoryChartScale([40 * GIB])]) {
      expect(scale.ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    }
  });

  it('gives a measured zero a readable box rather than an axis of zero height', () => {
    expect(computeMemoryChartScale([0, 0])).toEqual({ max: 256 * MIB, ticks: [0, 256 * MIB] });
    expect(computeMemoryChartScale([])).toEqual({ max: 256 * MIB, ticks: [0, 256 * MIB] });
  });

  it('ignores values that are not measurements at all', () => {
    expect(computeMemoryChartScale([Number.NaN, -1, Number.POSITIVE_INFINITY]).max).toBe(256 * MIB);
  });
});

describe('computeVramChartScale', () => {
  const MIB = 1024 ** 2;
  const GIB = 1024 ** 3;

  it('floors an empty or zero series at 1 GiB, the size of the thing a workload holding VRAM holds', () => {
    expect(computeVramChartScale([]).max).toBe(GIB);
    expect(computeVramChartScale([0, 0]).max).toBe(GIB);
    expect(computeVramChartScale([Number.NaN, -1]).max).toBe(GIB);
  });

  it('lifts a sub-gigabyte peak to the same floor rather than a 256 MiB box', () => {
    expect(computeVramChartScale([300 * MIB]).max).toBe(GIB);
  });

  it('otherwise rounds exactly as the memory scale does, in bytes', () => {
    expect(computeVramChartScale([1_533 * MIB])).toEqual(computeMemoryChartScale([1_533 * MIB]));
    expect(computeVramChartScale([1_533 * MIB]).max).toBe(1_792 * MIB);
    expect(computeVramChartScale([9.8 * GIB]).max % GIB).toBe(0);
  });

  it('keeps every tick an exact byte count at the floor', () => {
    expect(computeVramChartScale([]).ticks.every((tick) => Number.isInteger(tick))).toBe(true);
  });
});
