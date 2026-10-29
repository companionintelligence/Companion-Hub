import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Th as DenseTh } from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { SettingsHint } from '../settings-hint';

/*
 * Shared chrome for the Network and MCP tabs.
 *
 * These cards follow the rest of Settings (Settings, Security, System): an icon and a
 * `text-xl` title, a one-line description under it, sentence-case labels and a "?" beside
 * any label whose explanation is longer than the label. The tables and meters still come
 * from the dense primitives the Resources board uses; only their headers are restyled here.
 */

// biome-ignore lint/performance/noBarrelFile: re-exports the dense primitives this tab's own components (below) are built from, so a consumer of this file gets both from one import — not a pure barrel with no other content.
export {
  DASH,
  humanBytes,
  humanCount,
  KpiTable,
  MeterBar,
  Panel,
  relativeAge,
  Sparkline,
  StackedBar,
  StatChip,
  StatChipRow,
  StatusBadge,
  StatusDot,
  TableEmpty,
  Td,
  Tr,
} from '@/components/ui/dense/dense';

/**
 * The "?" beside a label: the Settings tab's own marker, a button so a keyboard can reach the
 * explanation. `id` names it twice, once for the tooltip (`<id>-hint`) and once as the
 * `field-hint-<id>` class the tests and the older HintText anchors use.
 */
export const Hint = ({ id, hint }: { id: string; hint: string }) => <SettingsHint className={`field-hint-${id} ${id}-hint`} hint={hint} />;

/** The Settings card header: icon, title, an optional badge and actions on the right, and a description under them. */
export const SectionHeader = ({
  icon: Icon,
  title,
  description,
  badge,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) => (
  <CardHeader>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      <CardTitle className="text-xl">{title}</CardTitle>
      {badge ? <span className="ml-1">{badge}</span> : null}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
    {description ? <CardDescription>{description}</CardDescription> : null}
  </CardHeader>
);

/**
 * A titled part of a card, ruled off from the part above it. `help` is the "?" beside the
 * title, the same marker the Settings tab uses, so a long explanation stays one hover away
 * without hiding the title behind a dotted underline.
 */
export const SubSection = ({
  title,
  help,
  helpId,
  description,
  actions,
  children,
  testId,
}: {
  title: string;
  help?: string;
  helpId?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) => (
  <section className="space-y-3 border-t border-border pt-5" data-testid={testId}>
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <h4 className="flex items-center text-sm font-semibold">
          {title}
          {help && helpId ? <Hint id={helpId} hint={help} /> : null}
        </h4>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
    {children}
  </section>
);

/**
 * Label-over-value cells. `auto-fit` rather than a fixed column count, so a long FQDN
 * gets a wide cell instead of being truncated into a fixed third of the row.
 */
export const DetailGrid = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-6 gap-y-3">{children}</dl>
);

/** `mono` is for what someone copies or compares (an address, an ID), not for every value. */
export const Detail = ({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="min-w-0 space-y-0.5">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className={cn('break-words text-sm', mono && 'font-mono text-[13px]')}>{value}</dd>
  </div>
);

/** A number over its label, for the few counts a section leads with. */
export const Stat = ({
  value,
  label,
  tone = 'plain',
  hint,
  hintId,
}: {
  value: ReactNode;
  label: string;
  tone?: 'plain' | 'ok' | 'bad' | 'muted';
  hint?: string;
  hintId?: string;
}) => (
  <div className="flex min-w-[104px] flex-1 flex-col gap-1 rounded-md border border-border/70 bg-muted/20 px-3 py-2 sm:flex-none">
    <span
      className={cn(
        'text-xl font-semibold leading-none tabular-nums',
        tone === 'ok' && 'text-success',
        tone === 'bad' && 'text-destructive',
        tone === 'muted' && 'text-muted-foreground',
      )}
    >
      {value}
    </span>
    <span className="flex items-center text-xs text-muted-foreground">
      {label}
      {hint && hintId ? <Hint id={hintId} hint={hint} /> : null}
    </span>
  </div>
);

export const StatRow = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-2">{children}</div>;

/** The dense table header, in the sentence case the rest of Settings uses for its tables. */
export const Th = ({ className, ...props }: ComponentProps<typeof DenseTh>) => (
  <DenseTh className={cn('text-xs font-medium normal-case tracking-normal', className)} {...props} />
);

/** A short state word on a row (paused, pinned): quieter than a status badge, in sentence case. */
export const RowMark = ({
  children,
  tone = 'muted',
  title,
  testId,
}: {
  children: ReactNode;
  tone?: 'muted' | 'warn';
  title?: string;
  testId?: string;
}) => (
  <span
    data-testid={testId}
    title={title}
    className={cn(
      'shrink-0 rounded-full border px-1.5 text-[11px] leading-4',
      tone === 'warn' ? 'border-warning/40 text-warning' : 'border-border text-muted-foreground',
    )}
  >
    {children}
  </span>
);

export const LoadingCard = ({ icon, title }: { icon: LucideIcon; title: string }) => (
  <Card>
    <SectionHeader icon={icon} title={title} />
    <CardContent className="space-y-2">
      <Skeleton className="h-4 w-2/3 rounded-md" />
      <Skeleton className="h-14 w-full rounded-md" />
    </CardContent>
  </Card>
);
