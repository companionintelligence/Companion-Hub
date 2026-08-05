import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { fetchAppRuntimeMonitor, formatCpuLimitLabel, type AppRuntimeHealth, type AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { computeCpuChartScale } from '@/modules/system/resource-monitor-chart';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Activity } from 'lucide-react';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const RESOURCE_MONITOR_POLL_MS = 60_000;
const HISTORY_LIMIT = 12;
const CHART_WIDTH = 960;
const CHART_HEIGHT = 320;
const CHART_COLORS = ['#0a6358', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#14b8a6'];

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatSampleTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
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

function CpuUsageHistoryChart({ history, apps }: { history: AppRuntimeHistorySample[]; apps: AppRuntimeHealth[] }) {
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

function WorkloadResponsiveness({ app }: { app: AppRuntimeHealth }) {
  const { t } = useTranslation();

  return (
    <div className={app.degraded ? 'text-destructive font-medium' : app.responsive ? 'text-emerald-600' : 'text-amber-600'}>
      {app.degraded ? t('RESOURCE_MONITOR_DEGRADED_BADGE') : app.responsive ? t('RESOURCE_MONITOR_RESPONSIVE') : t('RESOURCE_MONITOR_UNRESPONSIVE')}
      {app.reason ? <div className="text-xs text-muted-foreground">{app.reason}</div> : null}
    </div>
  );
}

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const monitor = useQuery({
    queryKey: ['app-resource-monitor'],
    queryFn: fetchAppRuntimeMonitor,
    refetchInterval: RESOURCE_MONITOR_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: RESOURCE_MONITOR_POLL_MS / 2,
  });

  const apps = monitor.data?.apps ?? [];
  const history = monitor.data?.history ?? [];
  const degradedApps = apps.filter((app) => app.degraded);
  const totalCpuPercent = apps.reduce((sum, app) => sum + app.cpuPercent, 0);
  const totalMemoryUsageBytes = apps.reduce((sum, app) => sum + app.memoryUsageBytes, 0);
  const totalContainerCount = apps.reduce((sum, app) => sum + app.containers.length, 0);
  const topCpuApp = apps[0] ?? null;
  const topMemoryApp = [...apps].sort((a, b) => b.memoryUsageBytes - a.memoryUsageBytes || a.appName.localeCompare(b.appName))[0] ?? null;
  const sampledAtLabel = monitor.data?.sampledAt ? formatSampleTime(monitor.data.sampledAt) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">{t('RESOURCE_MONITOR_TITLE')}</h1>
        <p className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_SUBTITLE')}</p>
        {sampledAtLabel ? <p className="text-xs text-muted-foreground">{t('RESOURCE_MONITOR_LAST_SAMPLED', { time: sampledAtLabel })}</p> : null}
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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('RESOURCE_MONITOR_TOTAL_WORKLOAD_CPU')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{totalCpuPercent.toFixed(1)}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('RESOURCE_MONITOR_TOTAL_WORKLOAD_MEMORY')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{formatBytes(totalMemoryUsageBytes)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('RESOURCE_MONITOR_TOP_CPU_WORKLOAD')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-semibold">{topCpuApp?.appName ?? '—'}</div>
            <div className="text-sm text-muted-foreground">{topCpuApp ? `${topCpuApp.cpuPercent.toFixed(1)}%` : '—'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('RESOURCE_MONITOR_ACTIVE_CONTAINERS')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-semibold">{totalContainerCount}</div>
            <div className="text-sm text-muted-foreground">
              {topMemoryApp ? `${topMemoryApp.appName} ${formatBytes(topMemoryApp.memoryUsageBytes)}` : '—'}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <CardTitle>{t('RESOURCE_MONITOR_CHART_TITLE')}</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_CHART_SUBTITLE')}</p>
        </CardHeader>
        <CardContent>
          <CpuUsageHistoryChart history={history.slice(-HISTORY_LIMIT)} apps={apps} />
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
          <div className="space-y-4 md:hidden">
            {apps.map((app) => (
              <div key={app.appUrn} className="rounded-md border border-border/60 bg-background/60 p-4">
                <div className="min-w-0">
                  <div className="font-medium">{app.appName}</div>
                  <div className="truncate text-xs text-muted-foreground">{app.appUrn}</div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('COMMON_STATUS')}</div>
                    <div className="mt-1">{app.status}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('COMMON_CPU')}</div>
                    <div className={app.highCpu ? 'mt-1 text-amber-600 font-medium' : 'mt-1'}>{app.cpuPercent.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('COMMON_MEMORY')}</div>
                    <div className="mt-1">
                      {formatBytes(app.memoryUsageBytes)}
                      {app.memoryLimitBytes > 0 ? <span className="text-muted-foreground"> / {formatBytes(app.memoryLimitBytes)}</span> : null}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('RESOURCE_MONITOR_CPU_CAP')}</div>
                    <div className="mt-1">{formatCpuLimitLabel(app.cpuLimit, app.usesDefaultCpuLimit)}</div>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('RESOURCE_MONITOR_RESPONSIVENESS')}</div>
                  <div className="mt-1">
                    <WorkloadResponsiveness app={app} />
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('RESOURCE_MONITOR_CONTAINER_BREAKDOWN')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('RESOURCE_MONITOR_ACTIVE_CONTAINERS')}: {app.containers.length}
                    </div>
                  </div>
                  {app.containers.length > 0 ? (
                    <div className="space-y-3">
                      {app.containers.map((container) => (
                        <div key={container.containerId} className="rounded-lg border border-border/60 bg-muted/20 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{container.name}</div>
                              <div className="text-xs text-muted-foreground">{container.status}</div>
                            </div>
                            <div className="text-right text-xs text-muted-foreground">
                              <div>{container.cpuPercent.toFixed(1)}%</div>
                              <div>{formatBytes(container.memoryUsageBytes)}</div>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span className="rounded-full border border-border/60 px-2 py-1">
                              {t('COMMON_STATUS')}: {container.state}
                            </span>
                            {container.health ? (
                              <span className="rounded-full border border-border/60 px-2 py-1">health: {container.health}</span>
                            ) : null}
                            {container.memoryLimitBytes > 0 ? (
                              <span className="rounded-full border border-border/60 px-2 py-1">
                                {t('COMMON_MEMORY')}: {formatBytes(container.memoryUsageBytes)} / {formatBytes(container.memoryLimitBytes)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_NO_CONTAINER_BREAKDOWN')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="hidden md:block">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-64">{t('COMMON_APP')}</TableHead>
                    <TableHead>{t('COMMON_STATUS')}</TableHead>
                    <TableHead>{t('COMMON_CPU')}</TableHead>
                    <TableHead>{t('COMMON_MEMORY')}</TableHead>
                    <TableHead>{t('RESOURCE_MONITOR_CPU_CAP')}</TableHead>
                    <TableHead className="min-w-56">{t('RESOURCE_MONITOR_RESPONSIVENESS')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apps.map((app) => (
                    <Fragment key={app.appUrn}>
                      <TableRow>
                        <TableCell className="align-top">
                          <div className="font-medium">{app.appName}</div>
                          <div className="text-xs text-muted-foreground">{app.appUrn}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t('RESOURCE_MONITOR_ACTIVE_CONTAINERS')}: {app.containers.length}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">{app.status}</TableCell>
                        <TableCell className={app.highCpu ? 'align-top text-amber-600 font-medium' : 'align-top'}>
                          {app.cpuPercent.toFixed(1)}%
                        </TableCell>
                        <TableCell className="align-top">
                          {formatBytes(app.memoryUsageBytes)}
                          {app.memoryLimitBytes > 0 ? <span className="text-muted-foreground"> / {formatBytes(app.memoryLimitBytes)}</span> : null}
                        </TableCell>
                        <TableCell className="align-top">{formatCpuLimitLabel(app.cpuLimit, app.usesDefaultCpuLimit)}</TableCell>
                        <TableCell className="align-top">
                          <WorkloadResponsiveness app={app} />
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/20">
                          <div className="space-y-3">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              {t('RESOURCE_MONITOR_CONTAINER_BREAKDOWN')}
                            </div>
                            {app.containers.length > 0 ? (
                              <div className="grid gap-3 lg:grid-cols-2">
                                {app.containers.map((container) => (
                                  <div key={container.containerId} className="rounded-lg border border-border/60 bg-background/80 p-3">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className="truncate font-medium">{container.name}</div>
                                        <div className="text-xs text-muted-foreground">{container.status}</div>
                                      </div>
                                      <div className="text-right text-xs text-muted-foreground">
                                        <div>{container.cpuPercent.toFixed(1)}%</div>
                                        <div>{formatBytes(container.memoryUsageBytes)}</div>
                                      </div>
                                    </div>
                                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                      <span className="rounded-full border border-border/60 px-2 py-1">
                                        {t('COMMON_STATUS')}: {container.state}
                                      </span>
                                      {container.health ? (
                                        <span className="rounded-full border border-border/60 px-2 py-1">health: {container.health}</span>
                                      ) : null}
                                      {container.memoryLimitBytes > 0 ? (
                                        <span className="rounded-full border border-border/60 px-2 py-1">
                                          {t('COMMON_MEMORY')}: {formatBytes(container.memoryUsageBytes)} / {formatBytes(container.memoryLimitBytes)}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">{t('RESOURCE_MONITOR_NO_CONTAINER_BREAKDOWN')}</div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
          {apps.length === 0 && !monitor.isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('RESOURCE_MONITOR_EMPTY')}</div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
