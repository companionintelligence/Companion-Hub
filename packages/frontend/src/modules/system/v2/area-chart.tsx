import { cn } from '@/lib/utils';

/*
 * The one large chart on the page, in the shape Task Manager uses for its Performance graphs: a
 * stacked area over a fixed time window, gridlines every quarter of the axis, the axis ceiling in the
 * top corner and the window's ends along the bottom. The plot is an SVG stretched to its box; every
 * label is HTML so it never stretches with it.
 */

export interface AreaSeries {
  key: string;
  label: string;
  /** A text-colour class; the series fills and strokes with `currentColor`. */
  colorClass: string;
  values: (number | null)[];
}

const VIEW_W = 1000;
const VIEW_H = 240;

/**
 * One path per run of measured points. `null` is a gap, never a zero: the line and the fill break
 * there, so a stretch nobody measured does not read as an idle machine.
 */
function stackedPaths(series: AreaSeries[], max: number) {
  const length = Math.max(0, ...series.map((s) => s.values.length));
  const step = length > 1 ? VIEW_W / (length - 1) : VIEW_W;
  const y = (value: number) => VIEW_H - (Math.min(value, max) / max) * VIEW_H;
  const base = new Array<number>(length).fill(0);

  return series.map((s) => {
    const lower = [...base];
    const measured = (i: number) => {
      const value = s.values[i];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const upper = base.map((b, i) => b + (measured(i) ?? 0));
    upper.forEach((value, i) => {
      base[i] = value;
    });

    const runs: number[][] = [];
    for (let i = 0; i < length; i += 1) {
      if (measured(i) === null) continue;
      const run = runs.at(-1);
      if (run && run.at(-1) === i - 1) run.push(i);
      else runs.push([i]);
    }
    const area = runs
      .map((run) => {
        const top = run.map((i) => `${i * step},${y(upper[i] ?? 0)}`);
        const bottom = run.map((i) => `${i * step},${y(lower[i] ?? 0)}`).reverse();
        return `M${top.join(' L')} L${bottom.join(' L')} Z`;
      })
      .join(' ');
    const line = runs.map((run) => `M${run.map((i) => `${i * step},${y(upper[i] ?? 0)}`).join(' L')}`).join(' ');
    return { key: s.key, colorClass: s.colorClass, area, line };
  });
}

export function AreaChart({
  series,
  max,
  unit,
  start,
  end,
  height = 220,
  label,
  className,
}: {
  series: AreaSeries[];
  max: number;
  unit: string;
  start: string;
  end: string;
  height?: number;
  label: string;
  className?: string;
}) {
  const paths = stackedPaths(series, max);

  return (
    <figure className={cn('space-y-2', className)}>
      <div className="relative rounded-md border border-border bg-background/40" style={{ height }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <div key={f} className="absolute inset-x-0 border-t border-border/60" style={{ top: `${f * 100}%` }} aria-hidden="true" />
        ))}
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="absolute inset-0 size-full" role="img" aria-label={label}>
          {paths.map((p) => (
            <g key={p.key} className={p.colorClass}>
              <path d={p.area} fill="currentColor" fillOpacity={0.18} />
              <path d={p.line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </g>
          ))}
        </svg>
        <span className="absolute top-1.5 right-2 text-xs text-muted-foreground tabular-nums">
          {max}
          {unit}
        </span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{start}</span>
        <span>{end}</span>
      </div>
    </figure>
  );
}

/** One bar per minute, served stacked under failed, for the Requests tab. */
export function MinuteBars({ buckets, height = 120, label }: { buckets: { at: number; ok: number; bad: number }[]; height?: number; label: string }) {
  const peak = Math.max(1, ...buckets.map((b) => b.ok + b.bad));

  return (
    <div
      className="flex items-end gap-[3px] rounded-md border border-border bg-background/40 px-2 pt-3 pb-2"
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {buckets.map((b) => {
        const total = b.ok + b.bad;
        return (
          <div key={b.at} className="flex h-full flex-1 flex-col justify-end" title={total ? `${total} request${total === 1 ? '' : 's'}` : undefined}>
            {b.bad > 0 ? <div className="rounded-t-sm bg-destructive" style={{ height: `${(b.bad / peak) * 100}%` }} /> : null}
            {b.ok > 0 ? <div className={cn('bg-primary', b.bad > 0 ? '' : 'rounded-t-sm')} style={{ height: `${(b.ok / peak) * 100}%` }} /> : null}
            {total === 0 ? <div className="h-px bg-border" /> : null}
          </div>
        );
      })}
    </div>
  );
}
