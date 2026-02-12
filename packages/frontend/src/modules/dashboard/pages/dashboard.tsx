import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { Cpu, Database, LayoutGrid, MemoryStick } from 'lucide-react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/Button';

export default () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: systemData } = useSuspenseQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
  });

  const { data: appsData } = useSuspenseQuery({
    ...getInstalledAppsOptions(),
  });

  const isLoading = !systemData;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center gap-6 py-6">
        {/* Usage Section — 3 widgets centered */}
        <div className="grid grid-cols-3 gap-4 w-full max-w-2xl px-4">
          <CompactSystemStat
            isLoading={isLoading}
            title={t('DASHBOARD_DISK_SPACE_TITLE')}
            metric={`${systemData.diskUsed} GB`}
            icon={Database}
            progress={systemData.percentUsed}
            color="blue"
          />
          <CompactSystemStat
            isLoading={isLoading}
            title={t('DASHBOARD_CPU_TITLE')}
            metric={`${systemData.cpuLoad.toFixed(2)}%`}
            icon={Cpu}
            progress={systemData.cpuLoad}
            color="red"
          />
          <CompactSystemStat
            isLoading={isLoading}
            title={t('DASHBOARD_MEMORY_TITLE')}
            metric={`${systemData.percentUsedMemory}%`}
            icon={MemoryStick}
            progress={systemData.percentUsedMemory}
            color="green"
          />
        </div>

        {/* Apps Section */}
        <div className="w-full">
          <HorizontalAppList apps={appsData.installed} />
        </div>

        {/* App Store Button */}
        <Button size="lg" className="flex items-center gap-2" onClick={() => navigate('/app-store')}>
          <LayoutGrid size={20} />
          {t('HEADER_APP_STORE')}
        </Button>
      </div>
    </div>
  );
};
