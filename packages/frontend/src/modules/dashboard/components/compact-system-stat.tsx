import { GlassContainer } from '@/components/ui/glass-container';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

interface CompactSystemStatProps {
  title: string;
  metric: string;
  icon: LucideIcon;
  progress: number;
  isLoading?: boolean;
  color?: 'blue' | 'red' | 'green' | 'primary';
}

const colorMap = {
  blue: 'bg-blue-500',
  red: 'bg-red-500',
  green: 'bg-green-500',
  primary: 'bg-primary',
} as const;

export const CompactSystemStat = ({ title, metric, icon: Icon, progress, isLoading, color = 'primary' }: CompactSystemStatProps) => {
  return (
    <GlassContainer intensity="high" className="p-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        <Icon size={18} className="text-muted-foreground" />
      </div>
      <div className="text-2xl font-bold mb-3">{isLoading ? '...' : metric}</div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-500', colorMap[color] ?? 'bg-primary')}
          style={{ width: `${Math.min(progress, 100)}%` }}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${progress}% Complete`}
        />
      </div>
    </GlassContainer>
  );
};
