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
  Th,
  Tr,
} from '@/components/ui/dense/dense';

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
