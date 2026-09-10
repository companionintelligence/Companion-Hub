import {
  DASH,
  KpiTable,
  Panel,
  PanelBody,
  relativeAge,
  StackedBar,
  StatChip,
  StatChipRow,
  StatusDot,
  TableEmpty,
  Td,
  Th,
  type Tone,
  Tr,
} from '@/components/ui/dense/dense';
import {
  type CloudProviderSummary,
  type HardwareSummary,
  type LoadState,
  type PoolDirectionState,
  type PoolStatusSummary,
  type RoutingLogEntry,
  routingByNode,
  routingLogKeys,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * AI POOLING AND MISC — where requests actually went, and the settings that decided it.
 *
 * The routing log is the only record in the product of a request crossing a node boundary,
 * and it lives in a bounded in-memory ring buffer: a Hub restart clears it. So an empty
 * table means "nothing since the last restart", never "pooling is broken", and it says so.
 */

const NODE_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

/**
 * One direction of pooling, and what is holding it off.
 *
 * `env` and `setting` are kept apart because only one of them is something the operator can
 * change from this app. A direction switched off in `.env` rendered as a plain "off" sends
 * someone to a settings toggle that will appear to do nothing.
 */
function DirectionChip({ direction, label }: { direction: PoolDirectionState | undefined; label: string }) {
  const { t } = useTranslation();
  const by = direction?.disabledBy;

  // A Hub too old to report per-direction state sends no `directions` at all. Rendering
  // that as "off" would claim a half of pooling is switched off on a node that is routing
  // normally, so an absent field reads as unknown.
  if (typeof direction?.enabled !== 'boolean') {
    return <StatChip value={DASH} label={label} tone="muted" />;
  }

  return (
    <StatChip
      value={direction.enabled ? t('DASHBOARD_POOL_ON') : t('DASHBOARD_POOL_OFF')}
      label={label}
      sub={
        direction.enabled
          ? undefined
          : by === 'env'
            ? t('DASHBOARD_DISABLED_BY_ENV')
            : by === 'setting'
              ? t('DASHBOARD_DISABLED_BY_SETTING')
              : undefined
      }
      tone={direction.enabled ? 'ok' : 'warn'}
    />
  );
}

export function PoolSummary({ pool, state }: { pool: PoolStatusSummary | undefined; state: LoadState }) {
  const { t } = useTranslation();
  const routing = pool?.routing;
  const settings = pool?.settings;
  const pins = pool?.pins ?? [];
  const stalePins = pins.filter((pin) => pin.targetAvailable === false);

  return (
    <Panel title={t('DASHBOARD_POOL_SUMMARY_TITLE')}>
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={2}>
        <StatChipRow>
          <StatChip
            value={pool?.routingActive ? t('DASHBOARD_POOL_ON') : t('DASHBOARD_POOL_OFF')}
            label={t('DASHBOARD_POOL_ROUTING')}
            sub={pool?.reason ? t(`DASHBOARD_REASON_${(pool.reason as string).toUpperCase()}`, { defaultValue: pool.reason }) : undefined}
            tone={pool?.routingActive ? 'ok' : pool?.enabled ? 'warn' : 'muted'}
          />
          <DirectionChip direction={pool?.directions?.outbound} label={t('DASHBOARD_OUTBOUND')} />
          <DirectionChip direction={pool?.directions?.inbound} label={t('DASHBOARD_INBOUND')} />
          <StatChip value={routing?.served ?? DASH} label={t('DASHBOARD_SERVED')} tone={(routing?.served ?? 0) > 0 ? 'ok' : 'muted'} />
          <StatChip value={routing?.failed ?? DASH} label={t('DASHBOARD_FAILED')} tone={(routing?.failed ?? 0) > 0 ? 'bad' : 'muted'} />
          <StatChip
            value={routing?.failovers ?? DASH}
            label={t('DASHBOARD_FAILOVERS')}
            tone={(routing?.failovers ?? 0) > 0 ? 'warn' : 'muted'}
            hint={t('DASHBOARD_FAILOVERS_HINT')}
            hintId="dashboard-failovers"
          />
          <StatChip
            value={settings?.poolLocalAffinity ?? DASH}
            label={t('DASHBOARD_AFFINITY')}
            tone="muted"
            hint={t('DASHBOARD_AFFINITY_HINT')}
            hintId="dashboard-affinity"
          />
          <StatChip
            value={settings?.poolPressureWeight ?? DASH}
            label={t('DASHBOARD_PRESSURE_WEIGHT')}
            tone="muted"
            hint={t('DASHBOARD_PRESSURE_WEIGHT_HINT')}
            hintId="dashboard-pressure-weight"
          />
          <StatChip
            value={settings?.poolHealthPollSeconds ? `${settings.poolHealthPollSeconds}s` : DASH}
            label={t('DASHBOARD_HEALTH_POLL')}
            tone="muted"
          />
          <StatChip
            value={settings?.poolRequireSignedPeers ? t('DASHBOARD_REQUIRED') : t('DASHBOARD_OPTIONAL')}
            label={t('DASHBOARD_SIGNED_PEERS')}
            tone={settings?.poolRequireSignedPeers ? 'ok' : 'muted'}
            hint={t('DASHBOARD_SIGNED_PEERS_HINT')}
            hintId="dashboard-signed-peers"
          />
        </StatChipRow>
        {pins.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-[10px]">
            <span className="uppercase tracking-[0.5px] text-muted-foreground">{t('DASHBOARD_PINS')}</span>
            {pins.map((pin) => (
              <span
                key={`${pin.scope}-${pin.model ?? ''}-${pin.peerId ?? pin.targetKind}`}
                className={
                  pin.targetAvailable === false
                    ? 'rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-warning'
                    : 'rounded-md border border-border bg-muted/20 px-1.5 py-0.5 text-muted-foreground'
                }
                /* A pin whose target cannot serve is a silent no-op on the request path.
                   It is set once and forgotten, so the only place it can surface is here. */
                title={pin.targetAvailable === false ? t('DASHBOARD_PIN_INACTIVE') : undefined}
              >
                {pin.model ?? pin.scope ?? DASH} → {pin.nodeFqdn?.split('.')[0] ?? pin.targetKind ?? DASH}
                {pin.targetAvailable === false ? ' ⚠' : ''}
              </span>
            ))}
          </div>
        ) : null}
        {stalePins.length > 0 ? <p className="pt-1 text-[10px] text-warning">{t('DASHBOARD_PINS_INACTIVE', { total: stalePins.length })}</p> : null}
      </PanelBody>
    </Panel>
  );
}

export function RoutingLog({ entries, state }: { entries: RoutingLogEntry[]; state: LoadState }) {
  const { t } = useTranslation();
  const now = Date.now();
  // Content-derived keys: the log grows at the head, so an index would shift under every row.
  const keys = routingLogKeys(entries);

  // Where requests went, as one bar. Answers "is the pool spreading work, or is one node
  // taking all of it" without reading every row.
  const byNode = routingByNode(entries, t('DASHBOARD_ROUTING_UNPLACED'));
  const segments = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, tone: NODE_TONES[index % NODE_TONES.length] as Tone }));

  return (
    <Panel
      title={t('DASHBOARD_ROUTING_LOG_TITLE')}
      actions={state.pending || state.failed ? null : <span className="text-[10px] text-muted-foreground">{entries.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_ROUTING_LOG_FAILED')} lines={5}>
        {segments.length > 0 ? (
          <div className="space-y-1 pb-1.5">
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
            entries.map((entry, index) => {
              const inbound = entry.direction === 'inbound';
              const failover = entry.failedOverFrom?.length ? entry.failedOverFrom.length : 0;

              return (
                <Tr key={keys[index]}>
                  <Td align="right" className="text-muted-foreground">
                    {relativeAge(entry.at, now)}
                  </Td>
                  <Td className={inbound ? 'text-muted-foreground' : 'text-primary'}>{entry.direction}</Td>
                  <Td className="max-w-[140px] truncate" title={entry.node ?? undefined}>
                    {(entry.node ?? DASH).split('.')[0]}
                  </Td>
                  {/* An inbound row never carries a model — the peer asked, it did not say
                      what for. A dash here is the record, not a gap. */}
                  <Td className="max-w-[160px] truncate font-mono" title={inbound ? t('DASHBOARD_INBOUND_NO_MODEL') : (entry.model ?? undefined)}>
                    {entry.model ?? DASH}
                  </Td>
                  <Td className="text-muted-foreground">{entry.backend ?? DASH}</Td>
                  <Td align="right">{typeof entry.durationMs === 'number' ? `${Math.round(entry.durationMs)}ms` : DASH}</Td>
                  <Td align="right" title={entry.outcome}>
                    <span className="inline-flex items-center justify-end gap-1">
                      {failover > 0 ? <span className="text-[10px] text-warning">{t('DASHBOARD_FAILOVER_SHORT', { total: failover })}</span> : null}
                      {entry.pin ? <span className="text-[10px] text-muted-foreground">{t('DASHBOARD_PIN_SHORT')}</span> : null}
                      <StatusDot tone={entry.outcome === 'served' ? 'ok' : 'bad'} />
                    </span>
                  </Td>
                </Tr>
              );
            })
          )}
        </KpiTable>
      </PanelBody>
    </Panel>
  );
}

export function CloudProviders({ providers, state }: { providers: CloudProviderSummary[] | undefined; state: LoadState }) {
  const { t } = useTranslation();
  const rows = providers ?? [];

  return (
    <Panel title={t('DASHBOARD_CLOUD_TITLE')}>
      <PanelBody state={state} error={t('DASHBOARD_CLOUD_FAILED')} lines={2}>
        {rows.length === 0 ? (
          /* Empty is the normal state: cloud fallback is opt-in and most Hubs run local
             only. It must not read like a fetch that came back short. */
          <p className="py-2 text-center text-xs italic text-muted-foreground">{t('DASHBOARD_CLOUD_EMPTY')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {rows.map((provider) => (
              <span
                key={provider.provider}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 text-[11px]"
                title={provider.defaultModel ?? undefined}
              >
                <StatusDot tone={provider.enabled && provider.configured ? 'ok' : provider.configured ? 'warn' : 'muted'} />
                {provider.provider}
                <span className="text-[10px] text-muted-foreground">
                  {provider.configured ? (provider.enabled ? t('DASHBOARD_POOL_ON') : t('DASHBOARD_POOL_OFF')) : t('DASHBOARD_NO_KEY')}
                </span>
              </span>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

export function MiscPanel({
  pool,
  hardware,
  poolState,
  hardwareState,
}: {
  pool: PoolStatusSummary | undefined;
  hardware: HardwareSummary | undefined;
  poolState: LoadState;
  hardwareState: LoadState;
}) {
  const { t } = useTranslation();
  const node = pool?.localNode;
  // Two sources, one table. It renders only when both have arrived, because half a
  // details table with dashes in the other half is indistinguishable from real absence.
  const state: LoadState = {
    pending: poolState.pending || hardwareState.pending,
    failed: poolState.failed || hardwareState.failed,
  };

  const rows: { label: string; value: string; tone?: Tone }[] = [
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
      value: hardware?.gpu?.available ? `${hardware.gpu.vendor ?? ''} ${hardware.gpu.model ?? ''}`.trim() || DASH : t('DASHBOARD_NONE'),
      tone: hardware?.gpu?.available ? 'ok' : 'muted',
    },
    {
      label: t('DASHBOARD_MISC_GPU_RUNTIME'),
      value: hardware?.gpu?.runtimeAvailable ? t('DASHBOARD_AVAILABLE') : t('DASHBOARD_UNAVAILABLE'),
      tone: hardware?.gpu?.runtimeAvailable ? 'ok' : 'warn',
    },
    {
      label: t('DASHBOARD_MISC_NPU'),
      value: hardware?.npu?.available ? (hardware.npu.model ?? t('DASHBOARD_AVAILABLE')) : t('DASHBOARD_NONE'),
      tone: hardware?.npu?.available ? 'ok' : 'muted',
    },
  ];

  return (
    <Panel title={t('DASHBOARD_MISC_TITLE')}>
      <PanelBody state={state} error={t('DASHBOARD_MISC_FAILED')} lines={5}>
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
              <Td
                className={row.tone === 'ok' ? 'text-success' : row.tone === 'bad' ? 'text-destructive' : row.tone === 'warn' ? 'text-warning' : ''}
              >
                <span className="font-mono text-[11px]">{row.value}</span>
              </Td>
            </Tr>
          ))}
        </KpiTable>
        {node?.capabilitiesError ? (
          <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">{node.capabilitiesError}</p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
