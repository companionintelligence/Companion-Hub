import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { fetchAppRuntimeMonitor, formatCpuLimitLabel } from '@/lib/app-runtime-monitor';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Activity } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const RESOURCE_MONITOR_POLL_MS = 60_000;
const HISTORY_LIMIT = 12;
const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_COLORS = ['#0f717a', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#14b8a6'];

type CpuHistorySample = {
  sampledAt: string;
  cpuByApp: Record<string, number>;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function buildCpuSeriesPoints(history: CpuHistorySample[], appUrn: string, maxCpu: number) {
  if (history.length === 0) {
    return '';
  }

  return history
    .map((sample, index) => {
      const x = history.length === 1 ? 0 : (index / (history.length - 1)) * CHART_WIDTH;
      const value = sample.cpuByApp[appUrn] ?? 0;
      const y = CHART_HEIGHT - (value / maxCpu) * CHART_HEIGHT;
      return `${x},${Number.isFinite(y) ? y : CHART_HEIGHT}`;
    })
    .join(' ');
}

function CpuUsageHistoryChart({ history }: { history: CpuHistorySample[] }) {
  const { t } = useTranslation();

  const apps = useMemo(() => {
    const totals = new Map<string, number>();
    for (const sample of history) {
      for (const [appUrn, cpuPercent] of Object.entries(sample.cpuByApp)) {
        totals.set(appUrn, (totals.get(appUrn) ?? 0) + cpuPercent);
      }
    }

    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CHART_COLORS.length)
      .map(([appUrn], index) => ({ appUrn, color: CHART_COLORS[index] as string }));
  }, [history]);

  const maxCpu = Math.max(100, ...history.flatMap((sample) => Object.values(sample.cpuByApp)));

  if (history.length < 2 || apps.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">{t('RESOURCE_MONITOR_CHART_WAITING')}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-80 min-w-[720px] w-full rounded-xl border border-border/60 bg-card/40 p-3"
          role="img"
          aria-label={t('RESOURCE_MONITOR_CHART_TITLE')}
        >
          {[0, 25, 50, 75, 100].map((tick) => {
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
          {apps.map((app) => (
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

      <div className="flex flex-wrap gap-3">
        {apps.map((app) => (
          <div key={app.appUrn} className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: app.color }} />
            <span className="font-medium">{app.appUrn}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const [history, setHistory] = useState<CpuHistorySample[]>([]);
  const monitor = useQuery({
    queryKey: ['app-resource-monitor'],
    queryFn: fetchAppRuntimeMonitor,
    refetchInterval: RESOURCE_MONITOR_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: RESOURCE_MONITOR_POLL_MS / 2,
  });

  const apps = monitor.data?.apps ?? [];
  const degradedApps = apps.filter((app) => app.degraded);

  useEffect(() => {
    if (!monitor.data) {
      return;
    }

    setHistory((current) => {
      const nextSample: CpuHistorySample = {
        sampledAt: monitor.data.sampledAt,
        cpuByApp: Object.fromEntries(monitor.data.apps.map((app) => [app.appUrn, app.cpuPercent])),
      };

      if (current.at(-1)?.sampledAt === nextSample.sampledAt) {
        return current;
      }

      return [...current, nextSample].slice(-HISTORY_LIMIT);
    });
  }, [monitor.data]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{t('RESOURCE_MONITOR_TITLE')}</h1>
        <p className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_SUBTITLE')}</p>
      </div>

      {degradedApps.length > 0 && (
        <Alert variant="warning">
          <AlertIcon>
            <AlertTriangle strokeWidth={2} />
          </AlertIcon>
          <div>
            <AlertHeading>{t('RESOURCE_MONITOR_DEGRADED_TITLE')}</AlertHeading>
            <AlertDescription>
              {degradedApps.map((app) => app.appName).join(', ')} — {t('RESOURCE_MONITOR_DEGRADED_SUBTITLE')}
            </AlertDescription>
          </div>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('RESOURCE_MONITOR_CHART_TITLE')}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_CHART_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <CpuUsageHistoryChart history={history} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('RESOURCE_MONITOR_TABLE_TITLE')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('COMMON_APP')}</TableHead>
                <TableHead>{t('COMMON_STATUS')}</TableHead>
                <TableHead>{t('COMMON_CPU')}</TableHead>
                <TableHead>{t('COMMON_MEMORY')}</TableHead>
                <TableHead>{t('RESOURCE_MONITOR_CPU_CAP')}</TableHead>
                <TableHead>{t('RESOURCE_MONITOR_RESPONSIVENESS')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <TableRow key={app.appUrn}>
                  <TableCell>
                    <div className="font-medium">{app.appName}</div>
                    <div className="text-xs text-muted-foreground">{app.appUrn}</div>
                  </TableCell>
                  <TableCell>{app.status}</TableCell>
                  <TableCell className={app.highCpu ? 'text-amber-600 font-medium' : ''}>{app.cpuPercent.toFixed(1)}%</TableCell>
                  <TableCell>
                    {formatBytes(app.memoryUsageBytes)}
                    {app.memoryLimitBytes > 0 ? <span className="text-muted-foreground"> / {formatBytes(app.memoryLimitBytes)}</span> : null}
                  </TableCell>
                  <TableCell>{formatCpuLimitLabel(app.cpuLimit, app.usesDefaultCpuLimit)}</TableCell>
                  <TableCell className={app.degraded ? 'text-destructive font-medium' : app.responsive ? 'text-emerald-600' : 'text-amber-600'}>
                    {app.degraded
                      ? t('RESOURCE_MONITOR_DEGRADED_BADGE')
                      : app.responsive
                        ? t('RESOURCE_MONITOR_RESPONSIVE')
                        : t('RESOURCE_MONITOR_UNRESPONSIVE')}
                    {app.reason ? <div className="text-xs text-muted-foreground">{app.reason}</div> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {apps.length === 0 && !monitor.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('RESOURCE_MONITOR_EMPTY')}</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
