import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shared chrome for the Network tab's cards, so the Hub Pool section can live in its own file
 *  without either copying these or importing back into `network-settings.tsx`. */

export const StatusBadge = ({ connected, label }: { connected: boolean; label: string }) => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
      connected ? 'border-success/40 bg-success/10 text-success' : 'border-border/70 bg-muted/30 text-muted-foreground',
    )}
  >
    <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-success' : 'bg-muted-foreground/60')} />
    {label}
  </span>
);

/** Card header shared by every section: icon + title on the left, connection state on the right —
 *  the same shape the App Stores / Security / System tabs use for their card headers. */
export const SectionHeader = ({
  icon: Icon,
  title,
  description,
  badge,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  badge?: ReactNode;
}) => (
  <CardHeader>
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <CardTitle className="text-xl">{title}</CardTitle>
      </div>
      {badge}
    </div>
    {description ? <CardDescription>{description}</CardDescription> : null}
  </CardHeader>
);

/** Connection facts (tailnet IP, tunnel id, …) as compact label-over-value cells — the same shape
 *  the MCP tab uses for its status grid, so the value stays next to its label instead of being
 *  pushed to the far edge of the card. */
export const DetailGrid = ({ children }: { children: ReactNode }) => <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{children}</dl>;

export const Detail = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 space-y-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="truncate font-mono text-xs" title={value}>
      {value}
    </dd>
  </div>
);

export const LoadingCard = ({ icon, title }: { icon: LucideIcon; title: string }) => (
  <Card>
    <SectionHeader icon={icon} title={title} />
    <CardContent className="space-y-3">
      <Skeleton className="h-4 w-2/3 rounded-md" />
      <Skeleton className="h-16 w-full rounded-md" />
    </CardContent>
  </Card>
);
