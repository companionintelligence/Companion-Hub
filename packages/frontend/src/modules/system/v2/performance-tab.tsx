import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { parseHubTimestamp } from '@/components/ui/dense/dense';
import type { AppRuntimeMonitorSnapshot } from '@/lib/app-runtime-monitor';
import { BACKEND_DISPLAY_NAMES } from '@/lib/inference/backend-names';
import { cn } from '@/lib/utils';
import type { InferenceBackendType } from '@ci-hub/common/types';
import {
  type BackendResidencySummary,
  countedInModelMemory,
  gpuProcessOwner,
  type HardwareSummary,
  hostRamUsedMb,
  type InferenceBackendStatus,
  type MemoryBudgetSummary,
  type ResidencyReportSummary,
} from '@/modules/system/use-dashboard-data';
import { Bot, Cpu, HardDrive, type LucideIcon, MemoryStick, MonitorCog } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { asLegacyTranslate } from '@/lib/i18n/legacy-translate';
import { AreaChart } from './area-chart';
import { CardBody, CardFailed, type QueryState } from './card-state';
import { formatBytes, formatDuration, formatMb, formatPercent, meterTone, niceCeiling } from './format';
import { type DiskModel, TELEMETRY_SPANS, type TelemetryPoint, type TelemetrySpan } from './use-resources-data';

/*
 * Task Manager's Performance tab in the Hub's own cards: the machine's resources down the left, each
 * with the one figure that matters and Home's meter under it, and the selected one opened up on the
 * right. CPU history is the Hub's own host telemetry (`/api/system/telemetry`), averaged on the Hub
 * into at most 360 points for whatever span is picked.
 */

export interface SystemLoad {
  diskUsed: number;
  diskSize: number;
  percentUsed: number;
  cpuLoad: number;
  cpuCores: number;
  memoryTotal: number;
  memoryUsed: number;
  /** Where the Hub runs. In Docker Desktop's or WSL2's VM, the CPU figures are the VM's, not the computer's. */
  runtimeKind?: string;
}

type ResourceKey = 'cpu' | 'memory' | 'gpu' | 'disk' | 'models';

interface Tile {
  key: ResourceKey;
  icon: LucideIcon;
  name: string;
  value: string;
  detail: string;
  percent: number | null;
}

export const engineName = (type: string) => BACKEND_DISPLAY_NAMES[type as InferenceBackendType] ?? type;

function Meter({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-foreground/10', className)}>
      <div className={cn('h-full rounded-full', meterTone(percent))} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

function ResourceTile({ tile, selected, pending, onSelect }: { tile: Tile; selected: boolean; pending: boolean; onSelect: () => void }) {
  const Icon = tile.icon;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      data-testid={`resource-tile-${tile.key}`}
      className={cn(
        'w-full cursor-pointer rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary/60 bg-accent' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2.5">
        <Icon className="size-[18px] shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{tile.name}</span>
        <span className="shrink-0 text-base font-medium tabular-nums">{pending ? '…' : tile.value}</span>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{pending ? ' ' : tile.detail}</p>
      {tile.percent !== null && !pending ? <Meter percent={tile.percent} className="mt-2" /> : <div className="mt-2 h-1.5" aria-hidden="true" />}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Hero({ value, caption, aside }: { value: string; caption: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div>
        <p className="text-3xl font-medium leading-none tabular-nums">{value}</p>
        <p className="mt-1.5 text-sm text-muted-foreground">{caption}</p>
      </div>
      {aside ? <div className="text-sm text-muted-foreground">{aside}</div> : null}
    </div>
  );
}

function DetailCard({ title, subtitle, children }: { title: string; subtitle?: string | null; children: ReactNode }) {
  return (
    <Card className="min-w-0" data-testid="resource-detail">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <CardTitle>{title}</CardTitle>
          {subtitle ? <span className="text-sm text-muted-foreground">{subtitle}</span> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}

function clock(iso: string | undefined, span: TelemetrySpan) {
  if (!iso) return '';
  const date = new Date(iso);
  return span > 720
    ? date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The Hub stores whole percents every 5 seconds, which draws a quiet machine as a comb. Spans under
 * an hour arrive as 5- or 10-second points, so average each 30 seconds as Task Manager smooths its
 * own graph; the longer spans arrive already averaged.
 *
 * Slotted by TIME, not by position: the Hub serves only the buckets that hold a reading, so a stretch
 * it was down for is simply missing. Each empty slot between the first reading and the last is a
 * `null`, which the chart draws as a break rather than closing the gap or reading it as 0%.
 */
export function smoothCpu(points: TelemetryPoint[], bucketSeconds: number | null): (number | null)[] {
  const slotMs = Math.max(30, bucketSeconds ?? 0) * 1000;
  const slots = new Map<number, number[]>();
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const at = parseHubTimestamp(point.sampledAt);
    if (!Number.isFinite(at)) continue;
    const slot = Math.floor(at / slotMs);
    first = Math.min(first, slot);
    last = Math.max(last, slot);
    const values = slots.get(slot) ?? [];
    if (point.cpuLoad !== null && Number.isFinite(point.cpuLoad)) values.push(point.cpuLoad);
    slots.set(slot, values);
  }
  if (!Number.isFinite(first)) return [];
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const values = slots.get(first + index) ?? [];
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  });
}

export interface PerformanceTabProps {
  load: SystemLoad | undefined;
  loadState: QueryState;
  telemetry: TelemetryPoint[];
  telemetryState: QueryState;
  bucketSeconds: number | null;
  span: TelemetrySpan;
  onSpanChange: (span: TelemetrySpan) => void;
  hardware: HardwareSummary | undefined;
  hardwareState: QueryState;
  memory: MemoryBudgetSummary | undefined;
  /** `/inference/memory`: what models hold. Not answered is "unknown", never 0 MB. */
  budgetState: QueryState;
  residency: ResidencyReportSummary | undefined;
  residencyState: QueryState;
  modelsState: QueryState;
  engines: InferenceBackendStatus[] | undefined;
  diskModels: DiskModel[];
  monitor: AppRuntimeMonitorSnapshot | undefined;
  monitorState: QueryState;
  appName: (urn: string, fallback: string) => string;
  now: number;
  onShowApps: () => void;
}

export function PerformanceTab(props: PerformanceTabProps) {
  const { load, loadState, telemetry, telemetryState, bucketSeconds, span, onSpanChange, hardware, hardwareState, memory, budgetState, residency } =
    props;
  const { residencyState } = props;
  const { modelsState, engines, diskModels, monitor, monitorState, appName, now, onShowApps } = props;
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ResourceKey>('cpu');

  const apps = monitor?.apps ?? [];
  const cores = hardware?.cpu?.cores ?? load?.cpuCores ?? null;
  const vm = load?.runtimeKind === 'docker-desktop-vm' ? 'docker' : load?.runtimeKind === 'wsl2-vm' ? 'wsl' : null;

  // Total minus MemAvailable, as `free` and every Hub page since 0.3.11 count it.
  const ramTotalMb = hardware?.ram?.totalMb ?? (load ? load.memoryTotal * 1024 : null);
  const ramUsedMb = hostRamUsedMb(hardware) ?? (load ? load.memoryUsed * 1024 : null);
  const ramAvailableMb = ramTotalMb !== null && ramUsedMb !== null ? Math.max(0, ramTotalMb - ramUsedMb) : null;
  const ramPercent = ramTotalMb && ramUsedMb !== null ? (ramUsedMb / ramTotalMb) * 100 : null;
  const memoryState: QueryState = { pending: hardwareState.pending && loadState.pending, failed: hardwareState.failed && loadState.failed };
  const appsMemoryBytes = apps.reduce((sum, app) => sum + (app.memoryUsageBytes ?? 0), 0);

  const gpu = hardware?.gpu;
  const unified = gpu?.unifiedMemory === true;
  // `null` until `/inference/memory` answers: a failed or pending read must not show as 0 MB.
  const budgetKnown = !budgetState.pending && !budgetState.failed;
  const vramUsedMb = budgetKnown ? (memory?.modelUsedVramMb ?? 0) : null;
  const modelsMb = budgetKnown ? (memory?.modelUsedRamMb ?? 0) + (memory?.modelUsedVramMb ?? 0) : null;
  const vramTotalMb = unified ? null : memory?.totalVramMb || gpu?.vramMb || null;
  const vramPercent = vramTotalMb && vramUsedMb !== null ? (vramUsedMb / vramTotalMb) * 100 : null;

  const resident = (residency?.backends ?? []).flatMap((backend: BackendResidencySummary) =>
    (backend.models ?? []).map((model) => ({ ...model, backend: backend.backend })),
  );
  const running = (engines ?? []).filter((engine) => engine.running && engine.healthy !== false);
  const idleEngines = (engines ?? []).filter((engine) => !(engine.running && engine.healthy !== false));
  const modelBudgetMb = (memory?.modelBudgetRamMb ?? 0) + (memory?.modelBudgetVramMb ?? 0);
  // Every model on disk, and any model in memory the disk list did not name: an engine that cannot
  // list its files still reports what it holds.
  const modelRows: DiskModel[] = [
    ...diskModels,
    ...resident
      .filter((model) => !diskModels.some((disk) => disk.id === model.id && disk.backend === model.backend))
      .map((model) => ({ id: model.id, backend: model.backend, sizeBytes: null, resident: true })),
  ];

  const tiles: Tile[] = [
    {
      key: 'cpu',
      icon: Cpu,
      name: t('RESOURCES_CPU'),
      value: formatPercent(load?.cpuLoad),
      // In a VM the load is the VM's but the core count is the computer's, so the tile names the VM instead.
      detail:
        vm === 'docker'
          ? t('RESOURCES_CPU_IN_DOCKER_VM')
          : vm === 'wsl'
            ? t('RESOURCES_CPU_IN_WSL_VM')
            : cores
              ? t('RESOURCES_CORES', { count: cores })
              : '—',
      percent: load?.cpuLoad ?? null,
    },
    {
      key: 'memory',
      icon: MemoryStick,
      name: t('RESOURCES_MEMORY'),
      value: formatPercent(ramPercent),
      detail: ramTotalMb && ramUsedMb !== null ? t('RESOURCES_X_OF_Y', { used: formatMb(ramUsedMb), total: formatMb(ramTotalMb) }) : '—',
      percent: ramPercent,
    },
    ...(gpu?.available
      ? [
          {
            key: 'gpu' as const,
            icon: MonitorCog,
            name: t('RESOURCES_GPU'),
            value: unified ? formatMb(modelsMb) : formatPercent(vramPercent),
            detail: unified ? t('RESOURCES_GPU_SHARED') : t('RESOURCES_X_OF_Y', { used: formatMb(vramUsedMb), total: formatMb(vramTotalMb) }),
            percent: unified ? null : vramPercent,
          },
        ]
      : []),
    {
      key: 'disk',
      icon: HardDrive,
      name: t('RESOURCES_DISK'),
      value: load ? `${load.percentUsed}%` : '—',
      detail: load ? t('RESOURCES_X_OF_Y', { used: `${load.diskUsed.toLocaleString()} GB`, total: `${load.diskSize.toLocaleString()} GB` }) : '—',
      percent: load?.percentUsed ?? null,
    },
    {
      key: 'models',
      icon: Bot,
      name: t('RESOURCES_MODELS'),
      value: t('RESOURCES_X_OF_Y', { used: resident.length, total: modelRows.length }),
      detail: t('RESOURCES_MODELS_IN_MEMORY'),
      percent: modelBudgetMb > 0 && modelsMb !== null ? (modelsMb / modelBudgetMb) * 100 : null,
    },
  ];
  const tilePending: Record<ResourceKey, boolean> = {
    cpu: loadState.pending,
    memory: memoryState.pending,
    gpu: hardwareState.pending || budgetState.pending,
    disk: loadState.pending,
    models: modelsState.pending,
  };

  const active = tiles.some((tile) => tile.key === selected) ? selected : 'cpu';

  const cpuSeries = smoothCpu(telemetry, bucketSeconds);
  const cpuPeak = Math.max(0, ...cpuSeries.filter((value): value is number => value !== null));
  const busiest = [...apps].sort((a, b) => b.cpuPercent - a.cpuPercent)[0];

  // Unknown when `/inference/memory` has not answered; "Everything else" then holds the models too.
  const modelsInRamMb = budgetKnown ? (memory?.modelUsedRamMb ?? 0) + (unified ? (memory?.modelUsedVramMb ?? 0) : 0) : null;
  const appsMb = appsMemoryBytes / (1024 * 1024);
  const otherMb = ramUsedMb === null ? 0 : Math.max(0, ramUsedMb - appsMb - (modelsInRamMb ?? 0));
  const composition: { key: string; label: string; mb: number | null; className: string }[] = [
    { key: 'apps', label: t('RESOURCES_MEMORY_APPS'), mb: appsMb, className: 'bg-chart-2' },
    { key: 'models', label: t('RESOURCES_MODELS'), mb: modelsInRamMb, className: 'bg-chart-1' },
    // Not "System": it also holds whatever apps this person can't see, and on a machine whose GPU
    // shares memory, what the GPU holds outside the models.
    { key: 'other', label: t('RESOURCES_MEMORY_OTHER'), mb: otherMb, className: 'bg-muted-foreground/45' },
    { key: 'free', label: t('RESOURCES_MEMORY_AVAILABLE'), mb: ramAvailableMb ?? 0, className: 'bg-foreground/10' },
  ];
  // The parts can add up past the RAM Linux sees, when models sit in a BIOS carve-out the host does
  // not count (core-1). Scaled to their sum then, so "Available" is not cut off the end of the bar.
  const compositionTotal = Math.max(
    ramTotalMb ?? 0,
    composition.reduce((sum, part) => sum + (part.mb ?? 0), 0),
  );
  const unattributedGpu = (monitor?.unattributedGpu ?? []).filter(
    (process) => !countedInModelMemory(gpuProcessOwner(process.processName, memory?.usage?.backends)),
  );
  const topMemory = [...apps].sort((a, b) => b.memoryUsageBytes - a.memoryUsageBytes).slice(0, 5);
  const topMemoryMax = Math.max(1, ...topMemory.map((app) => app.memoryUsageBytes));
  const os = [hardware?.os?.name, hardware?.os?.version].filter(Boolean).join(' ') || hardware?.os?.platform;

  const spanLabel = (value: TelemetrySpan) => t(`RESOURCES_SPAN_${value}`);

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="grid grid-cols-2 content-start gap-2 sm:grid-cols-3 md:grid-cols-1">
        {tiles.map((tile) => (
          <ResourceTile
            key={tile.key}
            tile={tile}
            selected={tile.key === active}
            pending={tilePending[tile.key]}
            onSelect={() => setSelected(tile.key)}
          />
        ))}
      </div>

      {active === 'cpu' ? (
        <DetailCard title={t('RESOURCES_CPU')} subtitle={hardware?.cpu?.model}>
          {/* The range picker sits outside the load's CardBody: it drives the telemetry graph, which
              still works when `/system/load` does not. */}
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0 flex-1">
              <CardBody state={loadState} error={t('RESOURCES_LOAD_FAILED')}>
                <Hero value={formatPercent(load?.cpuLoad)} caption={t('RESOURCES_IN_USE_NOW')} />
              </CardBody>
            </div>
            <Select value={String(span)} onValueChange={(value) => onSpanChange(Number(value) as TelemetrySpan)}>
              <SelectTrigger className="w-40" aria-label={t('RESOURCES_SPAN_LABEL')} data-testid="resources-span">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TELEMETRY_SPANS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {spanLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {vm && !loadState.failed ? <p className="text-sm text-muted-foreground">{t('RESOURCES_CPU_VM_NOTE')}</p> : null}
          <CardBody state={telemetryState} error={t('RESOURCES_TELEMETRY_FAILED')} lines={4}>
            {cpuSeries.length > 1 ? (
              <AreaChart
                label={t('RESOURCES_CPU_CHART', { span: spanLabel(span) })}
                series={[{ key: 'cpu', label: t('RESOURCES_CPU'), colorClass: 'text-chart-1', values: cpuSeries }]}
                max={Math.min(100, niceCeiling(cpuPeak, 10))}
                unit="%"
                start={clock(telemetry[0]?.sampledAt, span)}
                end={t('RESOURCES_NOW')}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('RESOURCES_CPU_CHART_EMPTY')}</p>
            )}
          </CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            <Stat
              label={t('RESOURCES_PEAK', { span: spanLabel(span) })}
              value={cpuSeries.length > 1 && !telemetryState.failed ? formatPercent(cpuPeak) : '—'}
            />
            <Stat
              label={vm ? t('RESOURCES_HOST_CORES_LABEL') : t('RESOURCES_CORES_LABEL')}
              value={cores ? [cores, hardware?.cpu?.arch].filter(Boolean).join(' · ') : '—'}
            />
            <Stat
              label={t('RESOURCES_BUSIEST_APP')}
              value={busiest ? `${formatPercent(cores ? busiest.cpuPercent / cores : null)} ${appName(busiest.appUrn, busiest.appName)}` : '—'}
            />
            <Stat label={t('RESOURCES_OS')} value={os || '—'} />
          </dl>
        </DetailCard>
      ) : null}

      {active === 'memory' ? (
        <DetailCard title={t('RESOURCES_MEMORY')} subtitle={ramTotalMb ? t('RESOURCES_INSTALLED', { size: formatMb(ramTotalMb) }) : null}>
          <CardBody state={memoryState} error={t('RESOURCES_LOAD_FAILED')} lines={4}>
            <Hero value={formatPercent(ramPercent)} caption={t('RESOURCES_IN_USE_NOW')} />
            <div className="space-y-3">
              <div className="flex h-7 w-full overflow-hidden rounded-md" role="img" aria-label={t('RESOURCES_MEMORY_SPLIT')}>
                {composition.map((part) =>
                  compositionTotal > 0 && part.mb !== null && part.mb > 0 ? (
                    <div key={part.key} className={part.className} style={{ width: `${(part.mb / compositionTotal) * 100}%` }} />
                  ) : null,
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
                {composition.map((part) => (
                  <div key={part.key} className="min-w-0">
                    <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn('size-2.5 shrink-0 rounded-sm', part.className)} aria-hidden="true" />
                      {part.label}
                    </dt>
                    <dd className="text-base font-medium tabular-nums">{formatMb(part.mb)}</dd>
                  </div>
                ))}
              </dl>
              {unified ? <p className="text-sm text-muted-foreground">{t('RESOURCES_MEMORY_SHARED_NOTE')}</p> : null}
            </div>
          </CardBody>
          {monitorState.failed ? <CardFailed>{t('RESOURCES_APPS_FAILED')}</CardFailed> : null}
          {topMemory.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h4 className="text-sm font-medium">{t('RESOURCES_MEMORY_TOP_APPS')}</h4>
                <button type="button" onClick={onShowApps} className="cursor-pointer text-sm text-primary underline-offset-4 hover:underline">
                  {t('RESOURCES_ALL_APPS')}
                </button>
              </div>
              <ul className="space-y-1.5">
                {topMemory.map((app) => (
                  <li key={app.appUrn} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                    <span className="truncate">{appName(app.appUrn, app.appName)}</span>
                    <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                      <div className="h-full rounded-full bg-chart-2" style={{ width: `${(app.memoryUsageBytes / topMemoryMax) * 100}%` }} />
                    </div>
                    <span className="w-16 text-right tabular-nums text-muted-foreground">{formatBytes(app.memoryUsageBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DetailCard>
      ) : null}

      {active === 'gpu' && gpu ? (
        <DetailCard title={t('RESOURCES_GPU')} subtitle={gpu.model}>
          <CardBody state={budgetState} error={t('RESOURCES_MODELS_FAILED')}>
            {unified ? (
              <Hero
                value={formatMb(modelsMb)}
                caption={t('RESOURCES_GPU_HELD_BY_MODELS')}
                aside={ramTotalMb ? t('RESOURCES_GPU_SHARES', { size: formatMb(ramTotalMb) }) : null}
              />
            ) : (
              <>
                <Hero
                  value={formatPercent(vramPercent)}
                  caption={t('RESOURCES_GPU_VRAM_IN_USE')}
                  aside={t('RESOURCES_X_OF_Y', { used: formatMb(vramUsedMb), total: formatMb(vramTotalMb) })}
                />
                {vramPercent === null ? null : <Meter percent={vramPercent} className="h-2.5" />}
              </>
            )}
          </CardBody>
          <CardBody state={residencyState} error={t('RESOURCES_MODELS_FAILED')}>
            <ModelsInMemory models={resident} now={now} />
          </CardBody>
          {/* Not the engines' own runners: those are the models listed above, already counted. */}
          {unattributedGpu.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('RESOURCES_GPU_OUTSIDE_APPS', {
                list: unattributedGpu.map((process) => `${process.processName.split('/').pop()} (${formatMb(process.vramMb)})`).join(', '),
              })}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            <Stat label={t('RESOURCES_GPU_MEMORY_TYPE')} value={unified ? t('RESOURCES_GPU_MEMORY_SHARED') : formatMb(vramTotalMb)} />
            {gpu.vendor === 'amd' ? (
              <Stat label={t('RESOURCES_GPU_ROCM')} value={gpu.hostRocmAvailable ? t('RESOURCES_READY') : t('RESOURCES_NOT_FOUND')} />
            ) : null}
            <Stat label={t('RESOURCES_GPU_IN_HUB')} value={gpu.runtimeAvailable ? t('RESOURCES_YES') : t('RESOURCES_NO')} />
            <Stat label={t('RESOURCES_NPU')} value={hardware?.npu?.available ? (hardware.npu.model ?? t('RESOURCES_YES')) : t('RESOURCES_NONE')} />
          </dl>
        </DetailCard>
      ) : null}

      {active === 'disk' ? (
        <DetailCard title={t('RESOURCES_DISK')} subtitle={load ? `${load.diskSize.toLocaleString()} GB` : null}>
          <CardBody state={loadState} error={t('RESOURCES_LOAD_FAILED')}>
            <Hero
              value={load ? `${load.percentUsed}%` : '—'}
              caption={t('RESOURCES_USED')}
              aside={load ? t('RESOURCES_FREE', { size: `${(load.diskSize - load.diskUsed).toLocaleString()} GB` }) : null}
            />
            {load ? <Meter percent={load.percentUsed} className="h-2.5" /> : null}
            <dl className="grid grid-cols-3 gap-x-6 gap-y-4">
              <Stat label={t('RESOURCES_USED_LABEL')} value={load ? `${load.diskUsed.toLocaleString()} GB` : '—'} />
              <Stat label={t('RESOURCES_FREE_LABEL')} value={load ? `${(load.diskSize - load.diskUsed).toLocaleString()} GB` : '—'} />
              <Stat label={t('RESOURCES_TOTAL_LABEL')} value={load ? `${load.diskSize.toLocaleString()} GB` : '—'} />
            </dl>
          </CardBody>
        </DetailCard>
      ) : null}

      {active === 'models' ? (
        <DetailCard title={t('RESOURCES_MODELS')} subtitle={running.map((engine) => engineName(engine.type)).join(', ') || t('RESOURCES_NO_ENGINE')}>
          <CardBody state={modelsState} error={t('RESOURCES_MODELS_FAILED')} lines={5}>
            <Hero
              value={t('RESOURCES_X_OF_Y', { used: resident.length, total: modelRows.length })}
              caption={t('RESOURCES_MODELS_IN_MEMORY')}
              aside={
                modelBudgetMb > 0 && modelsMb !== null
                  ? t('RESOURCES_MODELS_BUDGET', { used: formatMb(modelsMb), total: formatMb(modelBudgetMb) })
                  : null
              }
            />
            {modelRows.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                {t('RESOURCES_MODELS_EMPTY')}
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-10 px-4">{t('RESOURCES_MODEL')}</TableHead>
                      <TableHead className="hidden h-10 px-4 sm:table-cell">{t('RESOURCES_ENGINE')}</TableHead>
                      <TableHead className="h-10 px-4 text-right">{t('RESOURCES_ON_DISK')}</TableHead>
                      <TableHead className="h-10 px-4 text-right">{t('RESOURCES_IN_MEMORY')}</TableHead>
                      <TableHead className="hidden h-10 px-4 text-right md:table-cell">{t('RESOURCES_UNLOADS')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.map((model) => {
                      const inMemory = resident.find((entry) => entry.id === model.id && entry.backend === model.backend);
                      const until = inMemory?.expiresAt ? parseHubTimestamp(inMemory.expiresAt) - now : null;
                      return (
                        <TableRow key={`${model.backend}:${model.id}`} data-testid="resources-model-row">
                          <TableCell className="max-w-[14rem] truncate px-4 py-2.5 font-medium">{model.id}</TableCell>
                          <TableCell className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">{engineName(model.backend)}</TableCell>
                          <TableCell className="px-4 py-2.5 text-right tabular-nums">{formatBytes(model.sizeBytes)}</TableCell>
                          <TableCell className={cn('px-4 py-2.5 text-right tabular-nums', !inMemory && 'text-muted-foreground')}>
                            {inMemory ? formatBytes(inMemory.totalBytes) : '—'}
                          </TableCell>
                          <TableCell className="hidden px-4 py-2.5 text-right text-muted-foreground md:table-cell">
                            {inMemory ? unloadWords(until, asLegacyTranslate(t), 'RESOURCES_IN_TIME') : ''}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {idleEngines.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('RESOURCES_ENGINES_NOT_RUNNING', { list: idleEngines.map((engine) => engineName(engine.type)).join(', ') })}
              </p>
            ) : null}
          </CardBody>
        </DetailCard>
      ) : null}
    </div>
  );
}

/**
 * When a model in memory unloads. No expiry is "stays loaded"; an expiry already past is not: the
 * engine evicts it on its next sweep.
 */
function unloadWords(untilMs: number | null, t: (key: string, vars?: Record<string, unknown>) => string, inKey: string): string {
  if (untilMs === null || Number.isNaN(untilMs)) return t('RESOURCES_STAYS_LOADED');
  return untilMs > 0 ? t(inKey, { time: formatDuration(untilMs) }) : t('RESOURCES_UNLOADING');
}

function ModelsInMemory({
  models,
  now,
}: {
  models: { id: string; backend: string; totalBytes: number | null; expiresAt: string | null }[];
  now: number;
}) {
  const { t } = useTranslation();
  if (models.length === 0) return <p className="text-sm text-muted-foreground">{t('RESOURCES_NO_MODEL_IN_MEMORY')}</p>;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('RESOURCES_MODELS_IN_MEMORY_TITLE')}</h4>
      <ul className="divide-y divide-border rounded-md border border-border">
        {models.map((model) => {
          const until = model.expiresAt ? parseHubTimestamp(model.expiresAt) - now : null;
          return (
            <li key={`${model.backend}:${model.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{model.id}</span>
              <span className="text-muted-foreground">{engineName(model.backend)}</span>
              <span className="tabular-nums">{formatBytes(model.totalBytes)}</span>
              <span className="w-36 text-right text-muted-foreground">{unloadWords(until, asLegacyTranslate(t), 'RESOURCES_UNLOADS_IN')}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
