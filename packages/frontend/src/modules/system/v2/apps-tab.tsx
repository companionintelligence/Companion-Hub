import { AppLogo } from '@/components/app-logo/app-logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Sparkline } from '@/components/ui/dense/dense';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CardBody, type QueryState } from './card-state';
import { formatBytes, formatMb, formatPercent } from './format';

/*
 * Task Manager's Processes tab: every app in one table, a total over each column, cells shaded by
 * how much of the WHOLE MACHINE the app uses (so an idle Hub reads as a calm table, and only real
 * load lights up), a sparkline of the last 24 minutes beside each figure, and each row opening onto
 * its containers. CPU is a share of all the machine's cores, as the CPU figure on Performance is.
 *
 * The rows are what `/apps/resource-monitor` returns for this session, which the Hub filters to the
 * apps the person may view, so a member sees the same apps here as on Home.
 */

type SortKey = 'name' | 'cpu' | 'memory';

/** `ci-memory_ci-marketplace-api-1` is the `api` service of `ci-memory:ci-marketplace`. */
export function serviceName(appUrn: string, container: string): string {
  const [app, store] = appUrn.split(':');
  const prefix = `${app}_${store}-`;
  const name = container.startsWith(prefix) ? container.slice(prefix.length) : container;
  return name.replace(/-1$/, '');
}

/** A one-shot container that ran to completion (a migration, a setup step) is not part of what is running. */
const isFinished = (container: { state: string; exitCode?: number | null }) => container.state === 'exited' && container.exitCode === 0;
export const liveContainers = (app: AppRuntimeHealth) => app.containers.filter((container) => !isFinished(container));

/** How strongly a cell is shaded for a share of the whole machine, in percent. */
export function shade(share: number): string | undefined {
  if (!Number.isFinite(share) || share < 1) return undefined;
  if (share >= 60) return 'color-mix(in srgb, var(--warning) 26%, transparent)';
  const strength = share < 5 ? 7 : share < 15 ? 13 : share < 35 ? 20 : 28;
  return `color-mix(in srgb, var(--primary) ${strength}%, transparent)`;
}

function statusOf(app: AppRuntimeHealth, t: (key: string) => string): { label: string; dot: string } {
  if (app.degraded) return { label: t('RESOURCES_APP_NOT_RESPONDING'), dot: 'bg-warning' };
  if (app.status === 'running') return { label: t('RESOURCES_APP_RUNNING'), dot: 'bg-success' };
  if (app.status === 'stopped' || app.status === 'exited') return { label: t('RESOURCES_APP_STOPPED'), dot: 'bg-muted-foreground' };
  return { label: app.status.charAt(0).toUpperCase() + app.status.slice(1), dot: 'bg-muted-foreground' };
}

function SortHead({
  label,
  total,
  sortKey,
  sort,
  onSort,
  hint,
  className,
}: {
  label: string;
  total?: ReactNode;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  hint?: ReactNode;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.desc ? ArrowDown : ArrowUp;
  return (
    <TableHead
      className={cn('h-auto w-px whitespace-nowrap px-3 py-3 align-bottom sm:px-4', className)}
      aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <span className="inline-flex flex-col items-end gap-0.5">
        {total === undefined ? null : <span className="text-base font-medium text-foreground tabular-nums">{total}</span>}
        <span className="inline-flex items-center">
          <button type="button" onClick={() => onSort(sortKey)} className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground">
            {label}
            {active ? <Arrow className="size-3.5" aria-hidden="true" /> : null}
          </button>
          {hint}
        </span>
      </span>
    </TableHead>
  );
}

export function AppsTab({
  apps,
  history,
  state,
  cores,
  ramTotalMb,
  appName,
}: {
  apps: AppRuntimeHealth[];
  history: AppRuntimeHistorySample[];
  state: QueryState;
  cores: number | null;
  ramTotalMb: number | null;
  appName: (urn: string, fallback: string) => string;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'memory', desc: true });
  const [open, setOpen] = useState<string[]>([]);

  const cpuShare = (cpuPercent: number) => (cores ? cpuPercent / cores : cpuPercent);
  const memShare = (bytes: number) => (ramTotalMb ? (bytes / (ramTotalMb * 1024 * 1024)) * 100 : 0);
  const showGpu = apps.some((app) => app.gpuVramMb !== null);
  const nameOf = (app: AppRuntimeHealth) => appName(app.appUrn, app.appName);
  const trend = (urn: string, pick: (point: AppRuntimeHistorySample['apps'][number]) => number | null) =>
    history.map((sample) => {
      const point = sample.apps.find((entry) => entry.appUrn === urn);
      return point ? pick(point) : null;
    });

  const sorted = [...apps].sort((a, b) => {
    const order =
      sort.key === 'name'
        ? nameOf(a).localeCompare(nameOf(b))
        : sort.key === 'cpu'
          ? a.cpuPercent - b.cpuPercent
          : a.memoryUsageBytes - b.memoryUsageBytes;
    return sort.desc ? -order : order;
  });
  const onSort = (key: SortKey) => setSort((current) => ({ key, desc: current.key === key ? !current.desc : key !== 'name' }));
  const toggle = (urn: string) => setOpen((current) => (current.includes(urn) ? current.filter((u) => u !== urn) : [...current, urn]));

  const totalCpu = apps.reduce((sum, app) => sum + cpuShare(app.cpuPercent), 0);
  const totalMemory = apps.reduce((sum, app) => sum + app.memoryUsageBytes, 0);
  const totalContainers = apps.reduce((sum, app) => sum + liveContainers(app).length, 0);
  const totalGpu = apps.reduce((sum, app) => sum + (app.gpuVramMb ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('RESOURCES_APPS')}</CardTitle>
        {!state.pending && !state.failed ? (
          <CardDescription>
            {apps.length === 0 ? t('RESOURCES_APPS_EMPTY') : t('RESOURCES_APPS_SUMMARY', { count: apps.length, containers: totalContainers })}
          </CardDescription>
        ) : null}
      </CardHeader>
      {state.pending || state.failed ? (
        <CardContent>
          <CardBody state={state} error={t('RESOURCES_APPS_FAILED')} lines={5}>
            {null}
          </CardBody>
        </CardContent>
      ) : apps.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-auto w-full py-3 pr-2 pl-4 align-bottom sm:pl-6">
                <button type="button" onClick={() => onSort('name')} className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground">
                  {t('RESOURCES_NAME')}
                  {sort.key === 'name' ? sort.desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" /> : null}
                </button>
              </TableHead>
              <TableHead className="hidden h-auto w-px whitespace-nowrap py-3 align-bottom lg:table-cell">{t('RESOURCES_STATUS')}</TableHead>
              <SortHead
                label={t('RESOURCES_CPU')}
                total={formatPercent(totalCpu)}
                sortKey="cpu"
                sort={sort}
                onSort={onSort}
                className="text-right"
                hint={
                  <HintMarker
                    anchorClass="resources-apps-cpu-hint"
                    hint={cores ? t('RESOURCES_APPS_CPU_HINT', { count: cores }) : t('RESOURCES_APPS_CPU_HINT_NO_CORES')}
                  />
                }
              />
              <SortHead
                label={t('RESOURCES_MEMORY')}
                total={formatBytes(totalMemory)}
                sortKey="memory"
                sort={sort}
                onSort={onSort}
                className="pr-4 text-right sm:pr-6 md:pr-4"
              />
              {showGpu ? (
                <TableHead className="hidden h-auto py-3 text-right align-bottom md:table-cell">
                  <span className="block text-base font-medium text-foreground tabular-nums">{formatMb(totalGpu)}</span>
                  {t('RESOURCES_GPU_MEMORY')}
                </TableHead>
              ) : null}
              <TableHead className="hidden h-auto py-3 pr-6 text-right align-bottom md:table-cell">
                <span className="block text-base font-medium text-foreground tabular-nums">{totalContainers}</span>
                {t('RESOURCES_CONTAINERS')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((app) => {
              const expanded = open.includes(app.appUrn);
              const status = statusOf(app, t);
              const finished = app.containers.length - liveContainers(app).length;
              const name = nameOf(app);
              return (
                <Fragment key={app.appUrn}>
                  <TableRow className="cursor-pointer" onClick={() => toggle(app.appUrn)} data-testid="resources-app-row">
                    <TableCell className="w-full max-w-0 py-2.5 pr-2 pl-4 sm:pl-6">
                      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={t(expanded ? 'RESOURCES_HIDE_CONTAINERS' : 'RESOURCES_SHOW_CONTAINERS', { name })}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(app.appUrn);
                          }}
                          className="-ml-2 shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className={cn('size-4 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                        </button>
                        <AppLogo
                          urn={app.appUrn}
                          url={app.appUrn.endsWith(':system') ? '/logo.svg' : undefined}
                          name={name}
                          alt=""
                          size={28}
                          shape="rounded"
                          className="shrink-0"
                        />
                        <span className="min-w-0 truncate font-medium">{name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden py-2.5 lg:table-cell">
                      <span className="inline-flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                        <span className={cn('size-2 rounded-full', status.dot)} aria-hidden="true" />
                        {status.label}
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5 text-right tabular-nums sm:px-4" style={{ backgroundColor: shade(cpuShare(app.cpuPercent)) }}>
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <Sparkline
                          points={trend(app.appUrn, (point) => point.cpuPercent)}
                          width={48}
                          height={14}
                          className="hidden md:inline-block"
                        />
                        {formatPercent(cpuShare(app.cpuPercent))}
                      </span>
                    </TableCell>
                    <TableCell
                      className="py-2.5 pr-4 pl-3 text-right tabular-nums sm:pr-6 md:pr-4"
                      style={{ backgroundColor: shade(memShare(app.memoryUsageBytes)) }}
                    >
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <Sparkline
                          points={trend(app.appUrn, (point) => point.memoryUsageBytes)}
                          width={48}
                          height={14}
                          className="hidden md:inline-block"
                        />
                        {formatBytes(app.memoryUsageBytes)}
                      </span>
                    </TableCell>
                    {showGpu ? (
                      <TableCell className="hidden py-2.5 text-right tabular-nums md:table-cell">{formatMb(app.gpuVramMb)}</TableCell>
                    ) : null}
                    <TableCell className="hidden py-2.5 pr-6 text-right tabular-nums md:table-cell">{liveContainers(app).length}</TableCell>
                  </TableRow>
                  {expanded
                    ? liveContainers(app).map((container) => (
                        <TableRow key={container.containerId} className="bg-muted/30 text-muted-foreground hover:bg-muted/40">
                          <TableCell className="w-full max-w-0 truncate py-2 pr-2 pl-12 sm:pl-[5.25rem]">
                            {serviceName(app.appUrn, container.name)}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap py-2 lg:table-cell">{container.status}</TableCell>
                          <TableCell className="px-3 py-2 text-right tabular-nums sm:px-4">{formatPercent(cpuShare(container.cpuPercent))}</TableCell>
                          <TableCell className="py-2 pr-4 pl-3 text-right tabular-nums sm:pr-6 md:pr-4">
                            {formatBytes(container.memoryUsageBytes)}
                          </TableCell>
                          {showGpu ? <TableCell className="hidden md:table-cell" /> : null}
                          <TableCell className="hidden pr-6 md:table-cell" />
                        </TableRow>
                      ))
                    : null}
                  {expanded && finished > 0 ? (
                    <TableRow className="bg-muted/30 text-muted-foreground hover:bg-muted/40">
                      <TableCell colSpan={6} className="py-2 pl-12 text-sm sm:pl-[5.25rem]">
                        {t('RESOURCES_FINISHED_CONTAINERS', { count: finished })}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </Card>
  );
}
