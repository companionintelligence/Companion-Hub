import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';

interface IProps {
  icon: LucideIcon;
  progress: number;
  title: string;
  subtitle: string;
  metric: string;
  isLoading?: boolean;
}

export const SystemStat: React.FC<IProps> = ({ icon: IconComponent, progress, title, subtitle, metric, isLoading }) => {
  // Generate testId from title (e.g., "Disk space" -> "stat-disk-space")
  const testId = `stat-${title.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <Card>
      <CardContent>
        <div className="flex justify-between items-start">
          <Skeleton loading={isLoading}>
            <div className={clsx('text-2xl mb-3 font-bold')}>{title}</div>
          </Skeleton>
          <IconComponent />
        </div>
        <div className={clsx('text-2xl')}>
          <Skeleton loading={isLoading}>{metric}</Skeleton>
        </div>
        <div className={clsx('mb-3 text-muted-foreground')}>
          <Skeleton loading={isLoading}>{subtitle}</Skeleton>
        </div>
        <Skeleton loading={isLoading}>
          <div className="progress progress-sm" data-testid={`${testId}-progress`}>
            <div className="progress-bar bg-primary" style={{ width: `${progress.toFixed(0)}%` }}>
              <span className="visually-hidden">{`${progress.toFixed(0)}%`}</span>
            </div>
          </div>
        </Skeleton>
      </CardContent>
    </Card>
  );
};
