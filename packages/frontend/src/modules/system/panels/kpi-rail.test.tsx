import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { emptyRoutingBucket, type FirstByteStats, type RoutingBucket, type WaitingNow } from '@/modules/system/pool-node-series';
import type { InferenceBackendStatus, ResidencyReportSummary } from '@/modules/system/use-dashboard-data';
import { DashboardRail } from './kpi-rail';

/*
 * THE WINDOW EACH RAIL FIGURE ACTUALLY COVERS, and what it counts.
 *
 * Every routing figure on the rail is a 30-minute figure summed from the same buckets the activity
 * panel draws. Failovers used to be the exception — a whole-ring count that spanned eighteen hours on
 * core-2 — and was labelled "whole log, not 30m" to excuse it; it is windowed now, and so is the
 * verdict's unplaced count.
 *
 * The windowed figures have their own trap: the ring EVICTS SILENTLY, so on a Hub that turned over
 * more rows than it holds inside the window the bucket sum is a floor, not a total. Whether that has
 * happened is decided from the server's own summary (`routingWindowPartial`); the rail only has to
 * say so beside the numbers it qualifies.
 */

const READY = { pending: false, failed: false };
const NOW = Date.parse('2026-09-27T18:00:54Z');

const bucket = (over: Partial<RoutingBucket> = {}): RoutingBucket => ({ ...emptyRoutingBucket(NOW - 60_000), ...over });

const NOTHING_WAITING: WaitingNow = { count: 0, oldest: null };

function renderRail(
  over: {
    buckets?: RoutingBucket[];
    windowPartial?: boolean;
    logHeld?: number;
    waiting?: WaitingNow;
    firstByte?: Map<string, FirstByteStats>;
    residency?: ResidencyReportSummary;
    inferenceBackends?: InferenceBackendStatus[];
    hostCpu?: { cpuLoad?: number; cpuCores?: number; runtimeKind?: string };
  } = {},
) {
  return render(
    <DashboardRail
      verdict={{ kind: 'clear', faults: [], unavailable: 0 }}
      pool={undefined}
      poolState={READY}
      reach={{ connected: 1, unreachable: 0, reachableModels: 2, exclusiveModels: 1, peerInFlight: 0 }}
      localNode={undefined}
      localLabel="This Hub"
      workloads={2}
      degraded={0}
      containerState={READY}
      sampledAt={undefined}
      hardware={undefined}
      hardwareState={READY}
      hostCpu={over.hostCpu}
      hostCpuState={READY}
      residency={over.residency}
      residencyState={READY}
      inferenceBackends={over.inferenceBackends}
      buckets={over.buckets ?? [bucket({ served: 5, failed: 1, failovers: 3 })]}
      windowPartial={over.windowPartial ?? false}
      logHeld={over.logHeld ?? 12}
      waiting={over.waiting ?? NOTHING_WAITING}
      firstByte={over.firstByte ?? new Map()}
      startedAt={undefined}
      routingState={READY}
      now={NOW}
    />,
  );
}

/** A rail stat's rendered text, found by its label. */
function stat(container: HTMLElement, label: string): string {
  const cell = [...container.querySelectorAll('span')].find((span) => span.textContent === label)?.parentElement;
  expect(cell, `no rail stat labelled ${label}`).toBeTruthy();

  return cell?.textContent ?? '';
}

describe('KpiRail routing windows', () => {
  it('counts failovers over the 30-minute window, and no longer excuses a whole-log figure', () => {
    const { container } = renderRail({ buckets: [bucket({ served: 4, failovers: 2 }), bucket({ served: 1, failovers: 1 })] });

    expect(stat(container, 'Failover 30m')).toContain('3');
    expect(container.textContent).not.toContain('whole log');
  });

  it('qualifies the 30-minute counts as a floor when the log held may be missing rows from the window', () => {
    const { container } = renderRail({ windowPartial: true, logHeld: 200 });

    expect(stat(container, 'Routed 30m')).toContain('at least — last 200 held');
    expect(stat(container, 'Failed 30m')).toContain('at least — last 200 held');
  });

  it('leaves the caveat off when the window is covered, where the count is exact', () => {
    const { container } = renderRail({ windowPartial: false, logHeld: 200 });

    expect(container.textContent).not.toContain('at least');
  });

  it('never counts a request still waiting for its first byte as failed', () => {
    // A 40k-token agent turn waits minutes for prefill; it is waiting, not failing.
    const { container } = renderRail({ buckets: [bucket({ served: 2, pending: 1 })] });

    expect(stat(container, 'Failed 30m')).toMatch(/^0/);
    expect(stat(container, 'Routed 30m')).toMatch(/^3/);
  });

  it('names callers that hung up under the failed count, since that is a different fix from a dead node', () => {
    const { container } = renderRail({ buckets: [bucket({ failed: 3, clientClosed: 2 })] });

    expect(stat(container, 'Failed 30m')).toContain('2 callers left');
  });

  it('names failures that took a whole first-byte budget, the ones a too-slow node causes', () => {
    const { container } = renderRail({ buckets: [bucket({ failed: 4, overBudget: 2, clientClosed: 1 })] });

    expect(stat(container, 'Failed 30m')).toContain('2 past budget · 1 caller left');
  });

  it('names requests a node refused as bad, which are the app to fix and were counted as served until 2026-09-29', () => {
    const { container } = renderRail({ buckets: [bucket({ served: 1, failed: 6, refused: 6 })] });

    expect(stat(container, 'Failed 30m')).toMatch(/^6/);
    expect(stat(container, 'Failed 30m')).toContain('6 refused');
  });

  it('names answers a node gave with cut-off or placeholder-only output, the node’s to fix', () => {
    const { container } = renderRail({ buckets: [bucket({ served: 70, failed: 167, badOutput: 167 })] });

    expect(stat(container, 'Failed 30m')).toContain('167 bad answers');
    expect(stat(container, 'Failed 30m')).not.toContain('refused');
  });
});

describe('KpiRail live figures', () => {
  it('shows what is waiting for a first byte, the oldest wait and where', () => {
    const { container } = renderRail({
      waiting: { count: 2, oldest: { ageMs: 370_941, node: 'local', budgetMs: 780_000, estTokens: 38_979, failovers: 0 } },
    });

    const waiting = stat(container, 'Waiting');
    expect(waiting).toMatch(/^2/);
    expect(waiting).toContain('oldest 6m 11s · This Hub');
  });

  it('says a wait is on a node that took over, so its age is not read as the whole request', () => {
    // core-2, 23:56:30: core-14 had held it 39 s after core-7 used its whole 329 s budget.
    const { container } = renderRail({
      waiting: { count: 1, oldest: { ageMs: 39_130, node: 'core-14', budgetMs: 329_000, estTokens: 16_462, failovers: 1 } },
    });

    expect(stat(container, 'Waiting')).toContain('oldest 39.1 s · core-14, after 1 failover');
  });

  /*
   * The tile's amber is the verdict's chip, not a fixed minute. At 60 s it lit for nearly every agent
   * turn on this fleet — the proxy's budget floor is 300 s, and beta-max's 39,668-token turn took
   * 370,941 ms to its first byte, inside a 780 s budget — while the verdict beside it said "All clear".
   */
  it("turns amber only as a wait nears its own budget, where the verdict's chip appears", () => {
    const tone = (ageMs: number, budgetMs: number | null) => {
      const { container, unmount } = renderRail({ waiting: { count: 1, oldest: { ageMs, node: 'local', budgetMs, estTokens: null, failovers: 0 } } });
      // The figure is the first line of the stat's cell, above its label.
      const cell = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Waiting')?.parentElement;
      const amber = cell?.firstElementChild?.className.includes('text-warning');
      unmount();

      return amber;
    };

    expect(tone(370_941, 780_000)).toBe(false);
    expect(tone(640_000, 780_000)).toBe(true);
    // No budget recorded: nothing to judge the wait against, so no warning is guessed.
    expect(tone(9_999_999, null)).toBe(false);
  });

  it('reads an empty queue as a real zero, not as unknown', () => {
    const { container } = renderRail();

    expect(stat(container, 'Waiting')).toMatch(/^0/);
  });

  it('gives the slowest first byte in the window, the node and the prompt size that explain it', () => {
    const firstByte = new Map<string, FirstByteStats>([
      ['core-6', { count: 1, p50Ms: 91_716, maxMs: 91_716, maxEstTokens: 38_693 }],
      ['local', { count: 4, p50Ms: 361, maxMs: 27_027, maxEstTokens: 7_748 }],
    ]);
    const { container } = renderRail({ firstByte });

    const cell = stat(container, '1st byte 30m');
    expect(cell).toContain('1m 32s');
    expect(cell).toContain('core-6 · ~39k tok');
  });

  it('says there is no evidence rather than implying a fast pool when nothing streamed was served', () => {
    const { container } = renderRail({ firstByte: new Map() });

    expect(stat(container, '1st byte 30m')).toContain('none measured');
  });

  it('shows host CPU as a share of the machine with its core count', () => {
    const { container } = renderRail({ hostCpu: { cpuLoad: 91.4, cpuCores: 32 } });

    expect(stat(container, 'Host CPU')).toContain('91%');
    expect(stat(container, 'Host CPU')).toContain('32 cores');
  });

  it("calls the load a VM's on Docker Desktop, where it is the VM's and the core count is the host's", () => {
    const docker = renderRail({ hostCpu: { cpuLoad: 100, cpuCores: 16, runtimeKind: 'docker-desktop-vm' } });

    expect(docker.container.textContent).not.toContain('Host CPU');
    expect(stat(docker.container, 'VM CPU')).toContain('100%');
    expect(stat(docker.container, 'VM CPU')).toContain('Docker VM · host 16 cores');

    const wsl = renderRail({ hostCpu: { cpuLoad: 40, cpuCores: 24, runtimeKind: 'wsl2-vm' } });
    expect(stat(wsl.container, 'VM CPU')).toContain('WSL2 VM · host 24 cores');

    const linux = renderRail({ hostCpu: { cpuLoad: 40, cpuCores: 24, runtimeKind: 'linux-native' } });
    expect(stat(linux.container, 'Host CPU')).toContain('24 cores');
  });

  it('no longer shows per-core container CPU as a bare percentage beside host shares', () => {
    const { container } = renderRail();

    expect(container.textContent).not.toContain('Workload CPU');
    expect(container.textContent).not.toContain('Workload RAM');
  });
});

describe('KpiRail residency blind spots', () => {
  const residency: ResidencyReportSummary = {
    backends: [
      { backend: 'ollama', source: 'measured', models: [] },
      { backend: 'vllm', source: 'unsupported', models: null },
      { backend: 'lemonade', source: 'unreachable', models: null, error: 'connect ECONNREFUSED 172.17.0.1:13305' },
      { backend: 'omlx', source: 'unsupported', models: null },
    ],
    residentCount: 0,
    sampledAt: '2026-09-27T18:00:52.806Z',
  };

  it('does not list engines that are not running as residency it could not read (core-2)', () => {
    const { container } = renderRail({
      residency,
      inferenceBackends: [
        { type: 'ollama', running: true, healthy: true },
        { type: 'vllm', running: false, healthy: false },
        { type: 'lemonade', running: false, healthy: false },
        { type: 'omlx', running: false, healthy: false },
      ],
    });

    expect(container.textContent).not.toContain('Residency unknown');
  });

  it('names a running engine whose residency cannot be read (fzzy, vLLM holding a model)', () => {
    const { container } = renderRail({
      residency,
      inferenceBackends: [
        { type: 'ollama', running: true, healthy: true },
        { type: 'vllm', running: true, healthy: true },
        { type: 'lemonade', running: false, healthy: false },
        { type: 'omlx', running: false, healthy: false },
      ],
    });

    expect(stat(container, 'Resident')).toContain('Residency unknown for: vllm');
    expect(stat(container, 'Resident')).not.toContain('lemonade');
  });

  it('keeps naming every unasked engine while engine status has not arrived, since off and unknown cannot be told apart', () => {
    const { container } = renderRail({ residency });

    expect(stat(container, 'Resident')).toContain('vllm, lemonade, omlx');
  });
});
