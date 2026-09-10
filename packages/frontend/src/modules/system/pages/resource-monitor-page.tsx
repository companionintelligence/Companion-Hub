import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { DashboardSection, Panel, PanelBody, StatusBadge } from '@/components/ui/dense/dense';
import { localContainerRollup, poolNodeCards } from '@/modules/system/pool-node-series';
import { CpuUsageHistoryChart } from '@/modules/system/panels/cpu-history-chart';
import { HostCapacity, LocalContainers, LocalModels, ModelMemory } from '@/modules/system/panels/local-resources';
import { NetworkModels, NetworkOverview } from '@/modules/system/panels/network-resources';
import { PoolActivity } from '@/modules/system/panels/pool-activity';
import { PoolNodes } from '@/modules/system/panels/pool-nodes';
import { CloudProviders, MiscPanel, PoolSummary } from '@/modules/system/panels/pooling-misc';
import { combineLoadState, loadState, useDashboardData } from '@/modules/system/use-dashboard-data';
import { usePoolSamples } from '@/modules/system/use-pool-samples';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/*
 * The resource dashboard.
 *
 * Three sections, in the order an operator narrows down a problem: what this machine is
 * doing, what the rest of the pool is offering it, and how work was actually distributed
 * between them.
 *
 * Every panel is handed BOTH its data and the state of the query that produced it, and
 * renders its own loading / failed / empty case. That split is the point: an unpaired Hub
 * still gets a full LOCAL section, a Hub whose inference engine is down still gets its
 * containers, and — the case this page previously got wrong — a request that FAILED never
 * renders as a zero or as an empty table. On a monitoring dashboard a confident wrong
 * number is worse than no number.
 *
 * The node cards and the activity feed are the only place the pool is visible AS A POOL rather
 * than as a settings summary. Both are built from `poolNodeCards` and `routingByNode`, which
 * hold the two asymmetries the payload does not make obvious: a local node and a peer measure
 * different quantities under the same field names, and a routing record's `node` means the
 * server on one direction and the sender on the other.
 */

const HISTORY_LIMIT = 12;

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const { containers, pool, routingLog, inference, memory, hardware, cloudProviders } = useDashboardData();

  const containerState = loadState(containers);
  const poolState = loadState(pool);
  const hardwareState = loadState(hardware);

  const apps = containers.data?.apps ?? [];
  const history = containers.data?.history ?? [];
  // Only claim a workload is degraded when the sample that says so actually arrived.
  const degradedApps = containers.data ? apps.filter((app) => app.degraded) : [];
  const peerRows = pool.data?.peers ?? [];
  const localNode = pool.data?.localNode;
  const localLabel = t('DASHBOARD_THIS_HUB');

  const nodeCards = poolNodeCards(localNode, peerRows, {
    localLabel,
    // From `/apps/resource-monitor`, not from pool status, which carries no local rollup at all.
    // `containers.data` being undefined is "not reported" and stays `null` all the way to the card.
    localContainers: localContainerRollup(containers.data?.apps),
    healthPollSeconds: pool.data?.settings?.poolHealthPollSeconds,
    now: Date.now(),
  });

  // Accumulated off the query's own fetch timestamp; a failed poll appends nothing so the series
  // breaks rather than reading as an idle pool.
  const samples = usePoolSamples(nodeCards, pool.dataUpdatedAt, pool.isError);

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-8 px-1 pb-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t('RESOURCE_MONITOR_TITLE')}</h1>
        {/* The badge appears only once the pool has actually answered. A failed status
            query must not resolve to "local only", which is a different claim. */}
        {pool.data ? (
          <StatusBadge connected={!!pool.data.routingActive} label={pool.data.routingActive ? t('DASHBOARD_POOLED') : t('DASHBOARD_LOCAL_ONLY')} />
        ) : null}
        {containers.data?.sampledAt ? (
          <span className="ml-auto text-[11px] uppercase tracking-[0.5px] text-muted-foreground">
            {t('RESOURCE_MONITOR_LAST_SAMPLED', { time: new Date(containers.data.sampledAt).toLocaleTimeString() })}
          </span>
        ) : null}
      </div>

      {degradedApps.length > 0 && (
        <Alert variant="warning">
          <AlertIcon>
            <AlertTriangle strokeWidth={2} />
          </AlertIcon>
          <div>
            <AlertHeading>{t('RESOURCE_MONITOR_DEGRADED_TITLE')}</AlertHeading>
            <AlertDescription>
              {degradedApps.map((app) => app.appName).join(', ')} — {t('RESOURCE_MONITOR_DEGRADED_SUBTITLE')}
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* ── 1. The pool in use ─────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_POOL')}>
        <PoolNodes cards={nodeCards} window={samples} state={poolState} />
        <PoolActivity entries={routingLog.data?.entries ?? []} state={loadState(routingLog)} />
      </DashboardSection>

      {/* ── 2. Local resources ─────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_LOCAL')}>
        <div className="grid gap-4 lg:grid-cols-3">
          <HostCapacity hardware={hardware.data} node={localNode} state={hardwareState} />
          <LocalModels node={localNode} inference={inference.data?.backends} state={poolState} />
          <ModelMemory memory={memory.data} hardware={hardware.data} state={combineLoadState(loadState(memory), hardwareState)} />
        </div>
        <LocalContainers apps={apps} history={history} state={containerState} />
        <Panel title={t('RESOURCE_MONITOR_CHART_TITLE')}>
          <PanelBody state={containerState} error={t('DASHBOARD_CONTAINERS_FAILED')} lines={6}>
            <CpuUsageHistoryChart history={history.slice(-HISTORY_LIMIT)} apps={apps} />
          </PanelBody>
        </Panel>
      </DashboardSection>

      {/* ── 3. Network resources ───────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_NETWORK')}>
        <NetworkOverview peers={peerRows} node={localNode} state={poolState} />
        <NetworkModels peers={peerRows} node={localNode} localLabel={localLabel} state={poolState} />
      </DashboardSection>

      {/* ── 4. AI pooling and misc ─────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_POOLING')}>
        <PoolSummary pool={pool.data} state={poolState} />
        <div className="grid gap-4 lg:grid-cols-2">
          <CloudProviders providers={cloudProviders.data} state={loadState(cloudProviders)} />
          <MiscPanel pool={pool.data} hardware={hardware.data} poolState={poolState} hardwareState={hardwareState} />
        </div>
      </DashboardSection>
    </div>
  );
}
