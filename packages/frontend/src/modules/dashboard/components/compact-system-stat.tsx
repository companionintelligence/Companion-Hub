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
    <div className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-3 shadow-sm dark:from-card/80 dark:to-card/40 sm:p-4">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="shrink-0 text-primary" aria-hidden>
          <Icon className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground sm:text-[11px] sm:font-medium sm:uppercase sm:tracking-wide sm:text-muted-foreground">
          {title}
        </span>
        <span className="shrink-0 text-base font-semibold tabular-nums leading-none sm:text-lg">{isLoading ? '…' : metric}</span>
      </div>

      {subtitle ? <p className="mb-2 text-xs leading-snug text-muted-foreground">{isLoading ? '…' : subtitle}</p> : null}
      {secondarySubtitle ? <p className="mb-2 text-[11px] leading-snug text-muted-foreground/80">{isLoading ? '…' : secondarySubtitle}</p> : null}
      {hint ? <p className="mb-2 text-[11px] leading-snug text-muted-foreground/80">{isLoading ? '…' : hint}</p> : null}

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${Math.min(progress, 100)}%` }}
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${title} ${progress}%`}
        />
      </div>
    </div>
  );
};
