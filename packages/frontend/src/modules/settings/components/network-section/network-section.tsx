import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/*
 * Shared chrome for the Network tab.
 *
 * Deliberately dense, in the idiom of the fleet-QA dashboard: a value is large and a
 * label is small, uppercase and quiet, so a glance reads the numbers and only a second
 * look reads what they are. The explanations that used to sit under every control now
 * live on the label as a tooltip — the page carried 1,614 words of prose across 166
 * translation keys, which buried the four facts an operator actually comes here for.
 * Nothing was deleted: `HintText` keeps each string one hover away.
 */

/** 8px status dot. The one shape every state in this tab is drawn with. */
export const StatusDot = ({ tone = 'idle', className }: { tone?: 'ok' | 'warn' | 'bad' | 'idle'; className?: string }) => (
  <span
    className={cn(
      'inline-block h-2 w-2 shrink-0 rounded-full',
      tone === 'ok' && 'bg-success',
      tone === 'warn' && 'bg-warning',
      tone === 'bad' && 'bg-destructive',
      tone === 'idle' && 'bg-muted-foreground/50',
      className,
    )}
  />
);

export const StatusBadge = ({ connected, label }: { connected: boolean; label: string }) => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
      connected ? 'border-success/40 bg-success/10 text-success' : 'border-border/70 bg-muted/30 text-muted-foreground',
    )}
  >
    <StatusDot tone={connected ? 'ok' : 'idle'} className="h-1.5 w-1.5" />
    {label}
  </span>
);

/**
 * A number the size of a headline over a label the size of a footnote — the fleet-QA
 * `.chip`. `tone` colours the VALUE, never the label, so a row of chips scans as one
 * line of numbers with the exceptional one picked out.
 */
export const StatChip = ({
  value,
  label,
  tone = 'plain',
  hint,
  hintId,
}: {
  value: ReactNode;
  label: string;
  tone?: 'plain' | 'ok' | 'warn' | 'bad' | 'muted';
  hint?: ReactNode;
  hintId?: string;
}) => {
  const caption =
    hint && hintId ? (
      <HintText id={hintId} hint={hint} className="cursor-help underline decoration-dotted underline-offset-2">
        {label}
      </HintText>
    ) : (
      label
    );

  return (
    <div className="flex min-w-[74px] flex-col gap-0.5 rounded-md border border-border bg-muted/20 px-2.5 py-1.5">
      <span
        className={cn(
          'text-[17px] font-bold leading-none tabular-nums',
          tone === 'ok' && 'text-success',
          tone === 'warn' && 'text-warning',
          tone === 'bad' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{caption}</span>
    </div>
  );
};

export const StatChipRow = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-1.5">{children}</div>;

/**
 * Compact header. The title is `text-base`, not `text-xl`: this tab stacks three cards,
 * and headline-sized titles pushed the actual state below the fold on a laptop.
 * `description` is intentionally absent — see the note at the top of this file.
 */
export const SectionHeader = ({ icon: Icon, title, badge, actions }: { icon: LucideIcon; title: string; badge?: ReactNode; actions?: ReactNode }) => (
  <CardHeader className="pb-3">
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <CardTitle className="text-base font-semibold">{title}</CardTitle>
      {badge}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  </CardHeader>
);

/**
 * Label-over-value cells. `auto-fit` rather than a fixed column count, so a long FQDN
 * gets a wide cell instead of being truncated into a fixed third of the row — the old
 * `grid-cols-3` is what cut "3 connected · 0 pending · 0 unreachabl…" mid-word.
 */
export const DetailGrid = ({ children }: { children: ReactNode }) => (
  <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-2">{children}</dl>
);

export const Detail = ({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) => (
  <div className="min-w-0 space-y-0.5">
    <dt className="text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{label}</dt>
    <dd className={cn('break-words text-xs leading-snug', mono && 'font-mono')}>{value}</dd>
  </div>
);

/**
 * The fleet-QA `table.kpi`: 12px body, sticky uppercase micro-headers, tabular numerals,
 * hairline row rules. Wrapped in its own horizontal scroller so a wide row scrolls itself
 * instead of widening the page.
 */
export const KpiTable = ({ head, children }: { head: ReactNode; children: ReactNode }) => (
  <div className="overflow-x-auto rounded-md border border-border">
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="bg-muted/40">{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

export const Th = ({ children, align = 'left' }: { children: ReactNode; align?: 'left' | 'right' }) => (
  <th
    className={cn(
      'whitespace-nowrap border-b border-border px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-muted-foreground',
      align === 'right' ? 'text-right' : 'text-left',
    )}
  >
    {children}
  </th>
);

export const Td = ({ children, align = 'left', className }: { children: ReactNode; align?: 'left' | 'right'; className?: string }) => (
  <td
    className={cn(
      'border-b border-border px-2.5 py-1.5 align-middle tabular-nums last:border-b-0',
      align === 'right' ? 'text-right' : 'text-left',
      className,
    )}
  >
    {children}
  </td>
);

export const Tr = ({ children }: { children: ReactNode }) => <tr className="transition-colors hover:bg-muted/30">{children}</tr>;

/** Empty state for a KpiTable — one short line, centred, never a paragraph. */
export const TableEmpty = ({ colSpan, children }: { colSpan: number; children: ReactNode }) => (
  <tr>
    <td colSpan={colSpan} className="px-2.5 py-4 text-center text-xs italic text-muted-foreground">
      {children}
    </td>
  </tr>
);

/**
 * A control and its state on one line, with the explanation on the label as a tooltip.
 * Every toggle on this tab used to carry two or three lines of prose underneath, which is
 * most of why the page scrolled.
 */
export const ControlRow = ({ label, hint, hintId, control }: { label: string; hint?: ReactNode; hintId?: string; control: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
    <span className="min-w-0 text-xs">
      {hint && hintId ? (
        <HintText id={hintId} hint={hint} className="cursor-help underline decoration-dotted underline-offset-2">
          {label}
        </HintText>
      ) : (
        label
      )}
    </span>
    <span className="shrink-0">{control}</span>
  </div>
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
