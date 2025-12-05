import { systemLoadOptions } from '@/api-client/@tanstack/react-query.gen';
import { IconCircuitResistor, IconCpu, IconDatabase } from '@tabler/icons-react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { SystemStat } from '../components/system-stat';

export default () => {
  const { t } = useTranslation();
  const { data } = useSuspenseQuery({
    ...systemLoadOptions(),
    refetchInterval: 3000,
  });
  const isLoading = !data;
  
  // Freeze CPU load at the initial value when it first loads
  const frozenCpuLoad = useRef<number | null>(null);
  if (frozenCpuLoad.current === null && data) {
    frozenCpuLoad.current = data.cpuLoad;
  }
  const cpuLoad = frozenCpuLoad.current ?? data?.cpuLoad ?? 0;

  return (
    <div className="row row-deck row-cards px-1">
      <SystemStat
        isLoading={isLoading}
        title={t('DASHBOARD_DISK_SPACE_TITLE')}
        metric={`${data.diskUsed} GB`}
        subtitle={t('DASHBOARD_DISK_SPACE_SUBTITLE', { total: data?.diskSize })}
        icon={IconDatabase}
        progress={data.percentUsed}
      />
      <SystemStat
        isLoading={isLoading}
        title={t('DASHBOARD_CPU_TITLE')}
        metric={`${cpuLoad.toFixed(2)}%`}
        subtitle={t('DASHBOARD_CPU_SUBTITLE')}
        icon={IconCpu}
        progress={cpuLoad}
      />
      <SystemStat
        isLoading={isLoading}
        title={t('DASHBOARD_MEMORY_TITLE')}
        metric={`${data.percentUsedMemory}%`}
        subtitle={`${data.memoryTotal} GB`}
        icon={IconCircuitResistor}
        progress={data.percentUsedMemory}
      />
    </div>
  );
};
