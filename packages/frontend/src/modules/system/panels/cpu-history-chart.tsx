import { computeCpuChartScale } from '@/modules/system/resource-monitor-chart';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
/*
 * Series colours come from the canon's `--chart-*` ramp, not from hardcoded hex.
 *
 * The old literals had two problems. They were fixed values on a themed page, so the
 * darkest of them drew at 1.91:1 against the dark card — below any legibility bar. And
 * slot 4 was `#ef4444`, so the fourth-busiest workload was rendered in the same red this
 * app uses for failure: a perfectly healthy container looked like an incident.
 *
 * The canon defines five slots with separate light and dark values, so these follow the
 * theme. Five, not eight — the ramp is the palette that exists, and a sixth series
 * repeating slot 1 is honest, whereas inventing three more hues is how the red got in.
 */
const CHART_SLOTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const;

/*
 * Per-workload CPU over time. Kept verbatim from the previous resource page — it is the
 * only real time-series the Hub records, and the dashboard rebuild around it must not
 * lose it. Hand-drawn SVG because this app has no charting dependency.
 */

function formatSampleTime(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function cpuForApp(sample: AppRuntimeHistorySample, appUrn: string): number {
  return sample.apps.find((app) => app.appUrn === appUrn)?.cpuPercent ?? 0;
}

function buildCpuSeriesPoints(history: AppRuntimeHistorySample[], appUrn: string, maxCpu: number) {
  if (history.length === 0) {
    return '';
  }

  return history
    .map((sample, index) => {
      const x = history.length === 1 ? 0 : (index / (history.length - 1)) * CHART_WIDTH;
      const value = cpuForApp(sample, appUrn);
      const y = CHART_HEIGHT - (value / maxCpu) * CHART_HEIGHT;
      return `${x},${Number.isFinite(y) ? y : CHART_HEIGHT}`;
    })
    .join(' ');
}

export function CpuUsageHistoryChart({ history, apps }: { history: AppRuntimeHistorySample[]; apps: AppRuntimeHealth[] }) {
  const { t } = useTranslation();

  const chartApps = useMemo(() => {
    const totals = new Map<string, number>();
    for (const sample of history) {
      for (const app of sample.apps) {
        totals.set(app.appUrn, (totals.get(app.appUrn) ?? 0) + app.cpuPercent);
      }
    }

    const labels = new Map(apps.map((app) => [app.appUrn, app.appName]));
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CHART_SLOTS.length)
      .map(([appUrn], index) => ({
        appUrn,
        appName: labels.get(appUrn) ?? appUrn,
        color: `var(${CHART_SLOTS[index % CHART_SLOTS.length]})`,
      }));
  }, [apps, history]);

  const { max: maxCpu, ticks: chartTicks } = useMemo(() => {
    const cpuPercents = [...history.flatMap((sample) => sample.apps.map((app) => app.cpuPercent)), ...apps.map((app) => app.cpuPercent)];
    return computeCpuChartScale(cpuPercents);
  }, [apps, history]);

  if (history.length < 2 || chartApps.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{t('RESOURCE_MONITOR_CHART_WAITING')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-80 min-w-[720px] w-full rounded-lg border border-border/60 bg-card/40 p-3"
          role="img"
          aria-label={t('RESOURCE_MONITOR_CHART_TITLE')}
        >
          {chartTicks.map((tick) => {
            const y = CHART_HEIGHT - (tick / maxCpu) * CHART_HEIGHT;
            return (
              <g key={tick}>
                <line x1="0" y1={y} x2={CHART_WIDTH} y2={y} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
                <text x="8" y={Math.max(y - 6, 12)} fontSize="12" fill="currentColor" opacity="0.7">
                  {tick}%
                </text>
              </g>
            );
          })}
          {chartApps.map((app) => (
            <polyline
              key={app.appUrn}
              fill="none"
              stroke={app.color}
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={buildCpuSeriesPoints(history, app.appUrn, maxCpu)}
            />
          ))}
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{formatSampleTime(history[0]?.sampledAt ?? '')}</span>
        <span>{formatSampleTime(history.at(-1)?.sampledAt ?? '')}</span>
      </div>

      <div className="flex flex-wrap gap-3">
        {chartApps.map((app) => (
          <div key={app.appUrn} className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: app.color }} />
            <span className="font-medium">{app.appName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
