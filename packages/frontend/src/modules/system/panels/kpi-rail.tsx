import {
  compactTokens,
  DASH,
  humanCount,
  humanDuration,
  KpiRail,
  parseHubTimestamp,
  type RailStatData,
  StatusBadge,
} from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import { bucketTotal, type FirstByteStats, LOCAL_NODE_KEY, type RoutingBucket, type WaitingNow } from '@/modules/system/pool-node-series';
import { NEAR_BUDGET_SHARE, type Verdict } from '@/modules/system/triage';
import {
  type HardwareSummary,
  hostRamUsedMb,
  type InferenceBackendStatus,
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
 * These twelve figures come from six independently failing queries. Wrapping the rail in one
 * `PanelBody` would blank eleven healthy numbers because residency timed out; wrapping it in none
 * would print a confident dash from a FAILED fetch next to real pool counts. So `RailStatData`
 * takes the state of the query behind each figure, and `RailStat` renders a skeleton, an
 * "unavailable" dash, or the number — see `dense.tsx`.
 *
 * ── Why every routing figure is a 30-minute figure ───────────────────────────────────────────
 *
 * `routingActivity` counts the WHOLE ring buffer, which carries no window at all: on a quiet Hub it
 * spans days (core-2's held eighteen hours), on a busy one twenty minutes, and either way a count
 * beside it reads as a rate. Routed, failed, failovers and first byte are all summed from
 * `routingBuckets` / the same 30-minute window the activity panel draws, so the rail and the chart
 * below it can never disagree about the same half hour — and one bad row can no longer hold a
 * figure (or the verdict) up for as long as it survives in the ring.
 *
 * ── The twelve, and why these twelve ─────────────────────────────────────────────────────────
 *
 * What these Hubs run is agent turns through the pool: 7k-47k-token prompts, a first byte that takes
 * minutes, spread over nodes some of which serve on CPU. So the rail answers, in order: is pooling
 * on and are the peers there; is anything being served or WAITING right now, and for how long; is
 * the host itself short of CPU or RAM; what is resident; how many workloads and whether any is
 * degraded; and over the last half hour, how much was routed, how much failed, how much failed over,
 * and the slowest first byte and where. "Workload CPU" and "Workload RAM" moved to the containers
 * panel, beside the rows they sum; "Forwarded" is in Pool reach, where it was also shown.
 */

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

/** Host CPU as `/system/load` reports it: a 0-100 share of the whole machine, and its core count. */
export interface HostCpuSummary {
  cpuLoad?: number;
  cpuCores?: number;
  /** Where the Hub runs. On `docker-desktop-vm` / `wsl2-vm`, `cpuLoad` is the VM's and `cpuCores` the host's. */
  runtimeKind?: string;
}

/** Above this the host itself is the bottleneck, whatever the workloads on it are doing. */
const HOST_CPU_WARN_PERCENT = 85;

/**
 * The Waiting tile's tone, judged against the request's OWN deadline and at the verdict's threshold.
 *
 * It used to turn amber past a fixed 60 s, which on this fleet is every agent turn: the proxy's budget
 * floor is 300 s (sized at 50 tok/s of prefill), a 40k-token prompt takes minutes to read even on a
 * GPU node (~300 tok/s), and beta-max's first byte for 39,668 tokens was 370,941 ms. So the tile sat
 * amber for most of every turn while the verdict beside it said "All clear" about the same row. Now
 * both read `NEAR_BUDGET_SHARE` of `budgetMs`, and the tile is amber exactly when the chip is up. A
 * row with no budget recorded cannot be judged, so it stays plain rather than guessing.
 */
function waitingTone(waiting: WaitingNow): RailStatData['tone'] {
  const oldest = waiting.oldest;
  if (waiting.count === 0) return 'muted';
  if (!oldest || oldest.budgetMs === null) return 'plain';

  return oldest.ageMs >= NEAR_BUDGET_SHARE * oldest.budgetMs ? 'warn' : 'plain';
}

export function DashboardRail({
  verdict,
  pool,
  poolState,
  reach,
  localNode,
  localLabel,
  workloads,
  degraded,
  containerState,
  sampledAt,
  sampleStale = false,
  hardware,
  hardwareState,
  hostCpu,
  hostCpuState,
  residency,
  residencyState,
  inferenceBackends,
  buckets,
  windowPartial,
  logHeld,
  waiting,
  firstByte,
  startedAt,
  routingState,
  now,
}: {
  verdict: Verdict;
  pool: PoolStatusSummary | undefined;
  poolState: LoadState;
  reach: PoolReach;
  localNode: PoolNodeSummary | undefined;
  /** What `'local'` reads as — "This Hub". */
  localLabel: string;
  workloads: number;
  degraded: number;
  containerState: LoadState;
  sampledAt: string | undefined;
  /** The container sample was already old when the Hub served it — see `STALE_SAMPLE_MS`. */
  sampleStale?: boolean;
  hardware: HardwareSummary | undefined;
  hardwareState: LoadState;
  hostCpu: HostCpuSummary | undefined;
  hostCpuState: LoadState;
  residency: ResidencyReportSummary | undefined;
  residencyState: LoadState;
  /** `/inference/status` backends, to tell an engine that is not running from one that could not say. */
  inferenceBackends: InferenceBackendStatus[] | undefined;
  buckets: RoutingBucket[];
  /** From `routingWindowPartial`: the log held may be missing rows from the window. */
  windowPartial: boolean;
  /** How many rows the log page held, for the caveat that says so. */
  logHeld: number;
  waiting: WaitingNow;
  /** From `firstByteByNode` over the same window as `buckets`. */
  firstByte: Map<string, FirstByteStats>;
  /** The routing log's `startedAt` — this Hub process's start. */
  startedAt: string | undefined;
  routingState: LoadState;
  now: number;
}) {
  const { t } = useTranslation();
  const nodeName = (key: string | null) => (key === null ? DASH : key === LOCAL_NODE_KEY ? localLabel : key);

  const ramTotal = hardware?.ram?.totalMb ?? null;
  const ramUsed = hostRamUsedMb(hardware);
  const ramPercent = ramTotal !== null && ramUsed !== null && ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : null;

  const routed = buckets.reduce((sum, bucket) => sum + bucketTotal(bucket), 0);
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0);
  const failovers = buckets.reduce((sum, bucket) => sum + bucket.failovers, 0);
  const callersLeft = buckets.reduce((sum, bucket) => sum + bucket.clientClosed, 0);
  const overBudget = buckets.reduce((sum, bucket) => sum + bucket.overBudget, 0);
  const refused = buckets.reduce((sum, bucket) => sum + bucket.refused, 0);

  /*
   * The 30-minute counts are a FLOOR, not a total, when the log held may be missing part of the
   * window — the ring evicted, or the page was cut, and the oldest row held is inside the half hour.
   * `routingWindowPartial` decides from the server's own summary; this only says so beside the
   * figures it qualifies.
   */
  const partial = windowPartial ? t('DASHBOARD_RAIL_WINDOW_PARTIAL', { capacity: logHeld }) : undefined;
  const joinSubs = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

  /*
   * An engine that was never asked holds no opinion about residency, so the count beside it is a
   * count of what the engines that COULD answer are holding. Naming the ones that could not is the
   * difference between "nothing is resident" and "we can see three of five engines".
   *
   * But only engines that are RUNNING: an engine that is not installed or not started holds nothing,
   * and says so through `/inference/status`. Naming it here read "Residency unknown for: vllm,
   * lemonade, omlx" on core-2, where all three were down and lemonade answered ECONNREFUSED — three
   * engines listed as a blind spot that were simply off. fzzy, running vLLM with a model in it, is the
   * node the line exists for. Without the status payload the old behaviour stands, since then we
   * cannot tell off from unknown.
   */
  const running = inferenceBackends ? new Set(inferenceBackends.filter((backend) => backend.running === true).map((backend) => backend.type)) : null;
  const residencyUnknown = (residency?.backends ?? [])
    .filter((backend) => backend.source === 'unsupported' || backend.source === 'unreachable')
    .filter((backend) => running === null || running.has(backend.backend))
    .map((backend) => backend.backend);

  // The slowest first byte any node gave in the window, and where. A dash when nothing streamed was
  // served — which is not "fast", it is "no evidence".
  const slowest = [...firstByte.entries()].reduce<[string, FirstByteStats] | null>(
    (worst, entry) => (worst === null || entry[1].maxMs > worst[1].maxMs ? entry : worst),
    null,
  );

  const cpuLoad = typeof hostCpu?.cpuLoad === 'number' && Number.isFinite(hostCpu.cpuLoad) ? Math.round(hostCpu.cpuLoad) : null;
  /*
   * `/system/load`'s `cpuLoad` is `si.currentLoad()` from INSIDE the Hub container, and its
   * `cpuCores` prefers the host probe's count. On Linux those describe the same machine — a
   * container reads the host's `/proc/stat`. On Docker Desktop and WSL2 the container's kernel is a
   * VM's, so the tile printed the VM's load under "Host CPU" beside the HOST's core count — a
   * 4-CPU Docker VM flat out on a 16-core Mac would read "100% · 16 cores" (from the code; no Docker
   * Desktop Hub was exercised). The payload says which runtime it is (`runtimeKind`), so the tile
   * says whose load it is and keeps the host's cores as the host's. `container-only` (no host probe)
   * cannot tell a Linux host from a VM, and keeps "Host".
   */
  const vmCpu = hostCpu?.runtimeKind === 'docker-desktop-vm' || hostCpu?.runtimeKind === 'wsl2-vm' ? hostCpu.runtimeKind : null;
  const oldestWait = waiting.oldest;
  const started = parseHubTimestamp(startedAt);

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
      /*
       * Requests placed and still waiting for a first byte — the one live question about an agent
       * turn that nothing on the page answered, short of finding the amber row in the feed. The
       * oldest wait is named because it is the one nearest its budget; the verdict raises a chip
       * once it passes 80% of it. The age is the node's current attempt (see `waitingNow`), so a
       * request that failed over says so: "3s on core-14" alone would hide that it has been waiting
       * five minutes longer than that somewhere else.
       */
      id: 'waiting',
      value: waiting.count,
      label: t('DASHBOARD_RAIL_WAITING'),
      sub: oldestWait
        ? oldestWait.failovers > 0
          ? t('DASHBOARD_RAIL_WAITING_SUB_FAILED_OVER', {
              age: humanDuration(oldestWait.ageMs),
              node: nodeName(oldestWait.node),
              count: oldestWait.failovers,
            })
          : t('DASHBOARD_RAIL_WAITING_SUB', { age: humanDuration(oldestWait.ageMs), node: nodeName(oldestWait.node) })
        : undefined,
      tone: waitingTone(waiting),
      state: routingState,
      mobile: true,
    },
    {
      // A share of the whole machine, unlike Docker's per-core container CPU — which is why that one
      // is shown as cores, in the containers panel, and never beside this. On Docker Desktop and
      // WSL2 the "machine" is the VM the Hub runs in: see `vmCpu`.
      id: 'host-cpu',
      value: cpuLoad === null ? DASH : `${cpuLoad}%`,
      label: vmCpu ? t('DASHBOARD_RAIL_VM_CPU') : t('DASHBOARD_RAIL_HOST_CPU'),
      sub:
        typeof hostCpu?.cpuCores === 'number' && hostCpu.cpuCores > 0
          ? vmCpu
            ? t(vmCpu === 'wsl2-vm' ? 'DASHBOARD_RAIL_VM_CPU_SUB_WSL' : 'DASHBOARD_RAIL_VM_CPU_SUB_DOCKER', { cores: hostCpu.cpuCores })
            : t('DASHBOARD_RAIL_HOST_CPU_SUB', { cores: hostCpu.cpuCores })
          : undefined,
      tone: cpuLoad === null ? 'muted' : cpuLoad > HOST_CPU_WARN_PERCENT ? 'warn' : 'plain',
      state: hostCpuState,
      mobile: true,
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
      id: 'workloads',
      value: workloads,
      label: t('DASHBOARD_RAIL_WORKLOADS'),
      sub: degraded > 0 ? t('DASHBOARD_RAIL_WORKLOADS_DEGRADED', { count: degraded }) : undefined,
      tone: degraded > 0 ? 'bad' : workloads > 0 ? 'plain' : 'muted',
      state: containerState,
    },
    {
      id: 'routed-30m',
      value: routed,
      label: t('DASHBOARD_RAIL_ROUTED_30M'),
      sub: partial,
      tone: routed > 0 ? 'plain' : 'muted',
      state: routingState,
    },
    {
      /*
       * Settled failures only — a request still waiting is `waiting`, not failed, however long the
       * wait. The sub splits them by the fix each points at: callers who hung up (counted, since they
       * got no answer — but three impatient callers are not three dead nodes), and failures that took
       * a whole first-byte budget to happen, which on this fleet is a prompt placed on a node too slow
       * to read it (fzzy and core-7 serve the 27B on CPU at 27-37 tok/s), and requests a node answered
       * by refusing the request itself — a 4xx, or an engine's verdict on the body — which are the
       * app's to fix. Those were counted as served until 2026-09-29; see `isRefused`.
       */
      id: 'failed-30m',
      value: failed,
      label: t('DASHBOARD_RAIL_FAILED_30M'),
      sub: joinSubs(
        partial,
        overBudget > 0 ? t('DASHBOARD_RAIL_PAST_BUDGET', { count: overBudget }) : undefined,
        callersLeft > 0 ? t('DASHBOARD_RAIL_CALLERS_LEFT', { count: callersLeft }) : undefined,
        refused > 0 ? t('DASHBOARD_RAIL_REFUSED', { count: refused }) : undefined,
      ),
      tone: failed > 0 ? 'bad' : 'muted',
      state: routingState,
    },
    {
      id: 'failovers-30m',
      value: failovers,
      label: t('DASHBOARD_RAIL_FAILOVERS_30M'),
      sub: partial,
      tone: failovers > 0 ? 'warn' : 'muted',
      state: routingState,
    },
    {
      id: 'first-byte-30m',
      value: slowest ? humanDuration(slowest[1].maxMs) : DASH,
      label: t('DASHBOARD_RAIL_FIRST_BYTE_30M'),
      sub: slowest
        ? slowest[1].maxEstTokens === null
          ? nodeName(slowest[0])
          : t('DASHBOARD_RAIL_FIRST_BYTE_SUB', { node: nodeName(slowest[0]), tokens: compactTokens(slowest[1].maxEstTokens) })
        : t('DASHBOARD_RAIL_FIRST_BYTE_NONE'),
      tone: slowest ? 'plain' : 'muted',
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
        <span className="ml-auto flex flex-wrap items-center gap-x-2.5 text-[10px] uppercase tracking-[0.5px] text-muted-foreground">
          {/* The Hub's own uptime, from the routing log's start: the one place a restart shows. Every
              in-memory figure on this page — the ring, the watched series, the 24-sample history —
              starts over at it, so "up 12m" is the reason a quiet page is quiet. */}
          {Number.isFinite(started) ? (
            <span title={t('DASHBOARD_UPTIME_HINT', { time: new Date(started).toLocaleString() })}>
              {t('DASHBOARD_UPTIME', { age: humanDuration(Math.max(0, now - started)) })}
            </span>
          ) : null}
          {/* Amber when the Hub handed over a sample that was already minutes old — its monitor
              failing silently, which the verdict also raises. */}
          {sampledAt ? (
            <span className={cn(sampleStale && 'text-warning')} data-testid="last-sampled">
              {t('RESOURCE_MONITOR_LAST_SAMPLED', { time: new Date(parseHubTimestamp(sampledAt)).toLocaleTimeString() })}
            </span>
          ) : null}
        </span>
      </div>

      <KpiRail stats={stats} />
    </div>
  );
}
