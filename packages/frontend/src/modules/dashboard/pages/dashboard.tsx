import { systemLoadOptions, getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import { IconCircuitResistor, IconCpu, IconDatabase, IconBrandAppstore } from '@tabler/icons-react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { CompactSystemStat } from '../components/compact-system-stat';
import { HorizontalAppList } from '../components/horizontal-app-list';
import { useNavigate } from 'react-router';

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

  // Freeze CPU load at the initial value when it first loads
  const frozenCpuLoad = useRef<number | null>(null);
  if (frozenCpuLoad.current === null && systemData) {
    frozenCpuLoad.current = systemData.cpuLoad;
  }
  const _cpuLoad = frozenCpuLoad.current ?? systemData?.cpuLoad ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="d-flex flex-column gap-4">
        {/* Usage Section */}
        <div className="row row-deck row-cards align-self-center" style={{ width: '50%' }}>
          <div className="col-4">
            <CompactSystemStat
              isLoading={isLoading}
              title={t('DASHBOARD_DISK_SPACE_TITLE')}
              metric={`${systemData.diskUsed} GB`}
              icon={IconDatabase}
              progress={systemData.percentUsed}
              color="blue"
            />
          </div>
          <div className="col-4">
            <CompactSystemStat
              isLoading={isLoading}
              title={t('DASHBOARD_CPU_TITLE')}
              metric={`${systemData.cpuLoad.toFixed(2)}%`}
              icon={IconCpu}
              progress={systemData.cpuLoad}
              color="red"
            />
          </div>
          <div className="col-4">
            <CompactSystemStat
              isLoading={isLoading}
              title={t('DASHBOARD_MEMORY_TITLE')}
              metric={`${systemData.percentUsedMemory}%`}
              icon={IconCircuitResistor}
              progress={systemData.percentUsedMemory}
              color="green"
            />
          </div>
        </div>

        {/* Apps Section */}
        <div>
          <HorizontalAppList apps={appsData.installed} />
        </div>

        {/* App Store Button */}
        <div className="d-flex justify-content-center mt-2">
          <button type="button" className="btn btn-primary btn-lg d-flex align-items-center gap-2" onClick={() => navigate('/app-store')}>
            <IconBrandAppstore size={24} />
            {t('HEADER_APP_STORE')}
          </button>
        </div>
      </div>
    </div>
  );
};
