import {
  DASH,
  humanBytes,
  KpiTable,
  MeterBar,
  Panel,
  PanelBody,
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
import {
  budgetPercent,
  type HardwareSummary,
  type InferenceBackendStatus,
  type LoadState,
  memoryBudgetRows,
  type MemoryBudgetSummary,
  type PoolNodeSummary,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * LOCAL RESOURCES — what this machine itself is running.
 *
 * Four panels: the host's own capacity, the AI models resident on it, how much memory
 * those models are allowed and holding, and the containerised workloads. Every number
 * here is measured on this node, so the whole section renders on an unpaired Hub.
 *
 * Each panel takes its own `state` and wraps its body in `PanelBody`, so a failed fetch
 * shows as a failed fetch rather than as a zero.
 */

const BACKEND_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

export function HostCapacity({
  hardware,
  node,
  state,
}: {
  hardware: HardwareSummary | undefined;
  node: PoolNodeSummary | undefined;
  state: LoadState;
}) {
  const { t } = useTranslation();
  const ramTotal = hardware?.ram?.totalMb ?? null;
  const ramAvail = hardware?.ram?.availableMb ?? null;
  const ramUsed = ramTotal !== null && ramAvail !== null ? ramTotal - ramAvail : null;

  return (
    <Panel title={t('DASHBOARD_HOST_TITLE')}>
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
              label rather than a number that would read as a dedicated card's. */}
          <StatChip
            value={
              hardware?.gpu?.unifiedMemory ? t('DASHBOARD_UNIFIED') : hardware?.gpu?.vramMb ? `${Math.round(hardware.gpu.vramMb / 1024)}G` : DASH
            }
            label={t('DASHBOARD_VRAM')}
            sub={hardware?.gpu?.model}
            tone={hardware?.gpu?.available ? 'ok' : 'muted'}
          />
          <StatChip value={hardware?.tier ?? DASH} label={t('DASHBOARD_TIER')} tone="muted" />
          <StatChip
            value={typeof node?.inFlightRequests === 'number' ? node.inFlightRequests : DASH}
            label={t('DASHBOARD_IN_FLIGHT')}
            tone={(node?.inFlightRequests ?? 0) > 0 ? 'ok' : 'muted'}
          />
        </StatChipRow>
        {ramTotal !== null && ramUsed !== null ? (
          <div className="space-y-1 pt-1">
            <MeterBar value={ramUsed} max={ramTotal} tone={ramUsed / ramTotal > 0.9 ? 'warn' : 'ok'} />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{t('DASHBOARD_RAM_USED', { used: `${Math.round(ramUsed / 1024)}G`, total: `${Math.round(ramTotal / 1024)}G` })}</span>
            </div>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/**
 * How much memory models may use, and how much they hold.
 *
 * Three numbers per pool, and they are not interchangeable: `total` is the hardware,
 * `budget` is what the router will let models take out of it, and `used` is what they have.
 * A machine can be far from full and still refuse to load a model because the budget is
 * spent — which is unexplainable from a single "memory used" figure, and is the reason
 * this panel exists.
 */
export function ModelMemory({
  memory,
  hardware,
  state,
}: {
  memory: MemoryBudgetSummary | undefined;
  hardware: HardwareSummary | undefined;
  state: LoadState;
}) {
  const { t } = useTranslation();
  const rows = memoryBudgetRows(memory);
  const unified = hardware?.gpu?.unifiedMemory === true;

  return (
    <Panel title={t('DASHBOARD_MODEL_MEMORY_TITLE')}>
      <PanelBody state={state} error={t('DASHBOARD_MEMORY_FAILED')}>
        {rows.length === 0 ? (
          <p className="py-3 text-center text-xs italic text-muted-foreground">{t('DASHBOARD_MODEL_MEMORY_EMPTY')}</p>
        ) : (
          <div className="space-y-2.5">
            {rows.map((row) => {
              const percent = budgetPercent(row.used, row.budget);

              return (
                <div key={row.kind} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="font-medium uppercase tracking-[0.5px]">{row.kind === 'vram' ? t('DASHBOARD_VRAM') : t('DASHBOARD_RAM')}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t('DASHBOARD_MEMORY_OF_BUDGET', {
                        used: `${Math.round(row.used / 1024)}G`,
                        budget: `${Math.round(row.budget / 1024)}G`,
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
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{t('DASHBOARD_MEMORY_TOTAL', { total: `${Math.round(row.total / 1024)}G` })}</span>
                    {row.pinned > 0 ? <span>{t('DASHBOARD_MEMORY_PINNED_MB', { mb: `${Math.round(row.pinned / 1024)}G` })}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {unified ? <p className="pt-1 text-[10px] leading-tight text-muted-foreground">{t('DASHBOARD_UNIFIED_MEMORY_NOTE')}</p> : null}
        {/* Docker overhead is an estimate — running app containers times a flat per-container
            figure — not a measurement. Saying so is the difference between a budget an
            operator can reason about and a number they will chase. */}
        {typeof memory?.dockerOverheadMb === 'number' ? (
          <p className="text-[10px] leading-tight text-muted-foreground">
            {t('DASHBOARD_DOCKER_OVERHEAD', { mb: `${Math.round(memory.dockerOverheadMb / 1024)}G` })}
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

export function LocalModels({
  node,
  inference,
  state,
}: {
  node: PoolNodeSummary | undefined;
  inference: InferenceBackendStatus[] | undefined;
  state: LoadState;
}) {
  const { t } = useTranslation();
  const backends = node?.backends ?? [];
  const rows = backends
    .flatMap((backend) => (backend.modelsLoaded ?? []).map((model) => ({ model, backend: backend.type, healthy: !!backend.healthy })))
    .sort((a, b) => a.model.localeCompare(b.model));

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
      actions={state.pending || state.failed ? null : <span className="text-[10px] text-muted-foreground">{rows.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={4}>
        {segments.length > 0 ? (
          <div className="space-y-1">
            <StackedBar segments={segments} />
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
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
              <Th align="right">{t('DASHBOARD_COL_STATE')}</Th>
            </>
          }
        >
          {rows.length === 0 ? (
            /* An engine that is down and an engine with nothing loaded are different
               facts, and the backend distinguishes them for exactly this line. */
            <TableEmpty colSpan={3}>{node?.capabilitiesError ?? t('DASHBOARD_NO_MODELS')}</TableEmpty>
          ) : (
            rows.map((row) => (
              <Tr key={`${row.backend}:${row.model}`}>
                <Td className="font-mono" title={row.model}>
                  {row.model}
                </Td>
                <Td className="text-muted-foreground">{row.backend}</Td>
                <Td align="right">
                  <StatusDot tone={row.healthy ? 'ok' : 'bad'} />
                </Td>
              </Tr>
            ))
          )}
        </KpiTable>
        {inference && inference.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5 text-[10px] text-muted-foreground">
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

export function LocalContainers({ apps, history, state }: { apps: AppRuntimeHealth[]; history: AppRuntimeHistorySample[]; state: LoadState }) {
  const { t } = useTranslation();
  const sorted = [...apps].sort((a, b) => b.cpuPercent - a.cpuPercent || a.appName.localeCompare(b.appName));
  const maxCpu = Math.max(1, ...apps.map((app) => app.cpuPercent));
  const totalContainers = apps.reduce((sum, app) => sum + app.containers.length, 0);

  const seriesFor = (appUrn: string) => history.map((sample) => sample.apps.find((app) => app.appUrn === appUrn)?.cpuPercent ?? 0);

  return (
    <Panel
      title={t('DASHBOARD_LOCAL_CONTAINERS_TITLE')}
      actions={
        state.pending || state.failed ? null : (
          <span className="text-[10px] text-muted-foreground">{t('DASHBOARD_CONTAINER_COUNT', { total: totalContainers })}</span>
        )
      }
    >
      <PanelBody state={state} error={t('DASHBOARD_CONTAINERS_FAILED')} lines={4}>
        <KpiTable
          head={
            <>
              <Th>{t('DASHBOARD_COL_WORKLOAD')}</Th>
              <Th align="right">{t('DASHBOARD_COL_CPU')}</Th>
              <Th>{t('DASHBOARD_COL_TREND')}</Th>
              <Th align="right">{t('DASHBOARD_COL_MEMORY')}</Th>
              <Th align="right">{t('DASHBOARD_COL_CONTAINERS')}</Th>
              <Th align="right">{t('DASHBOARD_COL_STATE')}</Th>
            </>
          }
        >
          {sorted.length === 0 ? (
            <TableEmpty colSpan={6}>{t('DASHBOARD_NO_CONTAINERS')}</TableEmpty>
          ) : (
            sorted.map((app) => (
              <Tr key={app.appUrn}>
                <Td className="max-w-[180px] truncate font-medium" title={`${app.appName} · ${app.appUrn}`}>
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
                <Td>
                  <Sparkline points={seriesFor(app.appUrn)} tone={app.degraded ? 'bad' : 'ok'} />
                </Td>
                <Td align="right">{humanBytes(app.memoryUsageBytes)}</Td>
                <Td align="right">{app.containers.length}</Td>
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
