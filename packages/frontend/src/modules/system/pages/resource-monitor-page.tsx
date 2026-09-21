import { BandHeader } from '@/components/ui/dense/dense';
import { DashboardRail } from '@/modules/system/panels/kpi-rail';
import { HostCapacity, LocalContainers, LocalModels, ModelMemory } from '@/modules/system/panels/local-resources';
import { NetworkModels, NetworkOverview } from '@/modules/system/panels/network-resources';
import { PoolActivity } from '@/modules/system/panels/pool-activity';
import { PoolNodes } from '@/modules/system/panels/pool-nodes';
import { CloudProviders, MiscPanel, poolConfigWarnings, PoolSummary } from '@/modules/system/panels/pooling-misc';
import { WorkloadCoverage } from '@/modules/system/panels/workload-coverage';
import { WorkloadTrend } from '@/modules/system/panels/workload-trends';
import { localContainerRollup, poolNodeCards, routingActivity, routingBuckets } from '@/modules/system/pool-node-series';
import { pageVerdict } from '@/modules/system/triage';
import { combineLoadState, loadState, poolReach, useDashboardData } from '@/modules/system/use-dashboard-data';
import { usePoolSamples } from '@/modules/system/use-pool-samples';
import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * The resource dashboard: ONE TWELVE-COLUMN BOARD, banded rather than sectioned.
 *
 * The page this replaces was four `DashboardSection`s stacked at `space-y-8`. Each owned its own
 * grid, so a panel in one could never sit beside a panel in the next, and at 1440×900 an operator
 * saw a 40px title, a section rule and two ~270px node cards — thirteen measured values, NONE of
 * them about this machine, and no statement anywhere about whether anything was wrong. The bands
 * here are `col-span-full` labels inside a single grid, so every panel is measured against the
 * same twelve columns and the page opens on a verdict plus twelve numbers.
 *
 * Band order is the order an operator narrows down a problem: what THIS machine's workloads are
 * doing, what the machine underneath them has, what the pool did with the work, what the pool is
 * offering, and — folded into a drawer, because it changes on a human timescale of weeks — the
 * configuration behind all of it.
 *
 * ── What has NOT changed, and must not ───────────────────────────────────────────────────────
 *
 * Every panel is still handed BOTH its data and the state of the query that produced it, and
 * renders its own loading / failed / empty case. An unpaired Hub still gets a full local band, a
 * Hub whose inference engine is down still gets its containers, and a request that FAILED never
 * renders as a zero or as an empty table. On a monitoring dashboard a confident wrong number is
 * worse than no number — which is also why the rail's verdict has three states rather than two.
 *
 * ── Why everything derived is derived HERE ───────────────────────────────────────────────────
 *
 * `buckets`, `rollup`, `reach` and `activity` are computed once at page level and passed down.
 * The rail's "routed in the last 30 minutes" and the activity panel's per-minute bars are the
 * same measurement shown twice; deriving them separately is how two figures about the same half
 * hour come to disagree because a poll landed between two calls to `Date.now()`.
 */

/*
 * The backend's `MONITOR_HISTORY_LIMIT` is 24 and the payload always carries all of it. The old
 * value of 12 threw away half of an already-fetched history for no saving of any kind — 24 costs
 * nothing over the wire and doubles the window every trend row draws.
 */
const HISTORY_LIMIT = 24;

const BUCKET_MS = 60_000;
const BUCKET_COUNT = 30;

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const { containers, pool, routingLog, inference, memory, residency, hardware, cloudProviders } = useDashboardData();

  const containerState = loadState(containers);
  const poolState = loadState(pool);
  const hardwareState = loadState(hardware);
  const routingState = loadState(routingLog);
  const residencyState = loadState(residency);

  const now = Date.now();
  const apps = containers.data?.apps ?? [];
  const history = containers.data?.history ?? [];
  // Only claim a workload is degraded when the sample that says so actually arrived.
  const degradedApps = containers.data ? apps.filter((app) => app.degraded) : [];
  const peerRows = pool.data?.peers ?? [];
  const localNode = pool.data?.localNode;
  const localLabel = t('DASHBOARD_THIS_HUB');
  const entries = routingLog.data?.entries ?? [];

  // From `/apps/resource-monitor`, not from pool status, which carries no local rollup at all.
  // `containers.data` being undefined is "not reported" and stays `null` all the way down.
  const rollup = localContainerRollup(containers.data?.apps);

  const nodeCards = poolNodeCards(localNode, peerRows, {
    localLabel,
    localContainers: rollup,
    healthPollSeconds: pool.data?.settings?.poolHealthPollSeconds,
    now,
  });

  // Accumulated off the query's own fetch timestamp; a failed poll appends nothing so the series
  // breaks rather than reading as an idle pool.
  const samples = usePoolSamples(nodeCards, pool.dataUpdatedAt, pool.isError);

  const reach = poolReach(peerRows, localNode);
  const activity = routingActivity(entries);
  const buckets = useMemo(() => routingBuckets(entries, { now, bucketMs: BUCKET_MS, buckets: BUCKET_COUNT }), [entries, now]);

  // One derivation of "is anything in the configuration quietly not doing what it says", read by
  // both the drawer's badge and the verdict, so the two can never disagree.
  const configWarnings = poolConfigWarnings(pool.data);

  const verdict = pageVerdict({
    containers: { state: containerState, degraded: degradedApps.length },
    pool: {
      state: poolState,
      unreachablePeers: reach.unreachable,
      probeFailures: peerRows.filter((peer) => (peer.consecutiveFailures ?? 0) > 0).length,
      stalePins: configWarnings.stalePins,
      envDisabledDirections: configWarnings.envDisabledDirections,
      capabilitiesError: configWarnings.capabilitiesError,
    },
    routing: { state: routingState, unplaced: activity.unplaced },
    // Queries with no fault of their own, but which still have to have RUN before the verdict is
    // allowed to say everything was checked.
    otherStates: [loadState(inference), loadState(memory), hardwareState, loadState(cloudProviders), residencyState],
    t: (key: string, vars?: Record<string, unknown>) => t(key, vars),
  });

  return (
    <div className="mx-auto grid w-full grid-cols-1 gap-x-3 gap-y-2.5 px-1 pb-12 md:grid-cols-2 xl:grid-cols-12">
      {/* Masthead, verdict and twelve figures, in the band that used to hold a title and nothing
          else. The degraded-workload `<Alert>` that used to sit below it is gone: it is a fault
          chip in here now, so there is one loud element on the page rather than two. */}
      <DashboardRail
        verdict={verdict}
        pool={pool.data}
        poolState={poolState}
        reach={reach}
        localNode={localNode}
        workloads={apps.length}
        degraded={degradedApps.length}
        rollup={rollup}
        containerState={containerState}
        sampledAt={containers.data?.sampledAt}
        hardware={hardware.data}
        hardwareState={hardwareState}
        residency={residency.data}
        residencyState={residencyState}
        buckets={buckets}
        activity={activity}
        routingState={routingState}
      />

      {/* ── A. Workloads on this machine ──────────────────────────────────── */}
      {/* Four equal tiles in one row: three measured metrics and, in the last slot, a statement of
          what is STILL not measured per workload (compute utilization, and tokens). The coverage
          tile deliberately has no plot rectangle of its own — an empty chart frame beside a
          populated one reads as loading-or-broken, which is the absence/idleness collision this
          page exists to avoid, wearing a different costume. */}
      <BandHeader title={t('DASHBOARD_BAND_WORKLOAD')} />
      <WorkloadTrend
        metric="cpu"
        history={history.slice(-HISTORY_LIMIT)}
        apps={apps}
        state={containerState}
        className="col-span-full md:col-span-1 xl:col-span-3"
      />
      <WorkloadTrend
        metric="memory"
        history={history.slice(-HISTORY_LIMIT)}
        apps={apps}
        state={containerState}
        className="col-span-full md:col-span-1 xl:col-span-3"
      />
      <WorkloadTrend
        metric="gpu"
        history={history.slice(-HISTORY_LIMIT)}
        apps={apps}
        state={containerState}
        gpuVramSource={containers.data?.gpuVramSource}
        className="col-span-full md:col-span-1 xl:col-span-3"
      />
      <WorkloadCoverage
        hardware={hardware.data}
        gpuVramSource={containers.data?.gpuVramSource}
        className="col-span-full md:col-span-1 xl:col-span-3"
      />

      {/* ── B. This machine ───────────────────────────────────────────────── */}
      <BandHeader title={t('DASHBOARD_BAND_MACHINE')} />
      <HostCapacity hardware={hardware.data} node={localNode} state={hardwareState} className="col-span-full md:col-span-1 xl:col-span-3" />
      <ModelMemory
        memory={memory.data}
        hardware={hardware.data}
        state={combineLoadState(loadState(memory), hardwareState)}
        className="col-span-full md:col-span-1 xl:col-span-3"
      />
      <LocalContainers apps={apps} history={history} state={containerState} className="col-span-full md:col-span-2 xl:col-span-6" />

      {/* ── C. The pool in use ────────────────────────────────────────────── */}
      <BandHeader title={t('DASHBOARD_BAND_POOL')} />
      <PoolNodes cards={nodeCards} window={samples} state={poolState} className="col-span-full md:col-span-2 xl:col-span-5" />
      <PoolActivity entries={entries} buckets={buckets} state={routingState} className="col-span-full md:col-span-2 xl:col-span-7" />

      {/* ── D. What the pool offers ───────────────────────────────────────── */}
      {/* Three equal spans, not 4+8 then a stray 4. NetworkOverview and NetworkModels summed to
          exactly 12, so LocalModels was auto-placed onto a second row and sat alone against eight
          empty columns — the dead space this rebuild exists to remove. Ordered local → overview →
          index to match the band's own question: what do WE offer, then what does the pool. */}
      <BandHeader title={t('DASHBOARD_BAND_OFFERS')} />
      <LocalModels node={localNode} inference={inference.data?.backends} state={poolState} className="col-span-full md:col-span-1 xl:col-span-4" />
      <NetworkOverview peers={peerRows} node={localNode} state={poolState} className="col-span-full md:col-span-1 xl:col-span-4" />
      <NetworkModels
        peers={peerRows}
        node={localNode}
        localLabel={localLabel}
        state={poolState}
        className="col-span-full md:col-span-2 xl:col-span-4"
      />

      {/* ── E. Configuration ──────────────────────────────────────────────── */}
      {/*
       * A drawer, not a band: these settings change on a timescale of weeks, and two full-width
       * sections of them were pushing the live numbers off the first screen. Collapsed it costs
       * 40px.
       *
       * `open` is passed rather than held in state on purpose. React only writes the DOM property
       * when the prop CHANGES, so this behaves as a default that re-asserts itself when a warning
       * first appears and otherwise leaves the operator's own toggle alone. And a non-zero count
       * cannot be the only signal — every fact behind it also raises a fault chip in the rail.
       */}
      <details className="group col-span-full rounded-lg border border-border bg-card" open={configWarnings.total > 0}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-[12px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          {t('DASHBOARD_BAND_CONFIG')}
          {configWarnings.total > 0 ? (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-warning">
              {t('DASHBOARD_BAND_CONFIG_WARN', { count: configWarnings.total })}
            </span>
          ) : null}
          <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" strokeWidth={2} />
        </summary>
        <div className="grid gap-x-3 gap-y-2.5 border-t border-border px-3 py-2.5 md:grid-cols-2 xl:grid-cols-3">
          <PoolSummary pool={pool.data} state={poolState} />
          <CloudProviders providers={cloudProviders.data} state={loadState(cloudProviders)} />
          <MiscPanel pool={pool.data} hardware={hardware.data} poolState={poolState} hardwareState={hardwareState} />
        </div>
      </details>
    </div>
  );
}
