import {
  DASH,
  KpiTable,
  Panel,
  relativeAge,
  StackedBar,
  StatChip,
  StatChipRow,
  StatusDot,
  TableEmpty,
  Td,
  Th,
  Tr,
} from '@/components/ui/dense/dense';
import type { HardwareSummary, PoolStatusSummary, RoutingLogEntry } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * AI POOLING AND MISC — where requests actually went, and the settings that decided it.
 *
 * The routing log is the only record in the product of a request crossing a node
 * boundary, and it is in-memory only: a Hub restart clears it, so an empty table means
 * "nothing since the last restart", never "pooling is broken".
 */

const NODE_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

export function PoolSummary({ pool }: { pool: PoolStatusSummary | undefined }) {
  const { t } = useTranslation();
  const routing = pool?.routing;
  const served = routing?.served ?? 0;
  const failed = routing?.failed ?? 0;

  return (
    <Panel title={t('DASHBOARD_POOL_SUMMARY_TITLE')}>
      <StatChipRow>
        <StatChip
          value={pool?.routingActive ? t('DASHBOARD_POOL_ON') : t('DASHBOARD_POOL_OFF')}
          label={t('DASHBOARD_POOL_ROUTING')}
          sub={pool?.reason}
          tone={pool?.routingActive ? 'ok' : pool?.enabled ? 'warn' : 'muted'}
        />
        <StatChip value={served} label={t('DASHBOARD_SERVED')} tone={served > 0 ? 'ok' : 'muted'} />
        <StatChip value={failed} label={t('DASHBOARD_FAILED')} tone={failed > 0 ? 'bad' : 'muted'} />
        <StatChip
          value={routing?.failovers ?? 0}
          label={t('DASHBOARD_FAILOVERS')}
          tone={(routing?.failovers ?? 0) > 0 ? 'warn' : 'muted'}
          hint={t('DASHBOARD_FAILOVERS_HINT')}
          hintId="dashboard-failovers"
        />
        <StatChip value={pool?.settings?.poolLocalAffinity ?? DASH} label={t('DASHBOARD_AFFINITY')} tone="muted" />
        <StatChip
          value={pool?.settings?.poolHealthPollSeconds ? `${pool.settings.poolHealthPollSeconds}s` : DASH}
          label={t('DASHBOARD_HEALTH_POLL')}
          tone="muted"
        />
      </StatChipRow>
    </Panel>
  );
}

export function RoutingLog({ entries }: { entries: RoutingLogEntry[] }) {
  const { t } = useTranslation();
  const now = Date.now();

  // Where requests went, as one bar. Answers "is the pool actually spreading work, or
  // is one node taking all of it" without reading every row.
  const byNode = new Map<string, number>();
  for (const entry of entries) {
    const node = (entry.node ?? 'local').split('.')[0] || 'local';
    byNode.set(node, (byNode.get(node) ?? 0) + 1);
  }
  const segments = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, tone: NODE_TONES[index % NODE_TONES.length] }));

  return (
    <Panel title={t('DASHBOARD_ROUTING_LOG_TITLE')} actions={<span className="text-[10px] text-muted-foreground">{entries.length}</span>}>
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
        className="max-h-80 overflow-y-auto"
        head={
          <>
            <Th align="right">{t('DASHBOARD_COL_AGE')}</Th>
            <Th>{t('DASHBOARD_COL_DIRECTION')}</Th>
            <Th>{t('DASHBOARD_COL_NODE')}</Th>
            <Th>{t('DASHBOARD_COL_MODEL')}</Th>
            <Th>{t('DASHBOARD_COL_ENGINE')}</Th>
            <Th align="right">{t('DASHBOARD_COL_LATENCY')}</Th>
            <Th align="right">{t('DASHBOARD_COL_OUTCOME')}</Th>
          </>
        }
      >
        {entries.length === 0 ? (
          <TableEmpty colSpan={7}>{t('DASHBOARD_ROUTING_LOG_EMPTY')}</TableEmpty>
        ) : (
          entries.map((entry) => (
            /* No server-side id on a routing record, so the key is what identifies one:
               a node cannot serve two requests for the same model at the same instant. */
            <Tr key={`${entry.at}-${entry.node ?? 'local'}-${entry.model ?? ''}`}>
              <Td align="right" className="text-muted-foreground">
                {relativeAge(entry.at, now)}
              </Td>
              <Td className={entry.direction === 'outbound' ? 'text-primary' : 'text-muted-foreground'}>{entry.direction}</Td>
              <Td className="max-w-[140px] truncate" title={entry.node ?? undefined}>
                {(entry.node ?? DASH).split('.')[0]}
              </Td>
              <Td className="max-w-[160px] truncate font-mono" title={entry.model ?? undefined}>
                {entry.model ?? DASH}
              </Td>
              <Td className="text-muted-foreground">{entry.backend ?? DASH}</Td>
              <Td align="right">{typeof entry.durationMs === 'number' ? `${Math.round(entry.durationMs)}ms` : DASH}</Td>
              <Td align="right">
                <StatusDot tone={entry.outcome === 'served' ? 'ok' : 'bad'} />
              </Td>
            </Tr>
          ))
        )}
      </KpiTable>
    </Panel>
  );
}

export function MiscPanel({ pool, hardware }: { pool: PoolStatusSummary | undefined; hardware: HardwareSummary | undefined }) {
  const { t } = useTranslation();
  const node = pool?.localNode;

  const rows: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' }[] = [
    { label: t('DASHBOARD_MISC_NODE'), value: node?.nodeFqdn ?? DASH },
    { label: t('DASHBOARD_MISC_TAILNET'), value: node?.tailnet ?? DASH },
    {
      label: t('DASHBOARD_MISC_TAILSCALE'),
      value: node?.tailscaleConnected ? t('DASHBOARD_CONNECTED') : t('DASHBOARD_DISCONNECTED'),
      tone: node?.tailscaleConnected ? 'ok' : 'bad',
    },
    { label: t('DASHBOARD_MISC_OS'), value: hardware?.os ? `${hardware.os.name ?? ''} ${hardware.os.version ?? ''}`.trim() || DASH : DASH },
    { label: t('DASHBOARD_MISC_CPU'), value: hardware?.cpu?.model ?? DASH },
    {
      label: t('DASHBOARD_MISC_GPU'),
      value: hardware?.gpu?.available ? `${hardware.gpu.vendor ?? ''} ${hardware.gpu.model ?? ''}`.trim() : t('DASHBOARD_NONE'),
      tone: hardware?.gpu?.available ? 'ok' : 'muted',
    },
    {
      label: t('DASHBOARD_MISC_GPU_RUNTIME'),
      value: hardware?.gpu?.runtimeAvailable ? t('DASHBOARD_AVAILABLE') : t('DASHBOARD_UNAVAILABLE'),
      tone: hardware?.gpu?.runtimeAvailable ? 'ok' : 'warn',
    },
  ];

  return (
    <Panel title={t('DASHBOARD_MISC_TITLE')}>
      <KpiTable
        head={
          <>
            <Th>{t('DASHBOARD_COL_FIELD')}</Th>
            <Th>{t('DASHBOARD_COL_VALUE')}</Th>
          </>
        }
      >
        {rows.map((row) => (
          <Tr key={row.label}>
            <Td className="w-[42%] text-[10px] uppercase tracking-[0.5px] text-muted-foreground">{row.label}</Td>
            <Td className={row.tone === 'ok' ? 'text-success' : row.tone === 'bad' ? 'text-destructive' : row.tone === 'warn' ? 'text-warning' : ''}>
              <span className="font-mono text-[11px]">{row.value}</span>
            </Td>
          </Tr>
        ))}
      </KpiTable>
      {node?.capabilitiesError ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">{node.capabilitiesError}</p>
      ) : null}
    </Panel>
  );
}
