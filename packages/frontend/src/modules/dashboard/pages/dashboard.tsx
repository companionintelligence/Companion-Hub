import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { fetchPublicWebDiagnostics } from '@/lib/cloudflare-api';
import { CustomDomainRestartBanner } from '@/modules/app/components/custom-domain-restart-banner';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { QueuedInstallsIndicator } from '../components/queued-installs-indicator';
import { useInstallQueue } from '@/modules/app/helpers/use-install-queue';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';

type DashboardLocationState = {
  showBackgroundInstallToast?: boolean;
};

export default () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const state = location.state as DashboardLocationState | null;
    if (!state?.showBackgroundInstallToast) return;

    toast(t('DASHBOARD_SETUP_RUNNING_BACKGROUND'), {
      duration: 7000,
    });

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

  const { data: systemData } = useQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
    staleTime: 30_000,
  });

  const { data: appsData } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const { data: installQueue, isLoading: installQueueLoading } = useInstallQueue();

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
    queryKey: ['public-web-diagnostics'],
    queryFn: fetchPublicWebDiagnostics,
    staleTime: 30_000,
  });

  const diagnosticsApps = publicWebDiagnostics?.apps ?? [];

  const customDomainsAwaitingRestart = useMemo(() => {
    const byUrn: Record<string, string> = {};
    for (const entry of diagnosticsApps) {
      if (entry.awaitingCustomDomainRestart && entry.customDomain) {
        byUrn[entry.appUrn] = entry.customDomain;
      }
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

  const isLoading = !systemData;
  const memoryUsed = systemData?.memoryUsed ?? (systemData ? Math.round((systemData.memoryTotal * systemData.percentUsedMemory) / 100) : 0);

  return (
    <div className="page-scroller-edge-0 relative h-full overflow-y-auto" data-page-scroller="home">
      <div className="flex flex-col gap-4 pt-2 pb-4 px-1">
        {/* System stats — stacked on mobile, three columns from sm */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {isLoading ? (
            <div className="col-span-3 flex justify-center py-4">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_DISK_SPACE_TITLE')}
                metric={`${systemData.percentUsed}%`}
                subtitle={`${systemData.diskUsed} / ${systemData.diskSize} GB`}
                icon={Database}
                progress={systemData.percentUsed}
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_CPU_TITLE')}
                metric={`${systemData.cpuLoad.toFixed(2)}%`}
                subtitle={systemData.cpuCores ? `${systemData.cpuCores} cores` : undefined}
                icon={Cpu}
                progress={systemData.cpuLoad}
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_MEMORY_TITLE')}
                metric={`${systemData.percentUsedMemory}%`}
                subtitle={`${memoryUsed} / ${systemData.memoryTotal} GB`}
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
          <HorizontalAppList apps={appsData?.installed ?? []} isLoading={!appsData} customDomainsAwaitingRestart={customDomainsAwaitingRestart} />
        </div>
      </div>
    </div>
  );
};
