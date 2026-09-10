import { computeCpuChartScale } from '@/modules/system/resource-monitor-chart';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_COLORS = ['#0a6358', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#14b8a6'];

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
      .slice(0, CHART_COLORS.length)
      .map(([appUrn], index) => ({
        appUrn,
        appName: labels.get(appUrn) ?? appUrn,
        color: CHART_COLORS[index] as string,
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
