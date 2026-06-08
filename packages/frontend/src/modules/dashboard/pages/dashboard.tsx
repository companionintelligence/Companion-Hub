import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
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

  useEffect(() => {
    const state = location.state as DashboardLocationState | null;
    if (!state?.showBackgroundInstallToast) return;

    toast(t('DASHBOARD_SETUP_RUNNING_BACKGROUND'), {
      duration: 7000,
    });

    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: null });
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  const { data: systemData } = useQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
    staleTime: 30_000,
  });

  const { data: appsData } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const installingCount = appsData?.installed.filter((entry) => entry.app.status === 'installing').length ?? 0;
  const { data: installQueue, isLoading: installQueueLoading } = useInstallQueue(installingCount > 0);

  const isLoading = !systemData;
  const memoryUsed = systemData?.memoryUsed ?? (systemData ? Math.round((systemData.memoryTotal * systemData.percentUsedMemory) / 100) : 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-4 py-4 px-1">
        {/* System stats — full width, 3 equal columns */}
        <div className="grid grid-cols-3 gap-3">
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
        <div className="rounded-2xl border border-border bg-linear-to-b from-card to-card/60 p-4 shadow-sm">
          <QueuedInstallsIndicator queue={installQueue} isLoading={installQueueLoading && installingCount > 0} />
          {appsData ? <HorizontalAppList apps={appsData.installed} /> : <LoadingSpinner />}
        </div>
      </div>
    </div>
  );
};
