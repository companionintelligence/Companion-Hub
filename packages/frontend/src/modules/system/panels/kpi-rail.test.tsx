import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RoutingActivity, RoutingBucket } from '@/modules/system/pool-node-series';
import { DashboardRail } from './kpi-rail';

/*
 * THE WINDOW EACH RAIL FIGURE ACTUALLY COVERS.
 *
 * Three of the twelve stats are counts of routing decisions, and they do not share a window. Two
 * are summed from 30 one-minute buckets; the third is the whole 200-entry ring, which spans days on
 * a quiet Hub and twenty minutes on a busy one. Sitting side by side with no qualifier, adjacency
 * alone made the ring count read as another half-hour figure.
 *
 * The windowed pair has its own trap: the ring EVICTS SILENTLY at `ROUTING_LOG_CAPACITY`, so on a
 * Hub that turned over 200 requests inside the window the bucket sum is a floor, not a total —
 * precisely the busiest Hubs understating themselves with nothing near the number to say so.
 */

const READY = { pending: false, failed: false };

const activity = (over: Partial<RoutingActivity> = {}): RoutingActivity => ({
  total: 12,
  served: 10,
  failed: 2,
  failovers: 3,
  inbound: 4,
  outbound: 8,
  unplaced: 0,
  ...over,
});

const buckets: RoutingBucket[] = [{ at: 1_700_000_000_000, served: 5, failed: 1 }];

function renderRail(over: { activity?: RoutingActivity } = {}) {
  return render(
    <DashboardRail
      verdict={{ kind: 'clear', faults: [], unavailable: 0 }}
      pool={undefined}
      poolState={READY}
      reach={{ connected: 1, unreachable: 0, reachableModels: 2, exclusiveModels: 1, peerInFlight: 0 }}
      localNode={undefined}
      workloads={2}
      degraded={0}
      rollup={null}
      containerState={READY}
      sampledAt={undefined}
      hardware={undefined}
      hardwareState={READY}
      residency={undefined}
      residencyState={READY}
      buckets={buckets}
      activity={over.activity ?? activity()}
      routingState={READY}
    />,
  );
}

describe('KpiRail routing windows', () => {
  it('marks the failover count as covering the whole log, not the 30-minute window', () => {
    const { container } = renderRail();

    expect(container.textContent).toContain('whole log, not 30m');
  });

  it('qualifies the 30-minute counts as a floor once the ring buffer is full', () => {
    // 200 is ROUTING_LOG_CAPACITY: at capacity the log has evicted, so the bucket sum understates.
    const { container } = renderRail({ activity: activity({ total: 200 }) });

    expect(container.textContent).toContain('at least — log full');
  });

  it('leaves the caveat off while the log is still short of capacity, where the count is exact', () => {
    const { container } = renderRail({ activity: activity({ total: 199 }) });

    expect(container.textContent).not.toContain('at least — log full');
  });
});
