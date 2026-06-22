import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

interface CompactSystemStatProps {
  title: string;
  metric: string;
  subtitle?: string;
  secondarySubtitle?: string;
  hint?: string;
  icon: LucideIcon;
  progress: number;
  isLoading?: boolean;
}

export const CompactSystemStat = ({ title, metric, subtitle, secondarySubtitle, hint, icon: Icon, progress, isLoading }: CompactSystemStatProps) => {
  const barColor = progress > 90 ? 'bg-red-500' : progress > 70 ? 'bg-yellow-500' : 'bg-primary';
  return (
    <div className="rounded-2xl border border-border bg-linear-to-b from-card to-card/60 p-3 sm:p-4 shadow-sm dark:from-card/80 dark:to-card/40">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-primary">
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
          <div className={cn('text-base sm:text-xl font-bold', subtitle ? 'mb-0.5' : 'mb-2')}>{isLoading ? '…' : metric}</div>
          {subtitle && <div className="text-xs text-muted-foreground mb-2">{isLoading ? '…' : subtitle}</div>}
          {secondarySubtitle && <div className="text-[11px] text-muted-foreground/80 mb-2">{isLoading ? '…' : secondarySubtitle}</div>}
          {hint && <div className="text-[11px] text-muted-foreground/80 mb-2 leading-snug">{isLoading ? '…' : hint}</div>}
          <div className="h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', barColor)}
              style={{ width: `${Math.min(progress, 100)}%` }}
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${progress}%`}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
