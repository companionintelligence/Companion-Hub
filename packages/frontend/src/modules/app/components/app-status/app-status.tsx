import type { AppStatus as AppStatusType } from '@/types/app.types';
import { cn } from '@/lib/utils';
import type React from 'react';
import { useTranslation } from 'react-i18next';

export const AppStatus: React.FC<{ lite?: boolean; status: AppStatusType }> = ({ status, lite }) => {
  const { t } = useTranslation();

  const formattedStatus = t(`APP_STATUS_${status.toUpperCase()}`);

  if (status === 'missing') return null;

  const dotClasses = cn(
    'inline-block h-2 w-2 rounded-full',
    status === 'running' && 'bg-green-500 animate-pulse',
    status === 'stopped' && 'bg-red-500',
    status !== 'running' && status !== 'stopped' && 'bg-gray-400',
  );

  return (
    <div className="flex items-center" title={lite ? formattedStatus : undefined}>
      <span className={dotClasses} />
      {!lite && <span className="ml-2 text-sm text-muted-foreground">{formattedStatus}</span>}
    </div>
  );
};
