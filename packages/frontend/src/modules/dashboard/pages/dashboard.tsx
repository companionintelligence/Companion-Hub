import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Cpu, Database, LayoutGrid, MemoryStick, MonitorPlay, Layers } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

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

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center gap-6 py-6">
        {/* Usage Section — 3 widgets centered */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4 w-full max-w-2xl px-2 sm:px-4">
          {isLoading ? (
            <div className="col-span-3">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_DISK_SPACE_TITLE')}
                metric={`${systemData.diskUsed} GB`}
                icon={Database}
                progress={systemData.percentUsed}
                color="blue"
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_CPU_TITLE')}
                metric={`${systemData.cpuLoad.toFixed(2)}%`}
                icon={Cpu}
                progress={systemData.cpuLoad}
                color="red"
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_MEMORY_TITLE')}
                metric={`${systemData.percentUsedMemory}%`}
                icon={MemoryStick}
                progress={systemData.percentUsedMemory}
                color="green"
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_GPU_TITLE')}
                metric={`${systemData.gpuLoad.toFixed(2)}%`}
                icon={MonitorPlay}
                progress={systemData.gpuLoad}
                color="primary"
              />
              <CompactSystemStat
                isLoading={false}
                title={t('DASHBOARD_VRAM_TITLE')}
                metric={`${systemData.vramUsedPercent}%`}
                icon={Layers}
                progress={systemData.vramUsedPercent}
                color="blue"
              />
            </>
          )}
        </div>

        {/* Apps Section */}
        <div className="w-full max-w-2xl px-2 sm:px-4">{appsData ? <HorizontalAppList apps={appsData.installed} /> : <LoadingSpinner />}</div>

        {/* App Store Button */}
        <Button size="lg" className="flex items-center gap-2" onClick={() => navigate('/app-store')}>
          <LayoutGrid size={20} />
          {t('HEADER_APP_STORE')}
        </Button>
      </div>
    </div>
  );
};
