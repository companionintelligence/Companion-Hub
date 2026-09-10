import { DASH, KpiTable, MeterBar, Panel, PanelBody, StatChip, StatChipRow, TableEmpty, Td, Th, Tr } from '@/components/ui/dense/dense';
import { type LoadState, poolModelIndex, type PoolNodeSummary, type PoolPeerSummary, poolReach } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * NETWORK RESOURCES — what the rest of the pool is OFFERING this node, as capacity.
 *
 * Per-node state lives on the pool node cards; this section answers the question no per-node
 * view can, which is how the pool's capability overlaps. A model on three nodes survives one
 * going down, a model on one node is a single point of failure, and a model only a peer holds
 * is the reason to be pooled at all.
 *
 * Peers come from `/pool/status`, not `/pool/peers`: the status rows carry live
 * `inFlightRequests` and the effective `gpuPressure` band, and reading one endpoint means
 * the two halves of this section can never disagree mid-poll.
 */

export function NetworkOverview({
  peers,
  node,
  state,
  className,
}: {
  peers: PoolPeerSummary[];
  node: PoolNodeSummary | undefined;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const reach = poolReach(peers, node);

  return (
    <Panel title={t('DASHBOARD_NETWORK_OVERVIEW_TITLE')} density="compact" className={className}>
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={2}>
        <StatChipRow>
          <StatChip value={reach.connected} label={t('DASHBOARD_PEERS_CONNECTED')} tone={reach.connected > 0 ? 'ok' : 'muted'} />
          {reach.unreachable > 0 ? <StatChip value={reach.unreachable} label={t('DASHBOARD_PEERS_UNREACHABLE')} tone="bad" /> : null}
          <StatChip value={reach.reachableModels} label={t('DASHBOARD_REACHABLE_MODELS')} tone={reach.reachableModels > 0 ? 'ok' : 'muted'} />
          <StatChip
            value={reach.exclusiveModels}
            label={t('DASHBOARD_EXCLUSIVE_MODELS')}
            tone={reach.exclusiveModels > 0 ? 'ok' : 'muted'}
            hint={t('DASHBOARD_EXCLUSIVE_MODELS_HINT')}
            hintId="dashboard-exclusive-models"
          />
          {/* Dash, not 0: no peer reporting the counter means unknown, not idle. */}
          <StatChip value={reach.peerInFlight ?? DASH} label={t('DASHBOARD_PEER_IN_FLIGHT')} tone="muted" />
        </StatChipRow>
      </PanelBody>
    </Panel>
  );
}

/**
 * Which models the pool can serve, and from where.
 *
 * The genuinely new information on this page: a model on three nodes survives one going
 * down, a model on one node is a single point of failure, and a model only a peer has is
 * the reason to be pooled at all. None of that is visible from a per-node model list.
 */
export function NetworkModels({
  peers,
  node,
  localLabel,
  state,
  className,
}: {
  peers: PoolPeerSummary[];
  node: PoolNodeSummary | undefined;
  localLabel: string;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const index = poolModelIndex(node, peers, localLabel);
  const maxNodes = Math.max(1, ...index.map((row) => row.nodes.length));

  return (
    <Panel
      title={t('DASHBOARD_NETWORK_MODELS_TITLE')}
      density="compact"
      className={className}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{index.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={5}>
        <KpiTable
          className="max-h-80 overflow-y-auto"
          head={
            <>
              <Th>{t('DASHBOARD_COL_MODEL')}</Th>
              <Th align="right">{t('DASHBOARD_COL_NODES')}</Th>
              <Th>{t('DASHBOARD_COL_AVAILABLE_ON')}</Th>
              <Th className="hidden @lg:table-cell">{t('DASHBOARD_COL_ENGINE')}</Th>
            </>
          }
        >
          {index.length === 0 ? (
            <TableEmpty colSpan={4}>{t('DASHBOARD_NO_POOL_MODELS')}</TableEmpty>
          ) : (
            index.map((row) => (
              <Tr key={row.model}>
                <Td className="max-w-[92px] truncate font-mono @sm:max-w-[140px] @2xl:max-w-none" title={row.model}>
                  {row.model}
                </Td>
                <Td align="right">
                  <div className="flex items-center justify-end gap-1.5">
                    <span>{row.nodes.length}</span>
                    <MeterBar value={row.nodes.length} max={maxNodes} tone={row.nodes.length > 1 ? 'ok' : 'muted'} className="w-8 min-w-[20px]" />
                  </div>
                </Td>
                <Td className="max-w-[220px] truncate text-muted-foreground" title={row.nodes.join(', ')}>
                  {row.nodes.join(', ')}
                </Td>
                <Td className="hidden text-muted-foreground @lg:table-cell">{row.backends.join(', ')}</Td>
              </Tr>
            ))
          )}
        </KpiTable>
      </PanelBody>
    </Panel>
  );
}
