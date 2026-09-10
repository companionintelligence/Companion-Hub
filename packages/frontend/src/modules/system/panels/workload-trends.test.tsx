import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WorkloadTrend } from './workload-trends';

/*
 * The `?? 0` regression, pinned.
 *
 * Every installed non-`missing` app appears in every sample the backend takes, so an app that is
 * ABSENT from an older sample was not installed yet. The chart this replaced coalesced that to
 * zero, which drew a workload as having idled at 0% for the part of the window before it existed
 * — a measurement nobody took, and identical on screen to a container doing nothing.
 *
 * `StepAreaChart` maps a value of 0 to y = height - 1 (37 at the 38px row height this panel uses),
 * so a fabricated zero is detectable in the path data: a trace that never dips to the baseline
 * never claimed one. Every fixture value below is non-zero for exactly that reason.
 */

const READY = { pending: false, failed: false };

function app(appUrn: string, appName: string, cpuPercent: number): AppRuntimeHealth {
  return {
    appUrn,
    appName,
    status: 'running',
    cpuPercent,
    memoryUsageBytes: 100_000_000,
    memoryLimitBytes: 400_000_000,
    highCpu: false,
    sustainedHighCpu: false,
    responsive: true,
    degraded: false,
    forceStopEligible: false,
    reason: null,
    cpuLimit: null,
    usesDefaultCpuLimit: true,
    sampledAt: '2026-09-10T02:31:00Z',
    containers: [],
  };
}

/** `present` names the workloads that appear in the sample; anything else is simply not in it. */
function sample(minute: number, present: { appUrn: string; appName: string; cpuPercent: number }[]): AppRuntimeHistorySample {
  return {
    sampledAt: `2026-09-10T02:${String(minute).padStart(2, '0')}:00Z`,
    apps: present.map((entry) => ({ ...entry, status: 'running', memoryUsageBytes: 100_000_000, containerCount: 1 })),
  };
}

const OLD = { appUrn: 'urn:old', appName: 'Old', cpuPercent: 20 };
const NEW = { appUrn: 'urn:new', appName: 'New', cpuPercent: 10 };

function lineRuns(container: HTMLElement, label: string): string[] {
  const svg = container.querySelector(`svg[aria-label="${label}"]`);
  expect(svg).not.toBeNull();

  // Each run is a <g> holding a filled area path and the stroked line path. The line is the one
  // with `fill="none"`.
  return [...(svg?.querySelectorAll('path[fill="none"]') ?? [])].map((path) => path.getAttribute('d') ?? '');
}

describe('WorkloadTrend', () => {
  it('leaves a workload that did not exist yet unmeasured, rather than drawing it at zero', () => {
    const history = [sample(20, [OLD]), sample(21, [OLD]), sample(22, [OLD]), sample(23, [OLD, NEW]), sample(24, [OLD, NEW]), sample(25, [OLD, NEW])];

    const { container } = render(
      <WorkloadTrend metric="cpu" history={history} apps={[app(OLD.appUrn, OLD.appName, 20), app(NEW.appUrn, NEW.appName, 10)]} state={READY} />,
    );

    const runs = lineRuns(container, 'New — CPU by workload');

    // One run, because the absence is at the start rather than in the middle.
    expect(runs).toHaveLength(1);
    // It begins at the fourth of six slots (480 / 6 = 80 per slot), not at x = 0.
    expect(runs[0]?.startsWith('M 240,')).toBe(true);
    // And it never touches the baseline, which is what a fabricated 0% would have drawn.
    expect(runs[0]).not.toContain(',37');
  });

  it('breaks the trace into separate runs when a workload disappears mid-window', () => {
    const history = [
      sample(20, [OLD, NEW]),
      sample(21, [OLD, NEW]),
      sample(22, [OLD]),
      sample(23, [OLD]),
      sample(24, [OLD, NEW]),
      sample(25, [OLD, NEW]),
    ];

    const { container } = render(
      <WorkloadTrend metric="cpu" history={history} apps={[app(OLD.appUrn, OLD.appName, 20), app(NEW.appUrn, NEW.appName, 10)]} state={READY} />,
    );

    const runs = lineRuns(container, 'New — CPU by workload');

    // Two runs, therefore a second `M` command in the tile: the gap is a gap.
    expect(runs).toHaveLength(2);
    expect(runs.join(' ').match(/M /g)).toHaveLength(2);
    expect(runs.join(' ')).not.toContain(',37');
  });

  it('puts the current and peak values in the row, so the chart is readable without a hover', () => {
    const history = [sample(20, [{ ...NEW, cpuPercent: 40 }]), sample(21, [{ ...NEW, cpuPercent: 10 }])];

    const { container } = render(<WorkloadTrend metric="cpu" history={history} apps={[app(NEW.appUrn, NEW.appName, 10)]} state={READY} />);

    expect(container.textContent).toContain('10.0%');
    expect(container.textContent).toContain('peak 40.0%');
  });

  it('never forces a horizontal scroll, at any width', () => {
    const history = [sample(20, [OLD]), sample(21, [OLD])];
    const { container } = render(<WorkloadTrend metric="cpu" history={history} apps={[app(OLD.appUrn, OLD.appName, 20)]} state={READY} />);

    expect(container.querySelector('[class*="overflow-x-auto"]')).toBeNull();
    expect(container.querySelector('[class*="min-w-["]')).toBeNull();
  });

  it('says it is waiting rather than drawing a trend from a single sample', () => {
    const { container } = render(
      <WorkloadTrend metric="cpu" history={[sample(20, [OLD])]} apps={[app(OLD.appUrn, OLD.appName, 20)]} state={READY} />,
    );

    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('1 of 2 samples');
  });

  it('renders a failed container fetch as a failure, never as an empty chart', () => {
    const { container } = render(<WorkloadTrend metric="cpu" history={[]} apps={[]} state={{ pending: false, failed: true }} />);

    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).not.toContain('No workloads running');
  });

  it('scales memory in bytes rather than reusing the CPU axis', () => {
    const big = { appUrn: 'urn:big', appName: 'Big', cpuPercent: 5 };
    const history: AppRuntimeHistorySample[] = [
      { sampledAt: '2026-09-10T02:20:00Z', apps: [{ ...big, status: 'running', memoryUsageBytes: 3_100_000_000, containerCount: 1 }] },
      { sampledAt: '2026-09-10T02:21:00Z', apps: [{ ...big, status: 'running', memoryUsageBytes: 3_300_000_000, containerCount: 1 }] },
    ];

    const { container } = render(<WorkloadTrend metric="memory" history={history} apps={[app(big.appUrn, big.appName, 5)]} state={READY} />);

    expect(container.textContent).toContain('3.1 GB');
    // The axis ceiling is a ROUNDED PLOT BOUND, not an observation: `computeMemoryChartScale` rounds
    // 3.3 GB of samples up to a 4.0 GB gridline. Calling that "peak" printed a figure nothing
    // measured, one line above rows printing their real peaks in the same words.
    expect(container.textContent).toContain('scale to 4.0 GB');
    expect(container.textContent).not.toContain('peak 4.0 GB');
  });
});
