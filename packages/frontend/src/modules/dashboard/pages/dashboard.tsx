import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Cpu, Database, MemoryStick } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';

export default () => {
  const { t } = useTranslation();

  const { data: systemData } = useQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
    staleTime: 30_000,
  });

  const { data: appsData } = useQuery({
    ...getInstalledAppsOptions(),
    staleTime: 30_000,
  });

  const isLoading = !systemData;
  const memoryUsed = systemData?.memoryUsed ?? (systemData ? Math.round((systemData.memoryTotal * systemData.percentUsedMemory) / 100) : 0);
  const vmWedge = systemData?.hasVmWedge ?? false;
  const containerMemorySubtitle =
    vmWedge && systemData?.containerMemoryTotal
      ? `Container limit: ${systemData.containerMemoryUsed ?? '—'} / ${systemData.containerMemoryTotal} GB`
      : undefined;
  const containerDiskSubtitle =
    vmWedge && systemData?.containerDiskTotal
      ? `Container limit: ${systemData.containerDiskUsed ?? '—'} / ${systemData.containerDiskTotal} GB`
      : undefined;

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
                secondarySubtitle={containerDiskSubtitle}
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
                secondarySubtitle={containerMemorySubtitle}
                icon={MemoryStick}
                progress={systemData.percentUsedMemory}
              />
            </>
          )}
        </div>

        {/* Apps section */}
        <div className="rounded-2xl border border-border bg-gradient-to-b from-card to-card/60 p-4 shadow-sm">
          {appsData ? <HorizontalAppList apps={appsData.installed} /> : <LoadingSpinner />}
        </div>
      </div>
    </div>
  );
};
