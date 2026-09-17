import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
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

  const isLoading = !systemData;
  const memoryUsed = systemData?.memoryUsed ?? (systemData ? Math.round((systemData.memoryTotal * systemData.percentUsedMemory) / 100) : 0);

  return (
    <div className="relative h-full overflow-y-auto" data-page-scroller="home">
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
          <HorizontalAppList apps={appsData?.installed ?? []} isLoading={!appsData} />
        </div>
      </div>
    </div>
  );
};
