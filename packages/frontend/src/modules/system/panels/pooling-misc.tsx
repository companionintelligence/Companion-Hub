import { DASH, KpiTable, Panel, PanelBody, StatChip, StatChipRow, StatusDot, Td, Th, type Tone, Tr } from '@/components/ui/dense/dense';
import type { CloudProviderSummary, HardwareSummary, LoadState, PoolDirectionState, PoolStatusSummary } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * AI POOLING AND MISC — the settings that decide routing, and this node's own identity.
 *
 * Where requests actually went is the Pool activity panel's job. What is left here is the
 * configuration behind those decisions: the two direction switches and what is holding either
 * off, the ranking weights, and the pins that silently stop applying when their target goes.
 */

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
          <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-[11px]">
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
        {stalePins.length > 0 ? <p className="pt-1 text-[11px] text-warning">{t('DASHBOARD_PINS_INACTIVE', { total: stalePins.length })}</p> : null}
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
          <p className="py-3 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_CLOUD_EMPTY')}</p>
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
                <span className="text-[11px] text-muted-foreground">
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
              <Td className="w-[42%] text-[11px] uppercase tracking-[0.5px] text-muted-foreground">{row.label}</Td>
              <Td
                className={row.tone === 'ok' ? 'text-success' : row.tone === 'bad' ? 'text-destructive' : row.tone === 'warn' ? 'text-warning' : ''}
              >
                <span className="font-mono text-[12px]">{row.value}</span>
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
