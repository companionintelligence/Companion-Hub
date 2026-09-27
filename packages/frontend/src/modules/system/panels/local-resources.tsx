import {
  DASH,
  humanBytes,
  KpiTable,
  MeterBar,
  Panel,
  PanelBody,
  relativeUntil,
  Sparkline,
  StackedBar,
  StatChip,
  StatChipRow,
  StatusDot,
  TableEmpty,
  Td,
  Th,
  Tr,
} from '@/components/ui/dense/dense';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import type { NodeContainers } from '@/modules/system/pool-node-series';
import { sampleTimeline } from '@/modules/system/resource-monitor-chart';
import {
  budgetPercent,
  type HardwareSummary,
  hostRamUsedMb,
  type InferenceBackendStatus,
  type LoadState,
  memoryBudgetRows,
  type MemoryBudgetSummary,
  type MemoryReconciliation,
  type ModelMemoryUsageEntrySummary,
  type PoolNodeSummary,
  type ResidencyReportSummary,
  type ResidentModelSummary,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * LOCAL RESOURCES — what this machine itself is running.
 *
 * Four panels: the host's own capacity, the AI models it HOLDS, how much memory those
 * models are allowed and holding, and the containerised workloads. Every number here is
 * measured on this node, so the whole section renders on an unpaired Hub.
 *
 * "Holds", not "resident". The pool status field is called `modelsLoaded` but it is the
 * engine's ON-DISK inventory: measured on beta-max it listed 11 models while the engine's
 * own `/api/ps` reported zero in memory. On-disk is the right basis for "can this node
 * serve that model", but it is not residency — which is why residency is its own column,
 * read from `/inference/models/resident`, and never inferred from this list.
 *
 * Each panel takes its own `state` and wraps its body in `PanelBody`, so a failed fetch
 * shows as a failed fetch rather than as a zero.
 */

const BACKEND_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

/*
 * No "In flight" chip here any more. It was the pool's local in-flight counter — the same number as
 * the rail's "Serving" and the local node row's "Now", so it was on screen three times — and it sat in
 * a panel gated on the HARDWARE query, so a failed hardware fetch blanked a pool figure it had nothing
 * to do with.
 */
export function HostCapacity({ hardware, state, className }: { hardware: HardwareSummary | undefined; state: LoadState; className?: string }) {
  const { t } = useTranslation();
  const ramTotal = hardware?.ram?.totalMb ?? null;
  const ramUsed = hostRamUsedMb(hardware);

  return (
    <Panel title={t('DASHBOARD_HOST_TITLE')} density="compact" className={className}>
      <PanelBody state={state} error={t('DASHBOARD_HARDWARE_FAILED')}>
        <StatChipRow>
          <StatChip
            value={hardware?.cpu?.cores ?? DASH}
            label={t('DASHBOARD_CORES')}
            sub={hardware?.cpu?.arch}
            tone={hardware?.cpu?.cores ? 'plain' : 'muted'}
          />
          <StatChip
            value={ramTotal === null ? DASH : `${Math.round(ramTotal / 1024)}G`}
            label={t('DASHBOARD_RAM')}
            sub={ramUsed !== null && ramTotal ? t('DASHBOARD_PERCENT_USED', { percent: Math.round((ramUsed / ramTotal) * 100) }) : undefined}
            tone={ramUsed !== null && ramTotal && ramUsed / ramTotal > 0.9 ? 'warn' : 'plain'}
          />
          {/* A unified-memory machine has no separate VRAM pool to report, so it gets a
              label rather than a number that would read as a dedicated card's — and never
              `vramMb`, which on these machines is HOST RAM (core-1: "31G" beside a 96 GiB
              BIOS carve-out the host cannot see). */}
          <StatChip
            value={
              hardware?.gpu?.unifiedMemory ? t('DASHBOARD_UNIFIED') : hardware?.gpu?.vramMb ? `${Math.round(hardware.gpu.vramMb / 1024)}G` : DASH
            }
            label={t('DASHBOARD_VRAM')}
            sub={hardware?.gpu?.model}
            tone={hardware?.gpu?.available ? 'ok' : 'muted'}
          />
          <StatChip value={hardware?.tier ?? DASH} label={t('DASHBOARD_TIER')} tone="muted" />
        </StatChipRow>
        {ramTotal !== null && ramUsed !== null ? (
          <div className="space-y-1 pt-1">
            <MeterBar value={ramUsed} max={ramTotal} tone={ramUsed / ramTotal > 0.9 ? 'warn' : 'ok'} />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>{t('DASHBOARD_RAM_USED', { used: `${Math.round(ramUsed / 1024)}G`, total: `${Math.round(ramTotal / 1024)}G` })}</span>
            </div>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** MB as the short gigabyte figure the bars use. One decimal below 10G so a 1.5G model is not "2G". */
function gigs(mb: number): string {
  const value = mb / 1024;
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}G`;
}

/**
 * The words beside each engine's figure, saying how it was established — the point of the row.
 * A per-process reading names the tool, since that is what an operator will run to check it.
 */
function usageSourceLabel(entry: ModelMemoryUsageEntrySummary, vendor: string | undefined, t: (key: string) => string): string {
  switch (entry.source) {
    case 'engine':
      return t('DASHBOARD_MEMORY_SOURCE_ENGINE');
    case 'process':
      return vendor === 'nvidia' ? 'nvidia-smi' : vendor === 'amd' ? 'rocm-smi' : t('DASHBOARD_MEMORY_SOURCE_PROCESS');
    case 'registry':
      return t('DASHBOARD_MEMORY_SOURCE_REGISTRY');
    default:
      return t('DASHBOARD_MEMORY_SOURCE_UNMEASURED');
  }
}

/**
 * How much memory models may use, and how much they hold.
 *
 * Three numbers per pool, and they are not interchangeable: `total` is the hardware,
 * `budget` is what the router will let models take out of it, and `used` is what they have.
 * A machine can be far from full and still refuse to load a model because the budget is
 * spent — which is unexplainable from a single "memory used" figure, and is the reason
 * this panel exists.
 *
 * `used` is what every engine on the node holds NOW, and each engine's line says how that
 * was learned: its process as the vendor tool sees it, else the engine's own accounting, or —
 * only when the engine could not be asked — the Hub's bookkeeping of what it loaded there.
 * An engine holding a model nothing can size is listed without a figure and the pool's
 * used reads as a floor (`≥`), because the remainder is not known to be free. Measured on
 * beta-red before this: 0 of 10G on screen, 9 of 10G in nvidia-smi.
 */
export function ModelMemory({
  memory,
  hardware,
  reconciliation,
  state,
  className,
}: {
  memory: MemoryBudgetSummary | undefined;
  hardware: HardwareSummary | undefined;
  /** From `memoryReconciliation`, computed at page level where the container rollup lives. */
  reconciliation?: MemoryReconciliation | null;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const rows = memoryBudgetRows(memory);
  const unified = hardware?.gpu?.unifiedMemory === true;
  const vendor = hardware?.gpu?.vendor;
  const unmeasured = rows.flatMap((row) => row.engines.filter((entry) => entry.source === 'unmeasured').map((entry) => entry.backend));

  return (
    <Panel title={t('DASHBOARD_MODEL_MEMORY_TITLE')} density="compact" className={className}>
      <PanelBody state={state} error={t('DASHBOARD_MEMORY_FAILED')}>
        {rows.length === 0 ? (
          <p className="py-2.5 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_MODEL_MEMORY_EMPTY')}</p>
        ) : (
          <div className="space-y-2.5">
            {rows.map((row) => {
              const percent = budgetPercent(row.used, row.budget);

              return (
                <div key={row.kind} className="space-y-1" data-testid={`model-memory-${row.kind}`}>
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="font-medium uppercase tracking-[0.5px]">{row.kind === 'vram' ? t('DASHBOARD_VRAM') : t('DASHBOARD_RAM')}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t('DASHBOARD_MEMORY_OF_BUDGET', {
                        // A floor is written as one: an engine in this pool holds a model nobody could size.
                        used: `${row.incomplete ? '≥' : ''}${gigs(row.used)}`,
                        budget: gigs(row.budget),
                        percent: percent === null ? DASH : percent,
                      })}
                    </span>
                  </div>
                  {/* Used and pinned share one bar: pinned memory is a subset of used that
                      will not be evicted, so it is the part of the bar that cannot move. */}
                  <StackedBar
                    segments={[
                      { label: t('DASHBOARD_MEMORY_PINNED'), value: row.pinned, tone: 'warn' },
                      { label: t('DASHBOARD_MEMORY_USED'), value: Math.max(0, row.used - row.pinned), tone: 'ok' },
                      { label: t('DASHBOARD_MEMORY_FREE'), value: Math.max(0, row.budget - row.used), tone: 'muted' },
                    ]}
                  />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>{t('DASHBOARD_MEMORY_TOTAL', { total: gigs(row.total) })}</span>
                    {row.pinned > 0 ? <span>{t('DASHBOARD_MEMORY_PINNED_MB', { mb: gigs(row.pinned) })}</span> : null}
                  </div>
                  {/* One line per engine holding something, each saying where its figure came from.
                      A figure the engine reported and a figure nvidia-smi measured are not the same
                      kind of number, and a reader chasing a discrepancy needs to know which is which. */}
                  {row.engines.length > 0 ? (
                    <ul className="space-y-0.5 pt-0.5 text-[11px]">
                      {row.engines.map((entry) => (
                        <li key={entry.backend} className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate" title={(entry.models ?? []).join(', ')}>
                            <span className="font-medium">{entry.backend}</span>
                            {entry.models && entry.models.length > 0 ? (
                              <span className="font-mono text-muted-foreground"> · {entry.models.join(', ')}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {typeof entry.usedMb === 'number' ? gigs(entry.usedMb) : DASH} · {usageSourceLabel(entry, vendor, t)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {/* Only a Hub that reports usage can say nothing is held; a budget without the block is older, not empty. */}
        {memory?.usage && rows.length > 0 && rows.every((row) => row.engines.length === 0) ? (
          <p className="pt-1 text-[11px] leading-tight text-muted-foreground">{t('DASHBOARD_MEMORY_NOTHING_HELD')}</p>
        ) : null}
        {unmeasured.length > 0 ? (
          <p className="pt-1 text-[11px] leading-tight text-muted-foreground">{t('DASHBOARD_MEMORY_FLOOR', { engines: unmeasured.join(', ') })}</p>
        ) : null}
        {/* Above the unified-memory note, and in warning colour, because it contradicts it: that
            note says models are sized against system RAM, and this says the system RAM figures
            cannot be the whole story on this machine. See `memoryReconciliation` for the arithmetic
            and the measurements behind each case. */}
        {reconciliation ? (
          <p
            data-testid={`model-memory-${reconciliation.kind}`}
            className="mt-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] leading-snug text-warning"
          >
            {reconciliation.kind === 'outside-host'
              ? t('DASHBOARD_MEMORY_OUTSIDE_HOST', { size: gigs(reconciliation.sizeMb) })
              : t('DASHBOARD_MEMORY_UNACCOUNTED', { size: gigs(reconciliation.sizeMb) })}
          </p>
        ) : null}
        {unified ? <p className="pt-1 text-[11px] leading-tight text-muted-foreground">{t('DASHBOARD_UNIFIED_MEMORY_NOTE')}</p> : null}
        {/* The "holds back an estimated N for app containers" line that stood here is gone: it read
            `dockerOverheadMb`, which `MemoryManagerService.setRunningAppCount` is supposed to feed
            and nothing calls, so it printed "0G" on every Hub. A figure that is always zero is not
            an estimate. */}
      </PanelBody>
    </Panel>
  );
}

/**
 * What each engine said about residency, reduced to what a row needs: whether it was asked at all,
 * and what it holds. `measured` and `implicit` both ANSWERED (an implicit engine holds exactly what
 * it serves); `unsupported` and `unreachable` did not, so every one of their models is unknown, not
 * "not in memory".
 */
function residencyByBackend(residency: ResidencyReportSummary | undefined) {
  const answered = new Map<string, Map<string, ResidentModelSummary>>();
  for (const backend of residency?.backends ?? []) {
    if (backend.models === null) continue;
    answered.set(backend.backend, new Map(backend.models.map((model) => [model.id, model])));
  }
  return answered;
}

/** An engine that put part of a model on the CPU: it reported GPU bytes, and fewer than the total. */
function cpuOffloaded(model: ResidentModelSummary | null | undefined): boolean {
  return !!model && model.engineGpuBytes !== null && model.totalBytes !== null && model.engineGpuBytes < model.totalBytes;
}

interface LocalModelRow {
  model: string;
  backend: string;
  healthy: boolean;
  /** `undefined`: the engine was not asked, or residency has not arrived. `null`: asked, and not held. */
  resident: ResidentModelSummary | null | undefined;
}

/**
 * The AI models this node holds — on disk, and which of them are IN MEMORY right now.
 *
 * Residency used to be a single count in the rail ("Resident 2") with nothing anywhere saying which
 * two, how big, or for how long. It is the most-asked question about a local engine — "is the model
 * I am about to call already loaded, and on the GPU?" — and `/inference/models/resident` was already
 * being fetched every 15s to produce that count. So each on-disk row now carries what the engine
 * said about it, resident rows come first, and a model split onto the CPU is named in words: a
 * partial offload is the difference between 30 tok/s and 3, and nothing else on the page shows it.
 *
 * Residency is a SECOND query with its own failure. A failed residency read costs one line, never
 * the on-disk list, which is a different endpoint that answered.
 */
export function LocalModels({
  node,
  inference,
  residency,
  residencyState,
  state,
  className,
}: {
  node: PoolNodeSummary | undefined;
  inference: InferenceBackendStatus[] | undefined;
  residency?: ResidencyReportSummary;
  residencyState?: LoadState;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = Date.now();
  const backends = node?.backends ?? [];
  const answered = residencyByBackend(residency);

  const onDisk: LocalModelRow[] = backends.flatMap((backend) =>
    (backend.modelsLoaded ?? []).map((model) => ({
      model,
      backend: backend.type,
      healthy: !!backend.healthy,
      resident: answered.has(backend.type) ? (answered.get(backend.type)?.get(model) ?? null) : undefined,
    })),
  );
  // A model an engine holds in memory but does not list on disk still belongs here — vLLM serves the
  // one model it was started with and may list nothing — or the "in memory" column would hide it.
  const listed = new Set(onDisk.map((row) => `${row.backend}:${row.model}`));
  const residentOnly: LocalModelRow[] = [...answered.entries()].flatMap(([backend, models]) =>
    [...models.values()]
      .filter((model) => !listed.has(`${backend}:${model.id}`))
      .map((model) => ({ model: model.id, backend, healthy: backends.find((entry) => entry.type === backend)?.healthy !== false, resident: model })),
  );
  const rows = [...onDisk, ...residentOnly].sort((a, b) => Number(!a.resident) - Number(!b.resident) || a.model.localeCompare(b.model));
  const offloaded = rows.filter((row) => cpuOffloaded(row.resident));

  const segments = backends
    .filter((backend) => (backend.modelsLoaded?.length ?? 0) > 0)
    .map((backend, index) => ({
      label: backend.type,
      value: backend.modelsLoaded?.length ?? 0,
      tone: BACKEND_TONES[index % BACKEND_TONES.length],
    }));

  return (
    <Panel
      title={t('DASHBOARD_LOCAL_MODELS_TITLE')}
      density="compact"
      className={className}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{rows.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={4}>
        {segments.length > 0 ? (
          <div className="space-y-1">
            <StackedBar segments={segments} />
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {segments.map((segment) => (
                <span key={segment.label} className="inline-flex items-center gap-1">
                  <StatusDot tone={segment.tone} className="h-1.5 w-1.5" />
                  {segment.label} {segment.value}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <KpiTable
          className="mt-2 max-h-64 overflow-y-auto"
          head={
            <>
              <Th>{t('DASHBOARD_COL_MODEL')}</Th>
              <Th>{t('DASHBOARD_COL_ENGINE')}</Th>
              <Th align="right" className="hidden @xs:table-cell">
                {t('DASHBOARD_COL_RESIDENT')}
              </Th>
              <Th align="right">{t('DASHBOARD_COL_STATE')}</Th>
            </>
          }
        >
          {rows.length === 0 ? (
            /* An engine that is down and an engine with nothing loaded are different
               facts, and the backend distinguishes them for exactly this line. */
            <TableEmpty colSpan={4}>{node?.capabilitiesError ?? t('DASHBOARD_NO_MODELS')}</TableEmpty>
          ) : (
            rows.map((row) => {
              const resident = row.resident;
              const detail = resident
                ? t('DASHBOARD_RESIDENT_DETAIL', {
                    expires: relativeUntil(resident.expiresAt, now),
                    context: resident.contextLength === null ? DASH : resident.contextLength.toLocaleString(),
                    quantization: resident.quantization ?? DASH,
                  })
                : undefined;

              return (
                <Tr key={`${row.backend}:${row.model}`} data={{ resident: resident ? 'yes' : resident === null ? 'no' : 'unknown' }}>
                  <Td className="max-w-[140px] truncate font-mono @md:max-w-[220px]" title={row.model}>
                    {row.model}
                  </Td>
                  <Td className="text-muted-foreground">{row.backend}</Td>
                  {/* Three states: in memory (its size and time left), asked and not held (blank —
                      the common case, where a column of dashes would read as "unknown"), or not asked
                      (a dash: this engine cannot say). */}
                  <Td align="right" className="hidden whitespace-nowrap @xs:table-cell" title={detail}>
                    {resident ? (
                      <span className={cpuOffloaded(resident) ? 'text-warning' : 'font-medium'}>
                        {resident.totalBytes === null ? t('DASHBOARD_RESIDENT_UNSIZED') : humanBytes(resident.totalBytes)}
                        {resident.expiresAt ? (
                          <span className="font-normal text-muted-foreground"> · {relativeUntil(resident.expiresAt, now)}</span>
                        ) : null}
                      </span>
                    ) : resident === null ? null : (
                      <span className="text-muted-foreground">{DASH}</span>
                    )}
                  </Td>
                  <Td align="right">
                    <StatusDot tone={row.healthy ? 'ok' : 'bad'} />
                  </Td>
                </Tr>
              );
            })
          )}
        </KpiTable>
        {residencyState?.failed ? <p className="pt-1 text-[11px] text-muted-foreground">{t('DASHBOARD_RESIDENCY_FAILED')}</p> : null}
        {offloaded.map((row) => (
          <p key={`offload-${row.backend}:${row.model}`} className="pt-1 text-[11px] text-warning">
            {t('DASHBOARD_CPU_OFFLOAD', { model: row.model })}
          </p>
        ))}
        {inference && inference.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5 text-[11px] text-muted-foreground">
            {inference.map((backend) => (
              <span key={backend.type} className="inline-flex items-center gap-1">
                <StatusDot tone={backend.healthy ? 'ok' : backend.running ? 'warn' : 'muted'} className="h-1.5 w-1.5" />
                {backend.type}
              </span>
            ))}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/** A share of one core as cores: `0.07`, `1.4`, `12`. Two decimals where a workload is a sliver of one core. */
function formatCores(cores: number): string {
  if (cores >= 10) return String(Math.round(cores));
  return cores >= 1 ? cores.toFixed(1) : cores.toFixed(2);
}

export function LocalContainers({
  apps,
  history,
  rollup,
  state,
  className,
}: {
  apps: AppRuntimeHealth[];
  history: AppRuntimeHistorySample[];
  /**
   * The leaf-container rollup — the same one the local pool card reads. Its totals are what the rail
   * used to show as "Workload CPU" and "Workload RAM", and they belong beside the rows they sum.
   * `null`/absent falls back to a bare container count.
   */
  rollup?: NodeContainers | null;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const sorted = [...apps].sort((a, b) => b.cpuPercent - a.cpuPercent || a.appName.localeCompare(b.appName));
  const maxCpu = Math.max(1, ...apps.map((app) => app.cpuPercent));
  const totalContainers = apps.reduce((sum, app) => sum + app.containers.length, 0);
  // Deduped and gap-marked the same way as the trend tiles, so a sparkline here cannot join across a
  // Hub restart that the tiles above break at.
  const slots = sampleTimeline(history).slots;

  /*
   * `null`, NOT `?? 0`, for a sample that does not mention this workload.
   *
   * Every installed non-`missing` app appears in every sample the backend takes, so an app absent
   * from an older one was not installed yet. Coalescing that to zero drew a brand-new workload as
   * having idled at 0% for the first half of the window — a measurement nobody took, and identical
   * on screen to a container doing nothing. `Sparkline` splits the runs and leaves the gap open.
   */
  const seriesFor = (appUrn: string): (number | null)[] =>
    slots.map((slot) => {
      if (slot.kind === 'gap') return null;
      const point = slot.sample.apps.find((app) => app.appUrn === appUrn);

      return point ? point.cpuPercent : null;
    });

  return (
    <Panel
      title={t('DASHBOARD_LOCAL_CONTAINERS_TITLE')}
      density="compact"
      className={className}
      actions={
        state.pending || state.failed ? null : (
          /*
           * CORES, not a percentage. Docker's CPU% is per core, so the rail's old "Workload CPU 7%"
           * meant seven hundredths of ONE core — on a 32-core host, beside "Host RAM 26%", which is a
           * share of the machine. Two percentages side by side on different denominators read as the
           * same kind of number; a core count cannot be misread as a share.
           */
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {rollup
              ? t('DASHBOARD_CONTAINERS_HEADER', {
                  total: rollup.total,
                  cores: formatCores(rollup.cpuPercent / 100),
                  memory: humanBytes(rollup.memoryBytes),
                })
              : t('DASHBOARD_CONTAINER_COUNT', { total: totalContainers })}
          </span>
        )
      }
    >
      <PanelBody state={state} error={t('DASHBOARD_CONTAINERS_FAILED')} lines={4}>
        <KpiTable
          head={
            <>
              <Th>{t('DASHBOARD_COL_WORKLOAD')}</Th>
              <Th align="right">{t('DASHBOARD_COL_CPU')}</Th>
              <Th className="hidden @lg:table-cell">{t('DASHBOARD_COL_TREND')}</Th>
              <Th align="right" className="hidden @sm:table-cell">
                {t('DASHBOARD_COL_MEMORY')}
              </Th>
              <Th align="right" className="hidden @xl:table-cell">
                {t('DASHBOARD_COL_CONTAINERS')}
              </Th>
              <Th align="right">{t('DASHBOARD_COL_STATE')}</Th>
            </>
          }
        >
          {sorted.length === 0 ? (
            <TableEmpty colSpan={6}>{t('DASHBOARD_NO_CONTAINERS')}</TableEmpty>
          ) : (
            sorted.map((app) => (
              <Tr key={app.appUrn}>
                <Td className="max-w-[120px] truncate font-medium @sm:max-w-[180px]" title={`${app.appName} · ${app.appUrn}`}>
                  {app.appName}
                </Td>
                <Td align="right">
                  <div className="flex items-center justify-end gap-1.5">
                    <span>{app.cpuPercent.toFixed(1)}%</span>
                    <MeterBar
                      value={app.cpuPercent}
                      max={maxCpu}
                      tone={app.degraded ? 'bad' : app.highCpu ? 'warn' : 'ok'}
                      className="w-10 min-w-[24px]"
                    />
                  </div>
                </Td>
                <Td className="hidden @lg:table-cell">
                  <Sparkline points={seriesFor(app.appUrn)} tone={app.degraded ? 'bad' : 'ok'} />
                </Td>
                <Td align="right" className="hidden @sm:table-cell">
                  {humanBytes(app.memoryUsageBytes)}
                </Td>
                <Td align="right" className="hidden @xl:table-cell">
                  {app.containers.length}
                </Td>
                <Td align="right" title={app.reason ?? undefined}>
                  <StatusDot tone={app.degraded ? 'bad' : app.responsive ? 'ok' : 'warn'} />
                </Td>
              </Tr>
            ))
          )}
        </KpiTable>
      </PanelBody>
    </Panel>
  );
}
