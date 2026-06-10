import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table/Table';
import { fetchAppRuntimeMonitor, formatCpuLimitLabel } from '@/lib/app-runtime-monitor';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export default function ResourceMonitorPage() {
  const { t } = useTranslation();
  const monitor = useQuery({
    queryKey: ['app-resource-monitor'],
    queryFn: fetchAppRuntimeMonitor,
    refetchInterval: 15_000,
  });

  const apps = monitor.data?.apps ?? [];
  const degradedApps = apps.filter((app) => app.degraded);

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
