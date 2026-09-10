import { HintText } from '@/components/ui/field-hint/field-hint';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/*
 * Dense read-out primitives, shared by the Network settings tab and the resource
 * dashboard.
 *
 * The idiom is the fleet-QA dashboard's: a value is large and a label is small,
 * uppercase and quiet, so a glance reads the numbers and only a second look reads
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
  <div className="flex min-w-[92px] flex-col gap-1 rounded-md border border-border bg-muted/20 px-3 py-2">
    <span className={cn('text-[22px] font-bold leading-none tabular-nums', TONE_TEXT[tone])}>{value}</span>
    <span className="text-[11px] uppercase leading-tight tracking-[0.5px] text-muted-foreground">
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
  <div className={cn('overflow-x-auto rounded-md border border-border', className)}>
    <table className="w-full border-collapse text-[13px]">
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
      'whitespace-nowrap border-b border-border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground',
      align === 'right' ? 'text-right' : 'text-left',
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
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
}) => (
  <td
    className={cn('border-b border-border/70 px-3 py-2 align-middle tabular-nums', align === 'right' ? 'text-right' : 'text-left', className)}
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
export const Tr = ({ children, testId, data }: { children: ReactNode; testId?: string; data?: Record<string, string> }) => (
  <tr
    className="transition-colors last:[&>td]:border-b-0 hover:bg-muted/30"
    data-testid={testId}
    {...Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]))}
  >
    {children}
  </tr>
);

export const TableEmpty = ({ colSpan, children }: { colSpan: number; children: ReactNode }) => (
  <tr>
    <td colSpan={colSpan} className="px-3 py-6 text-center text-[13px] italic text-muted-foreground">
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
 * points is not a trend, so it renders nothing rather than a misleading flat line.
 */
export const Sparkline = ({
  points,
  tone = 'plain',
  width = 64,
  height = 16,
  className,
}: {
  points: number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
}) => {
  const finite = points.filter((p) => Number.isFinite(p));

  if (finite.length < 2) {
    return <span className={cn('inline-block text-[10px] text-muted-foreground', className)}>—</span>;
  }

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const step = width / (finite.length - 1);
  const d = finite.map((p, i) => `${i * step},${height - ((p - min) / span) * height}`).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn('inline-block align-middle', className)} aria-hidden="true">
      <polyline
        points={d}
        fill="none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className={cn(TONE_TEXT[tone] || 'text-foreground/70')}
        stroke="currentColor"
      />
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

/**
 * A watched count over time, drawn as steps and filled to the baseline.
 *
 * STEPS, NEVER A SMOOTHED LINE, and that is the whole reason this exists beside `Sparkline`.
 * Each point is one poll; between two polls the Hub was not observed at all. A diagonal joining
 * 0 to 3 draws two intermediate request counts that were never measured, and on a page whose job
 * is to say what the pool is doing, a drawn value nothing measured is the failure mode. A step
 * holds the last observation until the next one replaces it, which is exactly what was known.
 *
 * `null` is a GAP, not a zero: the poll landed and this node was not in it. The path breaks and
 * the fill stops, so an absent node reads as absent rather than as idle.
 *
 * The axis is passed in rather than derived from the series, so every card in a grid shares one
 * scale and two cards can be compared by height.
 */
export const StepAreaChart = ({
  points,
  max,
  tone = 'ok',
  height = 96,
  label,
  className,
}: {
  points: (number | null)[];
  max: number;
  tone?: Tone;
  height?: number;
  label?: string;
  className?: string;
}) => {
  const width = 480;
  const ceiling = max > 0 ? max : 1;
  const observed = points.filter((point): point is number => point !== null && Number.isFinite(point));

  // One observation is a reading, not a trend — but it is still a fact, so it is drawn as a
  // single step rather than withheld. Zero observations has nothing to draw at all.
  if (observed.length === 0) {
    return <div className={cn('h-[96px] w-full rounded-md border border-dashed border-border/70 bg-muted/20', className)} style={{ height }} />;
  }

  // A single observation cannot span an interval, so the axis always reserves at least two slots.
  // One reading then fills half the box rather than all of it, which is the honest picture: the
  // rest of that window has not been watched yet.
  const slots = Math.max(points.length, 2);
  const slot = width / slots;
  const y = (value: number) => height - (Math.min(value, ceiling) / ceiling) * (height - 2) - 1;

  // `start` is the index the run begins at, which is unique across runs and therefore its key.
  const runs: { start: number; d: string; fill: string }[] = [];
  let line: string[] = [];
  let area: string[] = [];
  let runStart = 0;

  const flush = (endIndex: number) => {
    if (line.length > 0) {
      runs.push({ start: runStart, d: line.join(' '), fill: `${area.join(' ')} L ${endIndex * slot},${height} L ${runStart * slot},${height} Z` });
    }
    line = [];
    area = [];
  };

  points.forEach((point, index) => {
    const x0 = index * slot;
    const x1 = (index + 1) * slot;

    if (point === null || !Number.isFinite(point)) {
      flush(index);
      return;
    }

    const yValue = y(point);
    if (line.length === 0) {
      runStart = index;
      line.push(`M ${x0},${yValue}`);
      area.push(`M ${x0},${yValue}`);
    } else {
      // The vertical riser first, then the horizontal hold: a step, not a ramp.
      line.push(`L ${x0},${yValue}`);
      area.push(`L ${x0},${yValue}`);
    }
    line.push(`L ${x1},${yValue}`);
    area.push(`L ${x1},${yValue}`);
  });
  flush(points.length);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full rounded-md border border-border/60 bg-muted/20', className)}
      style={{ height }}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line key={fraction} x1="0" y1={height * fraction} x2={width} y2={height * fraction} stroke="currentColor" strokeOpacity="0.1" />
      ))}
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="currentColor" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />
      {runs.map((run) => (
        <g key={run.start} className={TONE_TEXT[tone] || 'text-foreground/70'}>
          <path d={run.fill} fill="currentColor" fillOpacity="0.18" stroke="none" />
          <path d={run.d} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </svg>
  );
};

/**
 * A discrete band, drawn as pips rather than as a percentage.
 *
 * GPU pressure is a smoothed 0-3 band and there is no percentage anywhere in this product to
 * convert it into. Four pips say "band 2 of 3" and cannot be misread as "66% utilised", which a
 * meter would be. `value === null` means the node could not measure — most of the fleet, since
 * the signal is AMD-only and the sampler is disarmed entirely on an unpaired Hub — and it renders
 * as hollow pips plus the caller's own unknown label. Band 0 is a real measurement and renders as
 * a filled first pip, so "measured, idle" never looks like "unmeasured".
 */
export const BandMeter = ({ value, bands = 3, className }: { value: number | null; bands?: number; className?: string }) => (
  <span className={cn('inline-flex items-center gap-0.5 align-middle', className)}>
    {Array.from({ length: bands + 1 }, (_, band) => ({ id: `band-${band}`, band })).map(({ id, band }) => (
      <span
        key={id}
        className={cn(
          'h-2.5 w-1.5 rounded-[1px] border',
          value === null
            ? 'border-muted-foreground/40 bg-transparent'
            : band <= value
              ? band >= bands
                ? 'border-destructive bg-destructive'
                : band >= bands - 1
                  ? 'border-warning bg-warning'
                  : 'border-success bg-success'
              : 'border-border bg-muted/50',
        )}
      />
    ))}
  </span>
);

// ── Layout ───────────────────────────────────────────────────────────────────

/** Panel inside a dashboard section: micro-uppercase heading, optional right-side slot. */
export const Panel = ({ title, actions, children, className }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cn('space-y-3 rounded-lg border border-border bg-card p-4', className)}>
    <div className="flex items-center gap-2">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>
);

/**
 * The three states of a panel, kept apart on purpose.
 *
 * "Still loading", "the request failed" and "it loaded and there is genuinely nothing"
 * are three different facts that send an operator to three different places, and on a
 * monitoring dashboard the failure mode that matters is the middle one collapsing into
 * the last. A panel that renders a failed fetch as an empty table — or worse, as `0` —
 * states something the Hub never said. So the body is REPLACED while pending or failed;
 * derived zeros computed from `undefined` data never reach the screen.
 *
 * `pending`, not `isLoading`: an errored query has `isLoading === false` and no data, so
 * a skeleton keyed off `isLoading` would sit there forever on a failed fetch.
 */
export const PanelBody = ({
  state,
  error,
  lines = 3,
  children,
}: {
  state: { pending: boolean; failed: boolean };
  error: string;
  lines?: number;
  children: ReactNode;
}) => {
  if (state.failed) {
    return <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">{error}</p>;
  }

  if (state.pending) {
    return (
      <div className="space-y-1.5" aria-busy="true">
        {Array.from({ length: lines }, (_, index) => 100 - index * 12).map((width) => (
          <div key={width} className="h-3 animate-pulse rounded-sm bg-muted/60" style={{ width: `${width}%` }} />
        ))}
      </div>
    );
  }

  return <>{children}</>;
};

/** Top-level dashboard section: a rule, a title, and its panels. */
export const DashboardSection = ({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) => (
  <section className="space-y-4">
    <div className="flex items-center gap-2 border-b border-border pb-2">
      <h2 className="text-sm font-bold uppercase tracking-[0.1em]">{title}</h2>
      {badge}
    </div>
    {children}
  </section>
);

// ── Formatting ───────────────────────────────────────────────────────────────

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

/** Short countdown to a future timestamp, for "expires in" columns. */
export function relativeUntil(iso: string | null | undefined, now: number): string {
  if (!iso) return DASH;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return DASH;
  const seconds = Math.round((parsed - now) / 1000);
  // Already past: the engine will evict on next sweep, which is not the same as "no expiry".
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  return `${Math.round(seconds / 3600)}h`;
}

/** Short relative age, for "last seen" columns. */
export function relativeAge(iso: string | null | undefined, now: number): string {
  if (!iso) return DASH;
  const parsed = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return DASH;
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;

  return `${Math.round(seconds / 86_400)}d`;
}
