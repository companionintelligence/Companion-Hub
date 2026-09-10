import { DASH, KpiTable, MeterBar, Panel, relativeAge, StatChip, StatChipRow, StatusDot, TableEmpty, Td, Th, Tr } from '@/components/ui/dense/dense';
import { peerLabel, poolModelIndex, type PoolNodeSummary, type PoolPeerSummary } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * NETWORK RESOURCES — what the rest of the pool is offering this node.
 *
 * A peer advertises its inference capabilities and nothing else. That shapes this
 * section: models and engines are real, per-peer numbers; container inventory is NOT
 * exchanged between Hubs at all, so the containers panel says so plainly instead of
 * rendering an empty table that reads as "no containers over there".
 */

function tone(peer: PoolPeerSummary) {
  if (peer.status === 'connected') return peer.enabled === false ? 'muted' : 'ok';
  if (peer.status === 'pending') return 'warn';

  return 'bad';
}

export function NetworkOverview({ peers, node }: { peers: PoolPeerSummary[]; node: PoolNodeSummary | undefined }) {
  const { t } = useTranslation();
  const connected = peers.filter((peer) => peer.status === 'connected');
  const unreachable = peers.filter((peer) => peer.status === 'unreachable');
  const reachableModels = new Set(
    connected.flatMap((peer) => (peer.lastCapabilities?.backends ?? []).flatMap((backend) => backend.modelsLoaded ?? [])),
  );
  const localModels = new Set((node?.backends ?? []).flatMap((backend) => backend.modelsLoaded ?? []));
  // Models only a peer has. This is the number that says what pooling actually buys
  // this node — everything else is capacity it already had.
  const exclusive = [...reachableModels].filter((model) => !localModels.has(model));

  return (
    <Panel title={t('DASHBOARD_NETWORK_OVERVIEW_TITLE')}>
      <StatChipRow>
        <StatChip value={connected.length} label={t('DASHBOARD_PEERS_CONNECTED')} tone={connected.length > 0 ? 'ok' : 'muted'} />
        {unreachable.length > 0 ? <StatChip value={unreachable.length} label={t('DASHBOARD_PEERS_UNREACHABLE')} tone="bad" /> : null}
        <StatChip value={reachableModels.size} label={t('DASHBOARD_REACHABLE_MODELS')} tone={reachableModels.size > 0 ? 'ok' : 'muted'} />
        <StatChip
          value={exclusive.length}
          label={t('DASHBOARD_EXCLUSIVE_MODELS')}
          tone={exclusive.length > 0 ? 'ok' : 'muted'}
          hint={t('DASHBOARD_EXCLUSIVE_MODELS_HINT')}
          hintId="dashboard-exclusive-models"
        />
        <StatChip value={connected.reduce((sum, peer) => sum + (peer.inFlightRequests ?? 0), 0)} label={t('DASHBOARD_PEER_IN_FLIGHT')} tone="muted" />
      </StatChipRow>
    </Panel>
  );
}

export function NetworkModels({ peers, node, localLabel }: { peers: PoolPeerSummary[]; node: PoolNodeSummary | undefined; localLabel: string }) {
  const { t } = useTranslation();
  const index = poolModelIndex(node, peers, localLabel);
  const maxNodes = Math.max(1, ...index.map((row) => row.nodes.length));

  return (
    <Panel title={t('DASHBOARD_NETWORK_MODELS_TITLE')} actions={<span className="text-[10px] text-muted-foreground">{index.length}</span>}>
      <KpiTable
        className="max-h-80 overflow-y-auto"
        head={
          <>
            <Th>{t('DASHBOARD_COL_MODEL')}</Th>
            <Th align="right">{t('DASHBOARD_COL_NODES')}</Th>
            <Th>{t('DASHBOARD_COL_AVAILABLE_ON')}</Th>
            <Th>{t('DASHBOARD_COL_ENGINE')}</Th>
          </>
        }
      >
        {index.length === 0 ? (
          <TableEmpty colSpan={4}>{t('DASHBOARD_NO_POOL_MODELS')}</TableEmpty>
        ) : (
          index.map((row) => (
            <Tr key={row.model}>
              <Td className="font-mono" title={row.model}>
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
              <Td className="text-muted-foreground">{row.backends.join(', ')}</Td>
            </Tr>
          ))
        )}
      </KpiTable>
    </Panel>
  );
}

export function NetworkNodes({ peers }: { peers: PoolPeerSummary[] }) {
  const { t } = useTranslation();
  const now = Date.now();
  const rows = [...peers].sort((a, b) => peerLabel(a).localeCompare(peerLabel(b)));

  return (
    <Panel title={t('DASHBOARD_NETWORK_NODES_TITLE')} actions={<span className="text-[10px] text-muted-foreground">{rows.length}</span>}>
      <KpiTable
        head={
          <>
            <Th>{t('DASHBOARD_COL_NODE')}</Th>
            <Th>{t('DASHBOARD_COL_DIRECTION')}</Th>
            <Th>{t('DASHBOARD_COL_TIER')}</Th>
            <Th align="right">{t('DASHBOARD_COL_MODELS')}</Th>
            <Th align="right">{t('DASHBOARD_COL_IN_FLIGHT')}</Th>
            <Th align="right">{t('DASHBOARD_COL_FAILURES')}</Th>
            <Th align="right">{t('DASHBOARD_COL_LAST_SEEN')}</Th>
          </>
        }
      >
        {rows.length === 0 ? (
          <TableEmpty colSpan={7}>{t('DASHBOARD_NO_PEERS')}</TableEmpty>
        ) : (
          rows.map((peer) => {
            const models = (peer.lastCapabilities?.backends ?? []).reduce((sum, backend) => sum + (backend.modelsLoaded?.length ?? 0), 0);

            return (
              <Tr key={peer.id}>
                <Td className="font-medium" title={peer.nodeFqdn ?? undefined}>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={tone(peer)} />
                    {peerLabel(peer)}
                  </span>
                </Td>
                <Td className="text-muted-foreground">{peer.direction ?? DASH}</Td>
                <Td className="text-muted-foreground">{peer.lastCapabilities?.hardwareTier ?? DASH}</Td>
                <Td align="right">{peer.status === 'connected' ? models : DASH}</Td>
                {/* Dash, not 0, when the counter was never read — an idle peer and an
                    unread peer are different facts. */}
                <Td align="right">{typeof peer.inFlightRequests === 'number' ? peer.inFlightRequests : DASH}</Td>
                <Td align="right" className={peer.consecutiveFailures ? 'text-destructive' : undefined}>
                  {peer.consecutiveFailures ?? 0}
                </Td>
                <Td align="right" className="text-muted-foreground">
                  {relativeAge(peer.lastSeenAt, now)}
                </Td>
              </Tr>
            );
          })
        )}
      </KpiTable>
    </Panel>
  );
}

/**
 * Containers across the pool.
 *
 * There is no endpoint for this and there is no data to fetch: a Hub advertises its
 * inference capabilities to peers (`lastCapabilities`) and nothing about its
 * containers. Rendering an empty table here would read as "the peers have no
 * containers", which is false and worse than saying nothing. So this panel names the
 * limit and points at the per-node page that does have the answer.
 */
export function NetworkContainers({ peers }: { peers: PoolPeerSummary[] }) {
  const { t } = useTranslation();
  const connected = peers.filter((peer) => peer.status === 'connected');

  return (
    <Panel title={t('DASHBOARD_NETWORK_CONTAINERS_TITLE')}>
      <p className="py-3 text-center text-xs italic text-muted-foreground">{t('DASHBOARD_NETWORK_CONTAINERS_UNAVAILABLE')}</p>
      {connected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {connected.map((peer) => (
            <a
              key={peer.id}
              href={`https://${peer.nodeFqdn}/resource-monitor`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border bg-muted/20 px-2 py-1 text-[11px] hover:border-primary"
            >
              {peerLabel(peer)} ↗
            </a>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
