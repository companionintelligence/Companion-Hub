import {
  DASH,
  humanBytes,
  KpiTable,
  MeterBar,
  Panel,
  Sparkline,
  StatChip,
  StatChipRow,
  StatusDot,
  StackedBar,
  TableEmpty,
  Td,
  Th,
  Tr,
} from '@/components/ui/dense/dense';
import type { AppRuntimeHealth, AppRuntimeHistorySample } from '@/lib/app-runtime-monitor';
import type { HardwareSummary, InferenceBackendStatus, PoolNodeSummary } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * LOCAL RESOURCES — what this machine itself is running.
 *
 * Three panels: the host's own capacity, the AI models resident on it, and the
 * containerised workloads. Every number here is measured on this node; nothing in this
 * section depends on the pool, so it renders in full on an unpaired Hub.
 */

const BACKEND_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

export function HostCapacity({ hardware, node }: { hardware: HardwareSummary | undefined; node: PoolNodeSummary | undefined }) {
  const { t } = useTranslation();
  const ramTotal = hardware?.ram?.totalMb ?? null;
  const ramAvail = hardware?.ram?.availableMb ?? null;
  const ramUsed = ramTotal !== null && ramAvail !== null ? ramTotal - ramAvail : null;

  return (
    <Panel title={t('DASHBOARD_HOST_TITLE')}>
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
          sub={ramUsed !== null && ramTotal ? `${Math.round((ramUsed / ramTotal) * 100)}% used` : undefined}
          tone={ramUsed !== null && ramTotal && ramUsed / ramTotal > 0.9 ? 'warn' : 'plain'}
        />
        <StatChip
          value={hardware?.gpu?.vramMb ? `${Math.round(hardware.gpu.vramMb / 1024)}G` : DASH}
          label={t('DASHBOARD_VRAM')}
          sub={hardware?.gpu?.model}
          tone={hardware?.gpu?.available ? 'ok' : 'muted'}
        />
        <StatChip value={hardware?.tier ?? DASH} label={t('DASHBOARD_TIER')} tone="muted" />
        <StatChip value={node?.inFlightRequests ?? DASH} label={t('DASHBOARD_IN_FLIGHT')} tone={(node?.inFlightRequests ?? 0) > 0 ? 'ok' : 'muted'} />
      </StatChipRow>
      {ramTotal !== null && ramUsed !== null ? (
        <div className="space-y-1 pt-1">
          <MeterBar value={ramUsed} max={ramTotal} tone={ramUsed / ramTotal > 0.9 ? 'warn' : 'ok'} />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{t('DASHBOARD_RAM_USED', { used: `${Math.round(ramUsed / 1024)}G`, total: `${Math.round(ramTotal / 1024)}G` })}</span>
            {/* The inference budget is NOT the same as free RAM — the router sizes models
                against this, so showing it next to total is what makes an "it should fit"
                decision reviewable. */}
            {hardware?.effectiveInferenceMemoryMb ? (
              <span>{t('DASHBOARD_INFERENCE_BUDGET', { mb: `${Math.round(hardware.effectiveInferenceMemoryMb / 1024)}G` })}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

export function LocalModels({ node, inference }: { node: PoolNodeSummary | undefined; inference: InferenceBackendStatus[] | undefined }) {
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
    <Panel title={t('DASHBOARD_LOCAL_MODELS_TITLE')} actions={<span className="text-[10px] text-muted-foreground">{rows.length}</span>}>
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
        className="max-h-64 overflow-y-auto"
        head={
          <>
            <Th>{t('DASHBOARD_COL_MODEL')}</Th>
            <Th>{t('DASHBOARD_COL_ENGINE')}</Th>
            <Th align="right">{t('DASHBOARD_COL_STATE')}</Th>
          </>
        }
      >
        {rows.length === 0 ? (
          <TableEmpty colSpan={3}>{t('DASHBOARD_NO_MODELS')}</TableEmpty>
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
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] text-muted-foreground">
          {inference.map((backend) => (
            <span key={backend.type} className="inline-flex items-center gap-1">
              <StatusDot tone={backend.healthy ? 'ok' : backend.running ? 'warn' : 'muted'} className="h-1.5 w-1.5" />
              {backend.type}
            </span>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

export function LocalContainers({ apps, history }: { apps: AppRuntimeHealth[]; history: AppRuntimeHistorySample[] }) {
  const { t } = useTranslation();
  const sorted = [...apps].sort((a, b) => b.cpuPercent - a.cpuPercent || a.appName.localeCompare(b.appName));
  const maxCpu = Math.max(1, ...apps.map((app) => app.cpuPercent));
  const totalContainers = apps.reduce((sum, app) => sum + app.containers.length, 0);

  const seriesFor = (appUrn: string) => history.map((sample) => sample.apps.find((app) => app.appUrn === appUrn)?.cpuPercent ?? 0);

  return (
    <Panel
      title={t('DASHBOARD_LOCAL_CONTAINERS_TITLE')}
      actions={<span className="text-[10px] text-muted-foreground">{t('DASHBOARD_CONTAINER_COUNT', { count: totalContainers })}</span>}
    >
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
              <Td className="max-w-[180px] truncate font-medium" title={app.appName}>
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
              <Td align="right">
                <StatusDot tone={app.degraded ? 'bad' : app.responsive ? 'ok' : 'warn'} />
              </Td>
            </Tr>
          ))
        )}
      </KpiTable>
    </Panel>
  );
}
