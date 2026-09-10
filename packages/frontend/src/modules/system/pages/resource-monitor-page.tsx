import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { DashboardSection, Panel, StatusBadge } from '@/components/ui/dense/dense';
import { CpuUsageHistoryChart } from '@/modules/system/panels/cpu-history-chart';
import { HostCapacity, LocalContainers, LocalModels, ResidentModels } from '@/modules/system/panels/local-resources';
import { NetworkContainers, NetworkModels, NetworkNodes, NetworkOverview } from '@/modules/system/panels/network-resources';
import { MiscPanel, PoolSummary, RoutingLog } from '@/modules/system/panels/pooling-misc';
import { useDashboardData } from '@/modules/system/use-dashboard-data';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/*
 * The resource dashboard.
 *
 * Three sections, in the order an operator narrows down a problem: what this machine is
 * doing, what the rest of the pool is offering it, and how work was actually
 * distributed between them.
 *
 * Every panel sources its own query and renders its own empty state, so an unpaired Hub
 * still gets a full LOCAL section, and a Hub whose inference engine is down still gets
 * its containers. The page never blanks on one failed request.
 */

const HISTORY_LIMIT = 12;

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const { containers, pool, peers, routingLog, inference, hardware, residency } = useDashboardData();

  const apps = containers.data?.apps ?? [];
  const history = containers.data?.history ?? [];
  const degradedApps = apps.filter((app) => app.degraded);
  const peerRows = peers.data ?? [];
  const localNode = pool.data?.localNode;
  const localLabel = t('DASHBOARD_THIS_HUB');
  const poolReachable = !pool.isError && !!pool.data;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-1 pb-20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-bold tracking-tight">{t('RESOURCE_MONITOR_TITLE')}</h1>
        {poolReachable ? (
          <StatusBadge connected={!!pool.data?.routingActive} label={pool.data?.routingActive ? t('DASHBOARD_POOLED') : t('DASHBOARD_LOCAL_ONLY')} />
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

      {/* ── 1. Local ───────────────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_LOCAL')}>
        <div className="grid gap-3 lg:grid-cols-3">
          <HostCapacity hardware={hardware.data} node={localNode} />
          {/* Held (on disk) and resident (in memory) are separate panels on purpose — on a
              live node they read 11 and 0, and merging them is the bug this pair exists to
              stop repeating. */}
          <LocalModels node={localNode} inference={inference.data?.backends} />
          <ResidentModels residency={residency.data} />
        </div>
        <div className="grid gap-3 lg:grid-cols-1">
          <LocalContainers apps={apps} history={history} />
        </div>
        <Panel title={t('RESOURCE_MONITOR_CHART_TITLE')}>
          <CpuUsageHistoryChart history={history.slice(-HISTORY_LIMIT)} apps={apps} />
        </Panel>
      </DashboardSection>

      {/* ── 2. Network ─────────────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_NETWORK')}>
        <div className="grid gap-3 lg:grid-cols-3">
          <NetworkOverview peers={peerRows} node={localNode} />
          <div className="lg:col-span-2">
            <NetworkNodes peers={peerRows} />
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <NetworkModels peers={peerRows} node={localNode} localLabel={localLabel} />
          </div>
          <NetworkContainers peers={peerRows} />
        </div>
      </DashboardSection>

      {/* ── 3. Pooling and misc ────────────────────────────────────────────── */}
      <DashboardSection title={t('DASHBOARD_SECTION_POOLING')}>
        <PoolSummary pool={pool.data} />
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <RoutingLog entries={routingLog.data?.entries ?? []} />
          </div>
          <MiscPanel pool={pool.data} hardware={hardware.data} />
        </div>
      </DashboardSection>
    </div>
  );
}
