import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { DashboardSection, Panel, PanelBody, StatusBadge } from '@/components/ui/dense/dense';
import { CpuUsageHistoryChart } from '@/modules/system/panels/cpu-history-chart';
import { HostCapacity, LocalContainers, LocalModels, ModelMemory } from '@/modules/system/panels/local-resources';
import { NetworkContainers, NetworkModels, NetworkNodes, NetworkOverview } from '@/modules/system/panels/network-resources';
import { CloudProviders, MiscPanel, PoolSummary, RoutingLog } from '@/modules/system/panels/pooling-misc';
import { combineLoadState, loadState, useDashboardData } from '@/modules/system/use-dashboard-data';
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

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-1 pb-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold tracking-tight">{t('RESOURCE_MONITOR_TITLE')}</h1>
        {/* The badge appears only once the pool has actually answered. A failed status
            query must not resolve to "local only", which is a different claim. */}
        {pool.data ? (
          <StatusBadge connected={!!pool.data.routingActive} label={pool.data.routingActive ? t('DASHBOARD_POOLED') : t('DASHBOARD_LOCAL_ONLY')} />
        ) : null}
        {containers.data?.sampledAt ? (
          <span className="ml-auto text-[10px] uppercase tracking-[0.5px] text-muted-foreground">
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

      {/* ── 1. Local resources ─────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_LOCAL')}>
        <div className="grid gap-3 lg:grid-cols-3">
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

      {/* ── 2. Network resources ───────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_NETWORK')}>
        <div className="grid gap-3 lg:grid-cols-3">
          <NetworkOverview peers={peerRows} node={localNode} state={poolState} />
          <div className="lg:col-span-2">
            <NetworkNodes peers={peerRows} state={poolState} />
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <NetworkModels peers={peerRows} node={localNode} localLabel={localLabel} state={poolState} />
          </div>
          <NetworkContainers peers={peerRows} state={poolState} />
        </div>
      </DashboardSection>

      {/* ── 3. AI pooling and misc ─────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_POOLING')}>
        <PoolSummary pool={pool.data} state={poolState} />
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <RoutingLog entries={routingLog.data?.entries ?? []} state={loadState(routingLog)} />
          </div>
          <div className="space-y-3">
            <CloudProviders providers={cloudProviders.data} state={loadState(cloudProviders)} />
            <MiscPanel pool={pool.data} hardware={hardware.data} poolState={poolState} hardwareState={hardwareState} />
          </div>
        </div>
      </DashboardSection>
    </div>
  );
}
