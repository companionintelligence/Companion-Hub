import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import {
  customDomainAwaitingRestart,
  PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY,
  queryPublicWebDiagnostics,
  type PublicWebDiagnosticsApp,
} from '@/lib/cloudflare-api';
import { CustomDomainRestartBanner } from '@/modules/app/components/custom-domain-restart-banner';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAppContext } from '@/context/app-context';
import { BatchActionsMenu } from '../components/batch-actions-menu';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { QueuedInstallsIndicator } from '../components/queued-installs-indicator';
import { useInstallQueue } from '@/modules/app/helpers/use-install-queue';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { Button } from '@/components/ui/Button';
import { diskStatCopy } from './disk-stat';

type DashboardLocationState = {
  showBackgroundInstallToast?: boolean;
};

/** Stable identity for "no report yet", so the memos below actually memoize. */
const NO_DIAGNOSTICS: PublicWebDiagnosticsApp[] = [];

export default () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const state = location.state as DashboardLocationState | null;
    if (!state?.showBackgroundInstallToast) return;

    toast.info(t('DASHBOARD_SETUP_RUNNING_BACKGROUND'), { duration: 8000 });

    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
  }, [location.hash, location.pathname, location.search, location.state, navigate, t]);

  // Surface the outcome of a memory-connect attempt that bounced back here (the
  // Hub's memory-connect start/callback redirect to `/?memoryConnect=…`, preserved
  // across the root redirect). Toast once with a stable id (idempotent under
  // StrictMode's double-invoke), then strip the marker so a refresh doesn't repeat it.
  useEffect(() => {
    const marker = searchParams.get('memoryConnect');
    if (marker !== 'error' && marker !== 'unavailable') return;

    toast.error(t(marker === 'unavailable' ? 'MEMORY_CONNECT_UNAVAILABLE_TOAST' : 'MEMORY_CONNECT_ERROR_TOAST'), { id: 'memory-connect-result' });

    const next = new URLSearchParams(searchParams);
    next.delete('memoryConnect');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, t]);

  const {
    data: systemData,
    isPending: systemPending,
    isError: systemError,
    refetch: refetchSystem,
  } = useQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
    staleTime: 30_000,
  });

  const {
    data: appsData,
    isPending: appsPending,
    isError: appsError,
    refetch: refetchApps,
  } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const { data: installQueue, isLoading: installQueueLoading } = useInstallQueue();
  const { updatesAvailable } = useAppContext();

  // What each batch action would act on, so the menu can say "nothing to stop" instead of running an empty sweep.
  const installedApps = appsData?.installed ?? [];
  const runningCount = installedApps.filter(({ app }) => app.status === 'running').length;
  const stoppedCount = installedApps.filter(({ app }) => app.status === 'stopped').length;

  /*
   * The installed-apps payload carries `pendingRestart`, which is enough for the
   * per-app badge. It cannot say WHY, and only one reason is worth interrupting an
   * operator over — a bound custom domain that is dark. That verdict is the Hub's
   * to make, so it is read from the diagnostics report rather than guessed at here.
   *
   * A failure is not surfaced: this decorates the page, and an unreachable report
   * should leave the dashboard exactly as it was rather than raise an error over
   * something nobody asked for.
   */
  const { data: publicWebDiagnostics } = useQuery({
    queryKey: PUBLIC_WEB_DIAGNOSTICS_QUERY_KEY,
    queryFn: queryPublicWebDiagnostics,
    staleTime: 30_000,
  });

  // A shared constant, not `?? []` inline: the literal would be a fresh array on
  // every render while the report is absent — which is the whole pending window,
  // and forever on a Hub whose endpoint errors — and the memo below would never hold.
  const diagnosticsApps = publicWebDiagnostics?.apps ?? NO_DIAGNOSTICS;

  const customDomainsAwaitingRestart = useMemo(() => {
    const byUrn: Record<string, string> = {};
    for (const entry of diagnosticsApps) {
      const domain = customDomainAwaitingRestart(entry);
      if (domain) byUrn[entry.appUrn] = domain;
    }
    return byUrn;
  }, [diagnosticsApps]);

  const appNamesByUrn = useMemo(() => {
    const byUrn: Record<string, string> = {};
    for (const installed of appsData?.installed ?? []) {
      if (installed.info?.urn) byUrn[installed.info.urn] = installed.info.name ?? installed.info.urn;
    }
    return byUrn;
  }, [appsData]);

  const statsLoading = systemPending && !systemData;
  const memoryUsed = systemData?.memoryUsed ?? (systemData ? Math.round((systemData.memoryTotal * systemData.percentUsedMemory) / 100) : 0);

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="home">
      <div className="flex flex-col gap-4 pt-2 pb-4 px-1">
        {/* System stats — stacked on mobile, three columns from sm */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {systemError ? (
            <div className="col-span-full flex flex-col items-start gap-2 py-2">
              <p className="text-sm text-muted-foreground">{t('DASHBOARD_STATS_FAILED')}</p>
              <Button type="button" variant="outline" onClick={() => refetchSystem()}>
                {t('COMMON_RETRY')}
              </Button>
            </div>
          ) : statsLoading || !systemData ? (
            <div className="col-span-full flex justify-center py-4">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              <CompactSystemStat isLoading={false} title={t('DASHBOARD_DISK_SPACE_TITLE')} icon={Database} {...diskStatCopy(systemData, t)} />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_CPU_TITLE')}
                metric={`${systemData.cpuLoad.toFixed(2)}%`}
                subtitle={systemData.cpuCores ? t('DASHBOARD_CPU_CORES', { count: systemData.cpuCores }) : undefined}
                icon={Cpu}
                progress={systemData.cpuLoad}
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_MEMORY_TITLE')}
                metric={`${systemData.percentUsedMemory}%`}
                subtitle={t('DASHBOARD_GB_OF', { used: memoryUsed, total: systemData.memoryTotal })}
                icon={MemoryStick}
                progress={systemData.percentUsedMemory}
              />
            </>
          )}
        </div>

        {/* Apps section */}
        <div className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-4 shadow-sm">
          <QueuedInstallsIndicator queue={installQueue} isLoading={installQueueLoading} />
          <CustomDomainRestartBanner apps={diagnosticsApps} namesByUrn={appNamesByUrn} />
          {appsError ? (
            <div className="flex flex-col items-start gap-2 py-6">
              <p className="text-sm text-muted-foreground">{t('DASHBOARD_APPS_FAILED')}</p>
              <Button type="button" variant="outline" onClick={() => refetchApps()}>
                {t('COMMON_RETRY')}
              </Button>
            </div>
          ) : (
            <HorizontalAppList
              apps={appsData?.installed ?? []}
              isLoading={appsPending && !appsData}
              customDomainsAwaitingRestart={customDomainsAwaitingRestart}
            />
          )}
        </div>

        {installedApps.length > 0 && (
          <div className="flex justify-end">
            <BatchActionsMenu runningCount={runningCount} stoppedCount={stoppedCount} updatesAvailable={updatesAvailable} />
          </div>
        )}
      </div>
    </div>
  );
};
