import { Card, CardContent } from '@/components/ui/Card';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { FunctionComponent } from 'react';

interface CompactSystemStatProps {
  title: string;
  metric: string;
  icon: LucideIcon;
  progress: number;
  isLoading?: boolean;
  color?: string;
}

export const CompactSystemStat = ({ title, metric, icon: Icon, progress, isLoading, color = 'primary' }: CompactSystemStatProps) => {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center mb-2">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{title}</div>
          <div className="ml-auto">
            <Icon size={20} className="text-muted-foreground" />
          </div>
        </div>
        <div className="flex items-baseline mb-2">
          <div className="text-2xl font-bold mb-0 me-2">{isLoading ? '...' : metric}</div>
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
      </CardContent>
    </Card>
  );
};
