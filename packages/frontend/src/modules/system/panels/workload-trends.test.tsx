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
    gpuVramMb: null,
    readiness: null,
  };
}

/** `present` names the workloads that appear in the sample; anything else is simply not in it. */
function sample(
  minute: number,
  present: { appUrn: string; appName: string; cpuPercent: number; gpuVramMb?: number | null }[],
): AppRuntimeHistorySample {
  return {
    sampledAt: `2026-09-10T02:${String(minute).padStart(2, '0')}:00Z`,
    apps: present.map((entry) => ({
      ...entry,
      status: 'running',
      memoryUsageBytes: 100_000_000,
      containerCount: 1,
      gpuVramMb: entry.gpuVramMb ?? null,
    })),
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
      {
        sampledAt: '2026-09-10T02:20:00Z',
        apps: [{ ...big, status: 'running', memoryUsageBytes: 3_100_000_000, containerCount: 1, gpuVramMb: null }],
      },
      {
        sampledAt: '2026-09-10T02:21:00Z',
        apps: [{ ...big, status: 'running', memoryUsageBytes: 3_300_000_000, containerCount: 1, gpuVramMb: null }],
      },
    ];

    const { container } = render(<WorkloadTrend metric="memory" history={history} apps={[app(big.appUrn, big.appName, 5)]} state={READY} />);

    expect(container.textContent).toContain('3.1 GB');
    // The axis ceiling is a ROUNDED PLOT BOUND, not an observation: `computeMemoryChartScale` rounds
    // 3.3 GB of samples up to a 4.0 GB gridline. Calling that "peak" printed a figure nothing
    // measured, one line above rows printing their real peaks in the same words.
    expect(container.textContent).toContain('scale to 4.0 GB');
    expect(container.textContent).not.toContain('peak 4.0 GB');
  });

  it('renders real GPU VRAM (megabytes converted to bytes), titled distinctly from CPU/memory', () => {
    const engine = { appUrn: 'urn:engine', appName: 'Engine', cpuPercent: 5 };
    const history = [sample(20, [{ ...engine, gpuVramMb: 512 }]), sample(21, [{ ...engine, gpuVramMb: 600 }])];

    const { container } = render(<WorkloadTrend metric="gpu" history={history} apps={[app(engine.appUrn, engine.appName, 5)]} state={READY} />);

    expect(container.textContent).toContain('GPU memory by workload');
    // 600 MB, not 600 bytes — the metric is megabytes and must be converted before humanBytes sees it.
    expect(container.textContent).toContain('600 MB');
  });

  it('says in words when per-process VRAM is absent on this node, whatever the rows show', () => {
    const engine = { appUrn: 'urn:engine', appName: 'Engine', cpuPercent: 5 };
    // The probe timer died mid-window: two real points, then nulls, and the newest snapshot says
    // no source answered. The trace ends in a gap and the line says why — not a zero, not silence.
    const history = [
      sample(20, [{ ...engine, gpuVramMb: 512 }]),
      sample(21, [{ ...engine, gpuVramMb: 512 }]),
      sample(22, [engine]),
      sample(23, [engine]),
    ];

    const { container } = render(
      <WorkloadTrend metric="gpu" history={history} apps={[app(engine.appUrn, engine.appName, 5)]} state={READY} gpuVramSource="absent" />,
    );

    const note = container.querySelector('[data-testid="workload-trend-gpu-absent"]');
    expect(note?.textContent).toContain('not read on this node');
    expect(note?.textContent).toContain('cihub fleet update --gpu-probe');
    // The rows are still there: the two real points are history worth keeping, and the gap after
    // them is a gap — one run that never touches the baseline a fabricated zero would have drawn.
    expect(container.textContent).toContain('Engine');
    const runs = lineRuns(container, 'Engine — GPU memory by workload');
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toContain(',37');
  });

  it('prints the absent line even with no workloads or a single sample, and never for a source that answered', () => {
    const engine = { appUrn: 'urn:engine', appName: 'Engine', cpuPercent: 5 };

    const empty = render(<WorkloadTrend metric="gpu" history={[]} apps={[]} state={READY} gpuVramSource="absent" />);
    expect(empty.container.querySelector('[data-testid="workload-trend-gpu-absent"]')).not.toBeNull();

    const waiting = render(
      <WorkloadTrend
        metric="gpu"
        history={[sample(20, [engine])]}
        apps={[app(engine.appUrn, engine.appName, 5)]}
        state={READY}
        gpuVramSource="absent"
      />,
    );
    expect(waiting.container.querySelector('[data-testid="workload-trend-gpu-absent"]')).not.toBeNull();

    // A source that answered and found nothing holding VRAM is a measurement, not an absence.
    for (const source of ['host-file', 'tool', null, undefined] as const) {
      const { container } = render(<WorkloadTrend metric="gpu" history={[]} apps={[]} state={READY} gpuVramSource={source} />);
      expect(container.querySelector('[data-testid="workload-trend-gpu-absent"]')).toBeNull();
    }
    // And the line belongs to the GPU tile alone, whatever the source says.
    const cpu = render(<WorkloadTrend metric="cpu" history={[]} apps={[]} state={READY} gpuVramSource="absent" />);
    expect(cpu.container.querySelector('[data-testid="workload-trend-gpu-absent"]')).toBeNull();
  });

  it('leaves a workload with no GPU VRAM found unmeasured, not drawn at zero — same rule as an absent workload', () => {
    const engine = { appUrn: 'urn:engine', appName: 'Engine', cpuPercent: 5 };
    const idle = { appUrn: 'urn:idle', appName: 'Idle', cpuPercent: 2 };
    // `idle` is present in every sample (it is an installed, non-missing app) but never holds any
    // GPU memory — gpuVramMb stays null throughout, the "sampler ran, found nothing here" case,
    // not the "workload did not exist yet" case the other tests above cover.
    const history = [sample(20, [{ ...engine, gpuVramMb: 300 }, idle]), sample(21, [{ ...engine, gpuVramMb: 300 }, idle])];

    const { container } = render(
      <WorkloadTrend
        metric="gpu"
        history={history}
        apps={[app(engine.appUrn, engine.appName, 5), app(idle.appUrn, idle.appName, 2)]}
        state={READY}
      />,
    );

    // Zero observations for a row draws `StepAreaChart`'s empty-track `<div>`, not an `<svg>` at
    // all — so "no line was ever drawn at zero" is exactly the ABSENCE of this element, not an
    // empty one. The workload still appears in the tile by name, distinguishing "measured nothing"
    // from "dropped entirely".
    expect(container.querySelector('svg[aria-label="Idle — GPU memory by workload"]')).toBeNull();
    expect(container.textContent).toContain('Idle');
    expect(lineRuns(container, 'Engine — GPU memory by workload')).toHaveLength(1);
  });

  /*
   * The "scale to 256 TB" regression, pinned. `gpuVramMb` is megabytes and the axis scale takes
   * bytes; the ceiling used to be computed from the raw megabytes and THEN multiplied by 1024² at
   * render, so the scale's 256 MiB floor — 268,435,456 — was printed as 268,435,456 MB. Seen live
   * on a 10 GB RTX 3080 on every node whose workloads held no VRAM, because that is exactly when
   * the floor is the ceiling.
   */
  it('labels an empty GPU axis in gigabytes, never terabytes', () => {
    // The Hub's own container: present in every sample, never holding VRAM.
    const hub = { appUrn: 'urn:hub', appName: 'Hub', cpuPercent: 3, gpuVramMb: null };
    const history = [sample(20, [hub]), sample(21, [hub]), sample(22, [hub])];

    const { container } = render(<WorkloadTrend metric="gpu" history={history} apps={[app(hub.appUrn, hub.appName, 3)]} state={READY} />);

    expect(container.textContent).toContain('scale to 1.0 GB');
    expect(container.textContent).not.toMatch(/TB/);
  });

  it('scales a GPU axis from the megabytes it is given, in the same unit its label prints', () => {
    const engine = { appUrn: 'urn:engine', appName: 'Engine', cpuPercent: 5 };
    const history = [sample(20, [{ ...engine, gpuVramMb: 1_533 }]), sample(21, [{ ...engine, gpuVramMb: 1_533 }])];

    const { container } = render(<WorkloadTrend metric="gpu" history={history} apps={[app(engine.appUrn, engine.appName, 5)]} state={READY} />);

    // 1,533 MiB is the row's value; padded 10% and rounded up to the next 256 MiB step it is
    // 1,792 MiB, which is the ceiling — a plausible figure one gridline above the peak, not
    // 1,792 MiB re-read as megabytes-of-megabytes.
    expect(container.textContent).toContain('1.5 GB');
    expect(container.textContent).toContain('scale to 1.8 GB');
    expect(container.textContent).not.toMatch(/TB/);
  });
});

/*
 * History as fzzy served it on 2026-09-27, after a restart: eleven samples hydrated from Postgres —
 * zoneless UTC, "2026-09-27 10:22:22.896" — then the live collector's ISO samples from 17:48Z. The
 * Hub was down in between. The chart labelled the span "10:22 AM → 11:00 AM" in a PDT browser and
 * drew the seven hours as one continuous minute.
 */
describe('WorkloadTrend across a Hub restart', () => {
  const hub = { appUrn: 'ci-hub:system', appName: 'CI Hub', cpuPercent: 5.3 };
  const at = (sampledAt: string): AppRuntimeHistorySample => ({
    sampledAt,
    apps: [{ ...hub, status: 'running', memoryUsageBytes: 857_370_624, containerCount: 5, gpuVramMb: null }],
  });
  const restored = Array.from({ length: 11 }, (_, i) => at(`2026-09-27 10:${String(22 + i).padStart(2, '0')}:22.896`));
  const live = Array.from({ length: 12 }, (_, i) => at(new Date(Date.parse('2026-09-27T17:48:54.882Z') + i * 60_000).toISOString()));
  const fzzy = [...restored, ...live, at('2026-09-27T18:00:50.560Z')];
  const format = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

  it('breaks the trace where the Hub was not sampling, and says for how long', () => {
    const { container } = render(<WorkloadTrend metric="cpu" history={fzzy} apps={[app(hub.appUrn, hub.appName, 5.3)]} state={READY} />);

    expect(lineRuns(container, 'CI Hub — CPU by workload')).toHaveLength(2);
    expect(container.querySelector('[data-testid="workload-trend-gap"]')?.textContent).toBe('7h 17m gap — the Hub was not sampling');
  });

  it('labels the axis from the restored samples read as UTC, not as browser-local time', () => {
    const { container } = render(<WorkloadTrend metric="cpu" history={fzzy} apps={[app(hub.appUrn, hub.appName, 5.3)]} state={READY} />);

    const first = container.querySelector('.justify-between > span')?.textContent;
    expect(first).toBe(format('2026-09-27T10:22:22.896Z'));
    // In any zone but UTC, reading the same string as local time gives a different label.
    const misread = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date('2026-09-27T10:22:22.896'));
    if (misread !== format('2026-09-27T10:22:22.896Z')) expect(first).not.toBe(misread);
  });

  it('draws two samples taken 0.7 s apart as one observation, not as a minute of trace', () => {
    // core-2: the timer and a page GET each collected, at 18:00:49.803 and 18:00:50.491.
    const history = [at('2026-09-27T17:58:49.800Z'), at('2026-09-27T17:59:49.802Z'), at('2026-09-27T18:00:49.803Z'), at('2026-09-27T18:00:50.491Z')];
    const { container } = render(<WorkloadTrend metric="cpu" history={history} apps={[app(hub.appUrn, hub.appName, 5.3)]} state={READY} />);

    const [run] = lineRuns(container, 'CI Hub — CPU by workload');
    // Three slots of 160px, not four of 120: the duplicate took no slot of its own.
    expect(run?.startsWith('M 0,')).toBe(true);
    expect(run).toContain('L 480,');
    expect(run).not.toContain('L 360,');
    expect(container.querySelector('[data-testid="workload-trend-gap"]')).toBeNull();
  });
});

describe('WorkloadTrend GPU memory held outside any workload', () => {
  const hub = { appUrn: 'ci-hub:system', appName: 'CI Hub', cpuPercent: 2, gpuVramMb: null };
  const history = [sample(20, [hub]), sample(21, [hub])];

  /*
   * core-2, 2026-09-27: `unattributedGpu` held two `llama-server`s — 24,331 MB and 493 MB — while the
   * tile showed rows of dashes under copy saying VRAM "is measured on this node". The engines are host
   * processes, so no workload row can ever own that memory; this is the only place it can be shown.
   */
  it('lists what the sampler found holding VRAM outside every workload, largest first', () => {
    const { container } = render(
      <WorkloadTrend
        metric="gpu"
        history={history}
        apps={[app(hub.appUrn, hub.appName, 2)]}
        state={READY}
        gpuVramSource="host-file"
        unattributed={[
          { processName: 'llama-server', vramMb: 493 },
          { processName: 'llama-server', vramMb: 24_331 },
        ]}
      />,
    );

    const footer = container.querySelector('[data-testid="workload-trend-gpu-unattributed"]');
    expect(footer?.textContent).toContain('Held outside any workload');
    const lines = [...(footer?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(lines).toEqual(['llama-server24 GB', 'llama-server493 MB']);
  });

  it('prints nothing when the sampler found nothing unattributed, and never on the CPU or memory tiles', () => {
    const none = render(<WorkloadTrend metric="gpu" history={history} apps={[app(hub.appUrn, hub.appName, 2)]} state={READY} unattributed={null} />);
    expect(none.container.querySelector('[data-testid="workload-trend-gpu-unattributed"]')).toBeNull();

    const cpu = render(
      <WorkloadTrend
        metric="cpu"
        history={history}
        apps={[app(hub.appUrn, hub.appName, 2)]}
        state={READY}
        unattributed={[{ processName: 'dflash_server', vramMb: 17_788 }]}
      />,
    );
    expect(cpu.container.querySelector('[data-testid="workload-trend-gpu-unattributed"]')).toBeNull();
  });

  it('does not send an Apple Silicon operator to a Linux probe timer', () => {
    const { container } = render(<WorkloadTrend metric="gpu" history={[]} apps={[]} state={READY} gpuVramSource="absent" gpuVendor="apple" />);

    const note = container.querySelector('[data-testid="workload-trend-gpu-absent"]');
    expect(note?.textContent).toContain('Apple GPUs expose no per-process memory');
    expect(note?.textContent).not.toContain('cihub fleet update');
  });
});
