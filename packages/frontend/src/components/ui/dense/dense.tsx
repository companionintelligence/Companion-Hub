import { HintText } from '@/components/ui/field-hint/field-hint';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/*
 * Dense read-out primitives for the Network and AI settings tabs. The Resources page's Apps table
 * borrows the sparkline.
 *
 * The idiom is the fleet-QA dashboard's: a value is large and a label is small,
 *  and quiet, so a glance reads the numbers and only a second look reads
 * what they are. Tables are 13px with micro-headers and tabular numerals.
 * Nothing here introduces a charting dependency — this app has none, and its existing
 * CPU history chart is hand-drawn SVG, so these are too.
 *
 * An unmeasured value must never render as 0. "Nothing happened" and "we could not
 * read the counter" send an operator to opposite places; helpers here take `null` for
 * the second case and render a dash.
 */

// ── Status ───────────────────────────────────────────────────────────────────

export type Tone = 'plain' | 'ok' | 'warn' | 'bad' | 'muted';

/** Exported so a panel can tone its own read-outs without re-deriving the palette. */
export const TONE_TEXT: Record<Tone, string> = {
  plain: '',
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

const TONE_BG: Record<Tone, string> = {
  plain: 'bg-foreground/60',
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  muted: 'bg-muted-foreground/50',
};

export const StatusDot = ({ tone = 'muted', className }: { tone?: Tone; className?: string }) => (
  <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE_BG[tone], className)} />
);

export const StatusBadge = ({ connected, label }: { connected: boolean; label: string }) => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
      connected ? 'border-success/40 bg-success/10 text-success' : 'border-border/70 bg-muted/30 text-muted-foreground',
    )}
  >
    <StatusDot tone={connected ? 'ok' : 'muted'} className="h-1.5 w-1.5" />
    {label}
  </span>
);

// ── Numbers ──────────────────────────────────────────────────────────────────

/** A number the size of a headline over a label the size of a footnote. */
export const StatChip = ({
  value,
  label,
  sub,
  tone = 'plain',
  hint,
  hintId,
}: {
  value: ReactNode;
  label: string;
  sub?: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  hintId?: string;
}) => (
  <div className="flex min-w-[92px] flex-col gap-1 rounded-md border border-border bg-muted/20 px-3 py-1.5">
    <span className={cn('text-[22px] font-medium leading-none tabular-nums', TONE_TEXT[tone])}>{value}</span>
    <span className="text-[11px]  leading-tight  text-muted-foreground">
      {hint && hintId ? (
        <HintText id={hintId} hint={hint} className="cursor-help underline decoration-dotted underline-offset-2">
          {label}
        </HintText>
      ) : (
        label
      )}
    </span>
    {sub ? <span className="text-[11px] leading-tight text-muted-foreground/80">{sub}</span> : null}
  </div>
);

export const StatChipRow = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap gap-2">{children}</div>;

// ── Tables ───────────────────────────────────────────────────────────────────

export const KpiTable = ({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) => (
  <div className={cn('min-w-0 overflow-x-auto rounded-md border border-border', className)}>
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="bg-muted/40">{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/**
 * `className` exists for one job: dropping a column below a breakpoint.
 *
 * A `hidden sm:table-cell` on the {@link Td} alone leaves its header behind and the table
 * silently shifts by one cell, so the header and its cells must be able to carry the SAME
 * class. Every column drop on the dashboard applies the identical utility to both.
 */
export const Th = ({
  children,
  align = 'left',
  className,
  id,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  id?: string;
}) => (
  <th
    id={id}
    scope="col"
    className={cn(
      'whitespace-nowrap border-b border-border px-3 py-1.5 text-[11px] font-medium   text-muted-foreground',
      align === 'right' ? 'text-right' : 'text-left',
      className,
    )}
  >
    {children}
  </th>
);

export const Td = ({
  children,
  align = 'left',
  className,
  title,
  headers,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
  headers?: string;
}) => (
  <td
    headers={headers}
    className={cn('border-b border-border/70 px-3 py-1.5 align-middle tabular-nums', align === 'right' ? 'text-right' : 'text-left', className)}
    title={title}
  >
    {children}
  </td>
);

/**
 * `testId` and `data` exist so a row stays assertable when its cells are glyphs rather
 * than text. A presence matrix renders dots; a test that read `textContent` would be
 * asserting on nothing, or on whatever the dot's aria label happened to be.
 */
export const Tr = ({
  children,
  testId,
  data,
  className,
  onClick,
}: {
  children: ReactNode;
  testId?: string;
  data?: Record<string, string>;
  className?: string;
  onClick?: () => void;
}) => (
  <tr
    className={cn('transition-colors last:[&>td]:border-b-0 hover:bg-muted/30', className)}
    data-testid={testId}
    onClick={onClick}
    {...Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]))}
  >
    {children}
  </tr>
);

export const TableEmpty = ({ colSpan, children }: { colSpan: number; children: ReactNode }) => (
  <tr>
    <td colSpan={colSpan} className="px-3 py-5 text-center text-[13px]  text-muted-foreground">
      {children}
    </td>
  </tr>
);

// ── Charts (hand-drawn SVG; this app has no charting dependency) ─────────────

/**
 * Inline proportion bar — the fleet-QA `.kpi-bar`. Sits next to a number and shows
 * its share without a second chart. `value` and `max` are in the same unit; a `max`
 * of 0 renders an empty track rather than dividing by zero.
 */
export const MeterBar = ({ value, max, tone = 'plain', className }: { value: number; max: number; tone?: Tone; className?: string }) => {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  return (
    <span className={cn('inline-flex h-1.5 w-full min-w-[40px] overflow-hidden rounded-sm bg-muted/60 align-middle', className)}>
      <span className={cn('h-full rounded-sm transition-[width]', TONE_BG[tone])} style={{ width: `${pct}%` }} />
    </span>
  );
};

/**
 * A trend at row scale. Deliberately axis-less and label-less: it answers "rising,
 * falling or flat" beside a number that already gives the magnitude. Fewer than two
 * observations is not a trend, so it renders a dash rather than a misleading flat line.
 *
 * `null` IS A GAP, NEVER A ZERO — the same contract {@link StepAreaChart} keeps at panel scale,
 * and the reason this takes `(number | null)[]` rather than the bare `number[]` it used to.
 * A workload absent from an older sample was not installed yet, and the previous implementation
 * filtered the nulls out and joined whatever was left into ONE polyline: the gap closed silently,
 * the two runs either side slid together, and the series read as a continuous measurement of a
 * machine nobody was watching. Filtering is exactly the failure — so the runs are split instead
 * and each is drawn on its own.
 *
 * The x position comes from a point's index in the WHOLE series, not in the surviving subset, so
 * a gap keeps its real width and a break is visible as a break.
 */
export const Sparkline = ({
  points,
  tone = 'plain',
  width = 64,
  height = 16,
  className,
}: {
  points: (number | null)[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
}) => {
  const finite = points.filter((point): point is number => point !== null && Number.isFinite(point));

  if (finite.length < 2) {
    return <span className={cn('inline-block text-[10px] text-muted-foreground', className)}>—</span>;
  }

  // One scale across every run: two stretches either side of a gap are the same machine and
  // must stay comparable by height. Deriving a scale per run would make a break look like a
  // change in level.
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const step = width / Math.max(points.length - 1, 1);

  // `start` is the index a run begins at, unique across runs and therefore its React key.
  const runs: { start: number; points: string }[] = [];
  let current: string[] = [];
  let start = 0;

  const flush = () => {
    // A lone observation between two gaps is still a measurement. A one-point polyline draws
    // nothing at all, so it is doubled into a zero-length segment that `strokeLinecap="round"`
    // renders as a dot — present, and visibly not joined to anything.
    const [only] = current;
    if (current.length === 1 && only !== undefined) current.push(only);
    if (current.length > 0) runs.push({ start, points: current.join(' ') });
    current = [];
  };

  points.forEach((point, index) => {
    if (point === null || !Number.isFinite(point)) {
      flush();
      return;
    }

    if (current.length === 0) start = index;
    current.push(`${index * step},${height - ((point - min) / span) * height}`);
  });
  flush();

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn('inline-block align-middle', className)} aria-hidden="true">
      {runs.map((run) => (
        <polyline
          key={run.start}
          points={run.points}
          fill="none"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          className={cn(TONE_TEXT[tone] || 'text-foreground/70')}
          stroke="currentColor"
        />
      ))}
    </svg>
  );
};

/**
 * One bar, many segments — how a total divides. Used for "which backend holds the
 * models" and "where requests were served". Zero-width segments are dropped so a
 * backend with nothing loaded does not contribute an invisible sliver that still
 * shows a tooltip.
 */
export const StackedBar = ({ segments, className }: { segments: { label: string; value: number; tone?: Tone }[]; className?: string }) => {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

  if (total <= 0) {
    return <div className={cn('h-2 w-full rounded-sm bg-muted/60', className)} />;
  }

  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-sm bg-muted/60', className)}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div
            key={s.label}
            className={cn('h-full', TONE_BG[s.tone ?? 'plain'])}
            style={{ width: `${(s.value / total) * 100}%` }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
    </div>
  );
};

// ── Layout ───────────────────────────────────────────────────────────────────

/** A titled panel: small muted heading, optional right-side slot. */
export const Panel = ({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) => (
  /*
   * `@container` makes every panel a query container, so the tables inside can drop columns against
   * THEIR OWN width instead of the viewport's.
   *
   * A column keyed to `md:table-cell` appears at a 768px VIEWPORT, but the panel showing it may sit
   * in a track far narrower than that, so the column would arrive in a box that cannot hold it.
   *
   * Native in Tailwind v4 (no plugin), and inert for every panel that uses no `@` variant.
   */
  <section className={cn('@container space-y-2.5 rounded-lg border border-border bg-card px-4 py-3', className)}>
    <div className="flex items-center gap-2">
      <h3 className="text-[11px] font-medium   text-muted-foreground">{title}</h3>
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>
);

export const DASH = '—';

/** Bytes to a short human size. `null` is unmeasured and renders a dash, never "0 B". */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return DASH;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A count that may be unmeasured. */
export function humanCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : DASH;
}

/**
 * A duration in the unit a person reads it in: `850 ms`, `12.5 s`, `6m 40s`, `7h 16m`.
 *
 * The routing feed used to print `399710ms` for an agent turn that waited six and a half minutes for
 * its first byte. Every figure was correct and none of them was readable: on a fleet where a 40k-token
 * prompt takes 5-13 minutes to prefill, the interesting durations are minutes, and a seven-digit
 * millisecond count makes a reader do arithmetic to find out whether a node is slow. Below a second
 * the milliseconds ARE the unit (an embedding call, a cache hit), so they stay.
 *
 * `null`/non-finite is unmeasured and renders a dash, like every other helper here.
 */
export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const value = Math.max(0, ms);
  if (Math.round(value) < 1000) return `${Math.round(value)} ms`;

  // Rounded to the tenth BEFORE the unit is chosen, so 59.96 s prints "1m 0s" rather than "60.0 s".
  const tenths = Math.round(value / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;

  const seconds = Math.round(value / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Milliseconds since epoch for a timestamp as the Hub serves it, or `NaN`.
 *
 * ⚠ THE HUB SERVES TWO SHAPES, AND ONLY ONE OF THEM SAYS WHAT ZONE IT IS IN. Values the backend
 * builds in memory are ISO-8601 with a `Z`. Values it reads back out of Postgres `timestamp`
 * columns — which have no zone — arrive as `2026-09-27 10:22:22.896`: UTC wall-clock with the zone
 * dropped. `Date.parse` reads a zoneless date-time as BROWSER-LOCAL time, so on a PDT laptop the
 * fzzy Hub's restored history was labelled "10:22 AM" for a sample taken at 03:22 local, seven hours
 * off, with nothing on screen to say so. Every zoneless value this product emits is UTC, so that is
 * what it is read as here; a value that carries a zone is left to say so itself.
 */
export function parseHubTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const trimmed = value.trim();
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed);

  return Date.parse(zoneless ? `${trimmed.replace(' ', 'T')}Z` : trimmed);
}

/**
 * A timestamp as the Hub serves it, as the viewer's local date and time, or {@link DASH} when it is not a date.
 * Reads a zoneless value as the UTC it is (see {@link parseHubTimestamp}); `new Date(value)` read it as local.
 */
export function formatHubDateTime(value: string | null | undefined): string {
  const parsed = parseHubTimestamp(value);

  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : DASH;
}

/** Short relative age, for "last seen" columns. */
export function relativeAge(iso: string | null | undefined, now: number): string {
  if (!iso) return DASH;
  const parsed = parseHubTimestamp(iso);
  if (!Number.isFinite(parsed)) return DASH;
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;

  return `${Math.round(seconds / 86_400)}d`;
}
