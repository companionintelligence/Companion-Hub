import {
  DASH,
  KpiTable,
  MeterBar,
  Panel,
  PanelBody,
  relativeAge,
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
  type LoadState,
  peerLabel,
  poolModelIndex,
  type PoolNodeSummary,
  type PoolPeerSummary,
  poolReach,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * NETWORK RESOURCES — what the rest of the pool is offering this node.
 *
 * A peer advertises its inference capability and nothing else. That single fact shapes the
 * whole section: models and engines are real, per-peer numbers, while container inventory
 * is not exchanged between Hubs at all — so that panel says so plainly rather than
 * rendering an empty table that would read as "the peers run no containers".
 *
 * Peers come from `/pool/status`, not `/pool/peers`: the status rows carry live
 * `inFlightRequests` and the effective `gpuPressure` band, and reading one endpoint means
 * the two halves of this section can never disagree mid-poll.
 */

function peerTone(peer: PoolPeerSummary): Tone {
  // A peer the operator switched off is not "connected" for any purpose that matters here:
  // routing will not use it. Showing it green because its socket is up would be a lie.
  if (peer.enabled === false) return 'muted';
  if (peer.status === 'connected') return 'ok';
  if (peer.status === 'pending') return 'warn';

  return 'bad';
}

export function NetworkOverview({ peers, node, state }: { peers: PoolPeerSummary[]; node: PoolNodeSummary | undefined; state: LoadState }) {
  const { t } = useTranslation();
  const reach = poolReach(peers, node);

  return (
    <Panel title={t('DASHBOARD_NETWORK_OVERVIEW_TITLE')}>
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
}: {
  peers: PoolPeerSummary[];
  node: PoolNodeSummary | undefined;
  localLabel: string;
  state: LoadState;
}) {
  const { t } = useTranslation();
  const index = poolModelIndex(node, peers, localLabel);
  const maxNodes = Math.max(1, ...index.map((row) => row.nodes.length));

  return (
    <Panel
      title={t('DASHBOARD_NETWORK_MODELS_TITLE')}
      actions={state.pending || state.failed ? null : <span className="text-[10px] text-muted-foreground">{index.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={5}>
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
      </PanelBody>
    </Panel>
  );
}

export function NetworkNodes({ peers, state }: { peers: PoolPeerSummary[]; state: LoadState }) {
  const { t } = useTranslation();
  const now = Date.now();
  const rows = [...peers].sort((a, b) => peerLabel(a).localeCompare(peerLabel(b)));

  return (
    <Panel
      title={t('DASHBOARD_NETWORK_NODES_TITLE')}
      actions={state.pending || state.failed ? null : <span className="text-[10px] text-muted-foreground">{rows.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={4}>
        <KpiTable
          head={
            <>
              <Th>{t('DASHBOARD_COL_NODE')}</Th>
              <Th>{t('DASHBOARD_COL_DIRECTION')}</Th>
              <Th>{t('DASHBOARD_COL_TIER')}</Th>
              <Th align="right">{t('DASHBOARD_COL_MODELS')}</Th>
              <Th align="right">{t('DASHBOARD_COL_IN_FLIGHT')}</Th>
              <Th align="right">{t('DASHBOARD_COL_PRESSURE')}</Th>
              <Th align="right">{t('DASHBOARD_COL_FAILURES')}</Th>
              <Th align="right">{t('DASHBOARD_COL_LAST_SEEN')}</Th>
            </>
          }
        >
          {rows.length === 0 ? (
            <TableEmpty colSpan={8}>{t('DASHBOARD_NO_PEERS')}</TableEmpty>
          ) : (
            rows.map((peer) => {
              const models = (peer.lastCapabilities?.backends ?? [])
                .filter((backend) => backend.healthy !== false)
                .reduce((sum, backend) => sum + (backend.modelsLoaded?.length ?? 0), 0);

              return (
                <Tr key={peer.id}>
                  <Td className="font-medium" title={peer.nodeFqdn ?? undefined}>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot tone={peerTone(peer)} />
                      {peerLabel(peer)}
                      {peer.enabled === false ? <span className="text-[10px] text-muted-foreground">({t('DASHBOARD_PEER_DISABLED')})</span> : null}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{peer.direction ?? DASH}</Td>
                  <Td className="text-muted-foreground">{peer.lastCapabilities?.hardwareTier ?? DASH}</Td>
                  {/* A peer that is not connected has only a cached model list; showing its
                      count would present stale capacity as live. */}
                  <Td align="right">{peer.status === 'connected' ? models : DASH}</Td>
                  {/* Dash, not 0, when the counter was never read — an idle peer and an
                      unread peer are different facts. Same for pressure below: a node that
                      cannot measure its GPU omits the field precisely so that absence and
                      "no load" do not share an encoding. */}
                  <Td align="right">{typeof peer.inFlightRequests === 'number' ? peer.inFlightRequests : DASH}</Td>
                  <Td align="right">{typeof peer.gpuPressure === 'number' ? peer.gpuPressure : DASH}</Td>
                  <Td align="right" className={peer.consecutiveFailures ? 'text-destructive' : undefined}>
                    {typeof peer.consecutiveFailures === 'number' ? peer.consecutiveFailures : DASH}
                  </Td>
                  <Td align="right" className="text-muted-foreground">
                    {relativeAge(peer.lastSeenAt, now)}
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

/**
 * Containers across the pool.
 *
 * There is no endpoint for this and no data to fetch. Hubs exchange exactly one payload,
 * `/inference/pool/capabilities`, and it carries inference capability only: hardware tier,
 * per-backend health, loaded model ids, queue depth. Nothing about containers crosses the
 * peer boundary, and what is cached locally in `lastCapabilities` is a verbatim copy of
 * that payload, so it cannot hold more.
 *
 * Rendering an empty table here would read as "the peers have no containers" — a claim no
 * peer ever made, and on a monitoring dashboard a confident wrong number is worse than no
 * number. So the panel names the limit, says what it would take to lift it, and points at
 * the one place the answer does exist: each peer's own dashboard.
 */
export function NetworkContainers({ peers, state }: { peers: PoolPeerSummary[]; state: LoadState }) {
  const { t } = useTranslation();
  const linkable = peers.filter((peer) => peer.status === 'connected' && peer.nodeFqdn);

  return (
    <Panel title={t('DASHBOARD_NETWORK_CONTAINERS_TITLE')}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('DASHBOARD_NETWORK_CONTAINERS_UNAVAILABLE')}</p>
      <p className="text-[10px] leading-relaxed text-muted-foreground/80">{t('DASHBOARD_NETWORK_CONTAINERS_WOULD_NEED')}</p>
      {/* The peer list is the only part of this panel that can fail, and it only decorates
          it — the explanation above is true whether or not the pool answered. */}
      {!state.pending && !state.failed && linkable.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {linkable.map((peer) => (
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
