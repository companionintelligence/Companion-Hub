import type { IconProps } from '@tabler/icons-react';
import clsx from 'clsx';
import type { FunctionComponent } from 'react';

interface CompactSystemStatProps {
  title: string;
  metric: string;
  icon: FunctionComponent<IconProps>;
  progress: number;
  isLoading?: boolean;
  color?: string;
}

export const CompactSystemStat = ({ title, metric, icon: Icon, progress, isLoading, color = 'primary' }: CompactSystemStatProps) => {
  return (
    <div className="card card-sm">
      <div className="card-body">
        <div className="d-flex align-items-center mb-2">
          <div className="subheader">{title}</div>
          <div className="ms-auto">
            <Icon size={20} className="text-muted" />
          </div>
        </div>
        <div className="d-flex align-items-baseline mb-2">
          <div className="h1 mb-0 me-2">{isLoading ? '...' : metric}</div>
        </div>
        <div className="progress progress-sm">
          <div
            className={clsx('progress-bar', `bg-${color}`)}
            style={{ width: `${progress}%` }}
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${progress}% Complete`}
          />
        </div>
      </div>
    </div>
  );
};
