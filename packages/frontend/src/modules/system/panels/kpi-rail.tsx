import { DASH, humanBytes, humanCount, KpiRail, type RailStatData, StatusBadge } from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import type { NodeContainers, RoutingActivity, RoutingBucket } from '@/modules/system/pool-node-series';
import type { Verdict } from '@/modules/system/triage';
import {
  type HardwareSummary,
  hostRamUsedMb,
  type LoadState,
  type PoolNodeSummary,
  type PoolReach,
  type PoolStatusSummary,
  type ResidencyReportSummary,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * THE RAIL — the page's headline, its verdict and its twelve numbers, in one 64px band.
 *
 * It replaces a 40px `<h1>` block that carried no data at all, plus a standalone degraded
 * `<Alert>` that cost another ~76px whenever it fired. Both are folded in here: the alert is now
 * a fault chip beside the verdict, so there is ONE loud element on the page rather than two
 * competing for the same glance.
 *
 * ── The three-state verdict ──────────────────────────────────────────────────────────────────
 *
 * See `triage.ts`. The short version: a green ALL CLEAR is a claim that every check ran, so it is
 * unreachable while any query is failing; that case gets its own third state instead. Faults are
 * derived only from queries that ANSWERED — "we could not check" and "we checked and it is broken"
 * are never allowed to render as the same thing.
 *
 * ── Why every stat carries its own load state ────────────────────────────────────────────────
 *
 * These twelve figures come from five independently failing queries. Wrapping the rail in one
 * `PanelBody` would blank eleven healthy numbers because residency timed out; wrapping it in none
 * would print a confident dash from a FAILED fetch next to real pool counts. So `RailStatData`
 * takes the state of the query behind each figure, and `RailStat` renders a skeleton, an
 * "unavailable" dash, or the number — see `dense.tsx`.
 *
 * ── Why the 30-minute counts are not `routingActivity().total` ───────────────────────────────
 *
 * `routingActivity` counts the WHOLE 200-entry ring buffer, which carries no window at all: on a
 * quiet Hub it spans days, on a busy one twenty minutes, and either way "routed" beside it reads
 * as a rate. Keys 10 and 11 sum `routingBuckets`, the same buckets the activity panel draws, so
 * the rail and the chart below it can never disagree about the same half hour.
 */

/*
 * Mirrors `ROUTING_LOG_CAPACITY` in `packages/backend/src/modules/hub-pool/hub-pool-routing-log.service.ts`.
 * Duplicated rather than imported because the frontend does not depend on the backend package, and
 * it is not on the wire — `/pool/routing-log` returns entries, never the bound it kept them under.
 * A backend that raised the capacity without touching this would only make the caveat below fire
 * early, which is the safe direction: it over-qualifies a number instead of overstating one.
 */
const ROUTING_LOG_CAPACITY = 200;

function VerdictLine({ verdict }: { verdict: Verdict }) {
  const { t } = useTranslation();

  const label =
    verdict.kind === 'faults'
      ? t('DASHBOARD_VERDICT_FAULTS', { count: verdict.faults.length })
      : verdict.kind === 'partial'
        ? t('DASHBOARD_VERDICT_PARTIAL', { count: verdict.unavailable })
        : verdict.kind === 'clear'
          ? t('DASHBOARD_VERDICT_CLEAR')
          : t('DASHBOARD_VERDICT_PENDING');

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
          verdict.kind === 'faults'
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : verdict.kind === 'clear'
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-border/70 bg-muted/30 text-muted-foreground',
        )}
      >
        {label}
      </span>
      {verdict.faults.map((fault) => (
        <span
          key={fault.id}
          className={cn(
            'rounded-md border px-1.5 py-0.5 text-[10px]',
            fault.tone === 'bad' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-warning/40 bg-warning/10 text-warning',
          )}
        >
          {fault.label}
        </span>
      ))}
      {/* Faults and unavailable checks are shown TOGETHER, never one instead of the other: a
          machine can be both broken and half-unread, and hiding the second behind the first is
          how an operator ends up trusting a partial picture. */}
      {verdict.kind === 'faults' && verdict.unavailable > 0 ? (
        <span className="rounded-md border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t('DASHBOARD_VERDICT_ALSO_UNAVAILABLE', { count: verdict.unavailable })}
        </span>
      ) : null}
    </div>
  );
}

export function DashboardRail({
  verdict,
  pool,
  poolState,
  reach,
  localNode,
  workloads,
  degraded,
  rollup,
  containerState,
  sampledAt,
  hardware,
  hardwareState,
  residency,
  residencyState,
  buckets,
  activity,
  routingState,
}: {
  verdict: Verdict;
  pool: PoolStatusSummary | undefined;
  poolState: LoadState;
  reach: PoolReach;
  localNode: PoolNodeSummary | undefined;
  workloads: number;
  degraded: number;
  /** The local container rollup, or `null` when `/apps/resource-monitor` reported nothing. */
  rollup: NodeContainers | null;
  containerState: LoadState;
  sampledAt: string | undefined;
  hardware: HardwareSummary | undefined;
  hardwareState: LoadState;
  residency: ResidencyReportSummary | undefined;
  residencyState: LoadState;
  buckets: RoutingBucket[];
  activity: RoutingActivity;
  routingState: LoadState;
}) {
  const { t } = useTranslation();

  const ramTotal = hardware?.ram?.totalMb ?? null;
  const ramUsed = hostRamUsedMb(hardware);
  const ramPercent = ramTotal !== null && ramUsed !== null && ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : null;

  const routed = buckets.reduce((sum, bucket) => sum + bucket.served + bucket.failed, 0);
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);

  /*
   * The 30-minute counts are a FLOOR, not a total, once the log is full.
   *
   * `/pool/routing-log` serves a ring buffer of `ROUTING_LOG_CAPACITY = 200` that evicts its oldest
   * entry silently. Bucketing what survives is correct arithmetic on the wrong denominator: a Hub
   * busy enough to turn over 200 requests inside half an hour has already dropped part of the
   * window, and "Routed 30m · 200" then understates by however much was evicted — with nothing
   * anywhere near the number to say so. Precisely the Hubs under real load report the most wrong.
   *
   * A full ring is the one signal available here that eviction is possible, so it qualifies the
   * figure rather than silently rounding it down. Below capacity nothing was ever dropped and the
   * count is exact, so the caveat stays off.
   */
  const windowPartial = activity.total >= ROUTING_LOG_CAPACITY;

  /*
   * An engine that was never asked holds no opinion about residency, so the count beside it is a
   * count of what the engines that COULD answer are holding. Naming the ones that could not is the
   * difference between "nothing is resident" and "we can see three of five engines".
   */
  const residencyUnknown = (residency?.backends ?? [])
    .filter((backend) => backend.source === 'unsupported' || backend.source === 'unreachable')
    .map((backend) => backend.backend);

  const stats: RailStatData[] = [
    {
      id: 'routing',
      value: pool?.routingActive ? t('DASHBOARD_POOLED') : t('DASHBOARD_LOCAL_ONLY'),
      label: t('DASHBOARD_RAIL_ROUTING'),
      // The reason routing is off used to hang under a chip in the pool-settings panel, which is
      // now inside a collapsed drawer. "Local only" without it is a state with no cause, so the
      // cause moves with the claim.
      sub: pool?.reason ? t(`DASHBOARD_REASON_${pool.reason.toUpperCase()}`, { defaultValue: pool.reason }) : undefined,
      tone: pool?.routingActive ? 'ok' : 'muted',
      state: poolState,
      mobile: true,
    },
    {
      id: 'peers',
      value: reach.connected,
      label: t('DASHBOARD_RAIL_PEERS'),
      sub: reach.unreachable > 0 ? t('DASHBOARD_RAIL_PEERS_UNREACHABLE', { count: reach.unreachable }) : undefined,
      tone: reach.unreachable > 0 ? 'bad' : reach.connected > 0 ? 'ok' : 'muted',
      state: poolState,
      mobile: true,
    },
    {
      id: 'in-flight',
      // Dash, not 0: a counter the node never reported is unread, not idle.
      value: humanCount(localNode?.inFlightRequests),
      label: t('DASHBOARD_RAIL_IN_FLIGHT'),
      tone: (localNode?.inFlightRequests ?? 0) > 0 ? 'ok' : 'muted',
      state: poolState,
      mobile: true,
    },
    {
      id: 'forwarded',
      // `null` means no connected peer reported the counter — unknown, not zero forwarded.
      value: reach.peerInFlight ?? DASH,
      label: t('DASHBOARD_RAIL_FORWARDED'),
      tone: (reach.peerInFlight ?? 0) > 0 ? 'ok' : 'muted',
      state: poolState,
    },
    {
      id: 'workloads',
      value: workloads,
      label: t('DASHBOARD_RAIL_WORKLOADS'),
      sub: degraded > 0 ? t('DASHBOARD_RAIL_WORKLOADS_DEGRADED', { count: degraded }) : undefined,
      tone: degraded > 0 ? 'bad' : workloads > 0 ? 'plain' : 'muted',
      state: containerState,
      mobile: true,
    },
    {
      id: 'workload-cpu',
      value: rollup ? `${Math.round(rollup.cpuPercent)}%` : DASH,
      label: t('DASHBOARD_RAIL_WORKLOAD_CPU'),
      tone: rollup ? 'plain' : 'muted',
      state: containerState,
      mobile: true,
    },
    {
      id: 'workload-mem',
      value: humanBytes(rollup?.memoryBytes ?? null),
      label: t('DASHBOARD_RAIL_WORKLOAD_MEM'),
      tone: rollup ? 'plain' : 'muted',
      state: containerState,
    },
    {
      id: 'ram',
      value: ramPercent === null ? DASH : `${ramPercent}%`,
      label: t('DASHBOARD_RAIL_RAM'),
      tone: ramPercent === null ? 'muted' : ramPercent > 90 ? 'warn' : 'plain',
      state: hardwareState,
      mobile: true,
    },
    {
      id: 'resident',
      value: humanCount(residency?.residentCount),
      label: t('DASHBOARD_RAIL_RESIDENT'),
      sub: residencyUnknown.length > 0 ? t('DASHBOARD_RESIDENCY_UNKNOWN', { engines: residencyUnknown.join(', ') }) : undefined,
      tone: (residency?.residentCount ?? 0) > 0 ? 'ok' : 'muted',
      state: residencyState,
    },
    {
      id: 'routed-30m',
      value: routed,
      label: t('DASHBOARD_RAIL_ROUTED_30M'),
      sub: windowPartial ? t('DASHBOARD_RAIL_WINDOW_PARTIAL') : undefined,
      tone: routed > 0 ? 'plain' : 'muted',
      state: routingState,
    },
    {
      id: 'failed-30m',
      value: failed,
      label: t('DASHBOARD_RAIL_FAILED_30M'),
      sub: windowPartial ? t('DASHBOARD_RAIL_WINDOW_PARTIAL') : undefined,
      tone: failed > 0 ? 'bad' : 'muted',
      state: routingState,
    },
    {
      id: 'failovers',
      value: activity.failovers,
      label: t('DASHBOARD_RAIL_FAILOVERS'),
      /* Sits between two figures that ARE windowed, and is not one: `activity` counts the whole ring.
         Without saying so, adjacency alone makes it read as "failovers in the last 30 minutes" —
         the same conflation the header comment above rejects for `routed`/`failed`. Buckets carry
         served/failed only, so there is no windowed failover count to swap in; the honest move is to
         label the window it actually has. */
      sub: t('DASHBOARD_RAIL_FAILOVERS_SUB'),
      tone: activity.failovers > 0 ? 'warn' : 'muted',
      state: routingState,
    },
  ];

  return (
    /*
     * In flow, not sticky: a rail parked under the fixed header cost ~100px of every scroll
     * position on the board, and the figures it holds are one flick away at the top anyway.
     */
    <div className="col-span-full -mx-1 border-b border-border/60 px-1 py-1.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h1 className="text-sm font-bold uppercase tracking-[0.1em]">{t('RESOURCE_MONITOR_TITLE')}</h1>
        {/* The badge appears only once the pool has actually answered. A failed status query
            must not resolve to "local only", which is a different claim. */}
        {pool ? (
          <StatusBadge connected={!!pool.routingActive} label={pool.routingActive ? t('DASHBOARD_POOLED') : t('DASHBOARD_LOCAL_ONLY')} />
        ) : null}
        <VerdictLine verdict={verdict} />
        {sampledAt ? (
          <span className="ml-auto text-[10px] uppercase tracking-[0.5px] text-muted-foreground">
            {t('RESOURCE_MONITOR_LAST_SAMPLED', { time: new Date(sampledAt).toLocaleTimeString() })}
          </span>
        ) : null}
      </div>

      <KpiRail stats={stats} />
    </div>
  );
}
