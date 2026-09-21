import { DASH, humanBytes, Panel, PanelBody, StepAreaChart } from '@/components/ui/dense/dense';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { computeCpuChartScale, computeMemoryChartScale, computeVramChartScale } from '@/modules/system/resource-monitor-chart';
import type { LoadState } from '@/modules/system/use-dashboard-data';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * PER-WORKLOAD TRENDS — the metrics the Hub actually records per workload, as small multiples.
 *
 * `AppRuntimeHistoryPoint` carries `{ appUrn, appName, status, cpuPercent, memoryUsageBytes,
 * containerCount, gpuVramMb }`. CPU, memory and GPU VRAM over time are therefore real and drawn
 * here. GPU VRAM is real per-process data (`gpu-process-sampler.service.ts`), attributed to
 * whichever workload's container holds it (`DockerReadFacade.mapPidsToContainers`) — it is NOT
 * compute utilization, which no tool this Hub shells out to can report per process on this fleet's
 * hardware (see `workload-coverage.tsx`, which still states THAT absence in words). Tokens per
 * workload are not in this payload, not anywhere behind it, and are not drawn ANYWHERE — the
 * proxy has no concept of which app a request came from at all, only which model and node served
 * it (see `pool-activity.tsx`'s per-model token breakdown, the nearest real signal there is).
 *
 * ── Why five small charts and not one five-series overlay ────────────────────────────────────
 *
 * The overlay this replaces was a single 960×320 SVG with `min-w-[720px]` inside an
 * `overflow-x-auto`: a horizontal scroll trap on a phone, and on a wide desktop one near-flat
 * line with a single spike and acres of dead space. Worse, its legend carried names and no
 * values, so on a touch device — where there is no hover — the chart could not be read at all.
 *
 * Each row here puts the workload's NAME, its CURRENT value and its PEAK on the same line as its
 * own trace. There is no legend to lose, no hover to require, and no series to disentangle from
 * four others. All five rows in a tile share ONE axis, passed in rather than derived per row, so
 * two rows remain comparable by height; the peak is printed per row so a sliver is never an
 * unreadable value.
 *
 * ── Why steps and not a line ─────────────────────────────────────────────────────────────────
 *
 * Each point is one 60-second sample. Between two samples the workload was not observed at all,
 * so a diagonal joining them would draw CPU values nothing measured. `StepAreaChart` holds the
 * last observation until the next replaces it, which is exactly what was known — and it is why
 * that primitive is reused rather than a polyline written here.
 *
 * ── Why nothing here has a fixed width ───────────────────────────────────────────────────────
 *
 * `main` carries `overflow-x-hidden` and `body` is `overflow: hidden`, so a `min-w-*` inside a
 * chart is not something a phone can scroll to — it is clipped and simply unreachable. Shrinking
 * it would not have been the fix; removing it is. There is no `overflow-x-auto` and no `min-w-*`
 * anywhere in this file, at any width.
 */

/*
 * Series colours come from the canon's `--chart-*` ramp, not from hardcoded hex — five slots with
 * separate light and dark values, so the traces follow the theme instead of drawing at 1.9:1
 * against a dark card. Five, not eight: the ramp is the palette that exists, and a sixth series
 * repeating slot 1 is honest, whereas inventing three more hues is how a healthy container ended
 * up drawn in this app's failure red.
 */
const CHART_SLOTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const;

const ROW_HEIGHT = 38;

/*
 * `gpuVramMb` is MEGABYTES; `memoryUsageBytes` is bytes, and so is everything this tile draws,
 * scales and formats. The conversion happens ONCE, in `valueForApp`, so the series, each row's
 * current and peak, the axis ceiling and `humanBytes` all see the same unit. It used to happen at
 * render instead, which is how the axis label read "scale to 256 TB" above a 10 GB card: the
 * ceiling was computed from raw megabytes by a byte-denominated scale, whose 256 MiB floor is
 * 268,435,456, and that number was then multiplied by 1024² a second time as if it were megabytes.
 * Every Hub whose workloads held no VRAM hit the floor, so every node printed it.
 */
const MIB = 1024 ** 2;

type Metric = 'cpu' | 'memory' | 'gpu';

/**
 * One workload's value in one sample, or `null` for "not known".
 *
 * ⚠ NOT `?? 0`, which is what this replaced for cpu/memory. Every installed, non-missing app
 * appears in EVERY sample the backend takes, so an app absent from an older sample was not
 * installed yet — coalescing that to zero drew a workload as having sat at 0% for the first half
 * of the window, a measurement nobody took. `gpuVramMb` carries the SAME null-means-unmeasured
 * rule one level deeper: the point itself is always present, but the field inside it is `null`
 * whenever nothing was found for this workload that tick (see `AppRuntimeHealth.gpuVramMb`'s own
 * doc comment for why that can mean either "genuinely holds none" or "the sampler did not run" —
 * both look identical from here, and both are correctly a gap, never a zero). `StepAreaChart`
 * renders `null` as a gap either way.
 */
function valueForApp(sample: AppRuntimeHistorySample, appUrn: string, metric: Metric): number | null {
  const point = sample.apps.find((app) => app.appUrn === appUrn);
  if (!point) return null;

  if (metric === 'cpu') return point.cpuPercent;
  if (metric === 'gpu') return point.gpuVramMb === null ? null : point.gpuVramMb * MIB;
  return point.memoryUsageBytes;
}

function formatSampleTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

export function WorkloadTrend({
  metric,
  history,
  apps,
  state,
  className,
}: {
  metric: Metric;
  history: AppRuntimeHistorySample[];
  apps: AppRuntimeHealth[];
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const title =
    metric === 'cpu' ? t('DASHBOARD_TRENDS_CPU_TITLE') : metric === 'gpu' ? t('DASHBOARD_TRENDS_GPU_TITLE') : t('DASHBOARD_TRENDS_MEM_TITLE');
  // Both byte-denominated metrics arrive here already in bytes — see `MIB` above. No unit
  // arithmetic at render, on purpose: it is the one place a value and its axis could be converted
  // a different number of times.
  const format = (value: number) => (metric === 'cpu' ? `${value.toFixed(1)}%` : humanBytes(value));
  // The axis ceiling is a round number by construction, so it is printed as one. `100.0%` reads
  // as a measurement that happened to land on the ceiling rather than as the ceiling itself.
  const formatAxis = (value: number) => (metric === 'cpu' ? `${Math.round(value)}%` : humanBytes(value));

  const rows = useMemo(() => {
    const labels = new Map(apps.map((app) => [app.appUrn, app.appName]));

    const metricValue = (point: { cpuPercent: number; memoryUsageBytes: number; gpuVramMb: number | null }) =>
      metric === 'cpu' ? point.cpuPercent : metric === 'gpu' ? (point.gpuVramMb ?? 0) : point.memoryUsageBytes;

    /*
     * Ranked by the total across the window when there IS a window, and by the current reading
     * when there is not. The two are never mixed: a sum over samples and a single sample are
     * different quantities, and blending them would rank a workload installed a minute ago above
     * one that has been busy for twenty. Neither number is ever displayed — this is a ranking only.
     */
    const ranked =
      history.length > 0
        ? [
            ...history
              .reduce((totals, sample) => {
                for (const point of sample.apps) {
                  totals.set(point.appUrn, (totals.get(point.appUrn) ?? 0) + metricValue(point));
                }

                return totals;
              }, new Map<string, number>())
              .entries(),
          ]
        : apps.map((app): [string, number] => [app.appUrn, metricValue(app)]);

    return ranked
      .sort((a, b) => b[1] - a[1])
      .slice(0, CHART_SLOTS.length)
      .map(([appUrn], index) => {
        const series = history.map((sample) => valueForApp(sample, appUrn, metric));
        const observed = series.filter((value): value is number => value !== null && Number.isFinite(value));

        return {
          appUrn,
          appName: labels.get(appUrn) ?? appUrn,
          color: `var(${CHART_SLOTS[index % CHART_SLOTS.length]})`,
          series,
          // The LAST observation, not the last array slot: a workload missing from the newest
          // sample has a current value of "unknown", which the caller renders as a dash.
          current: observed.at(-1) ?? null,
          peak: observed.length > 0 ? Math.max(...observed) : null,
        };
      });
  }, [apps, history, metric]);

  /*
   * ONE AXIS FOR THE WHOLE TILE. `StepAreaChart` takes its ceiling rather than deriving one,
   * precisely so five rows drawn side by side can be compared by height. A per-row axis would
   * draw a workload at 3% and a workload at 300% as the same shape.
   */
  const axisMax = useMemo(() => {
    const values = rows.flatMap((row) => row.series.filter((value): value is number => value !== null && Number.isFinite(value)));

    if (metric === 'cpu') return computeCpuChartScale(values).max;
    // Bytes in both cases; the VRAM scale differs only in where it floors an empty tile.
    return metric === 'gpu' ? computeVramChartScale(values).max : computeMemoryChartScale(values).max;
  }, [metric, rows]);

  return (
    <Panel title={title} density="compact" className={className}>
      <PanelBody state={state} error={t('DASHBOARD_CONTAINERS_FAILED')} lines={6}>
        {rows.length === 0 ? (
          <p className="py-5 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_TRENDS_NO_WORKLOADS')}</p>
        ) : history.length < 2 ? (
          <p className="py-5 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_TRENDS_WAITING', { total: history.length })}</p>
        ) : (
          <div className="space-y-1.5">
            {/* Every axis label is HTML and lives outside the SVG: `preserveAspectRatio="none"`
                stretches the viewBox to the container, and a <text> inside it stretches too. */}
            <div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
              <span>{formatSampleTime(history[0]?.sampledAt ?? '')}</span>
              {/* This is the AXIS CEILING, not a measurement. `computeCpuChartScale` rounds up to a
                  readable gridline, so on a tile whose busiest workload touched 12% it is 100 — a
                  number nothing observed. Labelling it "peak" put that invented figure directly above
                  rows printing their own true peaks, where the two read as the same quantity. The real
                  per-workload peak is on each row; this says only how tall the plot is. */}
              <span className="tabular-nums">{t('DASHBOARD_TRENDS_AXIS', { max: formatAxis(axisMax) })}</span>
              <span>{formatSampleTime(history.at(-1)?.sampledAt ?? '')}</span>
            </div>

            <ul className="space-y-1.5">
              {rows.map((row) => (
                <li key={row.appUrn} className="space-y-0.5">
                  <div className="flex items-baseline gap-2 text-[11px]">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                    <span className="min-w-0 flex-1 truncate font-medium" title={`${row.appName} · ${row.appUrn}`}>
                      {row.appName}
                    </span>
                    {/* The value sits in the row, not in a legend below the plot. On a touch
                        device there is no hover, so a name without a number is unreadable. */}
                    <span className="shrink-0 font-medium tabular-nums text-foreground">{row.current === null ? DASH : format(row.current)}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {t('DASHBOARD_TRENDS_PEAK', { value: row.peak === null ? DASH : format(row.peak) })}
                    </span>
                  </div>
                  <StepAreaChart
                    variant="row"
                    height={ROW_HEIGHT}
                    points={row.series}
                    max={axisMax}
                    tone="plain"
                    label={`${row.appName} — ${title}`}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
