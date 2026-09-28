import { DASH, Panel, PanelBody, relativeAge } from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import type { PoolNodeCard } from '@/modules/system/pool-node-series';
import { REACH_STATUSES, type ReachPeer, type ReachStatus, reachLayout, reachPeers } from '@/modules/system/pool-reach';
import type { LoadState, PoolReach as PoolReachFigures } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * POOL REACH — this Hub in the middle, one spoke per paired peer.
 *
 * It replaces a row of five count chips that answered "how many" and never "which". The question an
 * operator brings here is whether a node they know is in the pool is one THIS Hub can send work to;
 * a leaf paired with two hubs routes to those two and nowhere else, and a count of 3 does not say
 * which three. The counts survive as the legend under the drawing.
 *
 * A spoke's status is carried three ways — line pattern, marker shape and the word under the name —
 * so it survives colour blindness, a greyscale screenshot and a screen reader. The drawing is
 * `role="img"`, so the per-peer facts are repeated in a visually hidden list rather than trapped in
 * `<title>` tooltips that only a mouse can open.
 */

/** Stroke pattern per status. Connected is the only solid line: anything else is a spoke that may not carry work. */
const SPOKE_DASH: Record<ReachStatus, string | undefined> = {
  connected: undefined,
  unreachable: '5 4',
  pending: '1.5 3.5',
  disabled: '1 5',
};

/** Literal class names so Tailwind's scanner sees every one. */
const SPOKE_CLASS: Record<ReachStatus, string> = {
  connected: 'stroke-success/70',
  unreachable: 'stroke-destructive',
  pending: 'stroke-warning',
  disabled: 'stroke-muted-foreground/60',
};

const DETAIL_CLASS: Record<ReachStatus, string> = {
  connected: 'fill-muted-foreground',
  unreachable: 'fill-destructive',
  pending: 'fill-warning',
  disabled: 'fill-muted-foreground',
};

const STATUS_KEY: Record<ReachStatus, string> = {
  connected: 'DASHBOARD_REACH_STATUS_CONNECTED',
  unreachable: 'DASHBOARD_REACH_STATUS_UNREACHABLE',
  pending: 'DASHBOARD_REACH_STATUS_PENDING',
  disabled: 'DASHBOARD_REACH_STATUS_DISABLED',
};

const NAME_MAX = 14;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Marker per status: filled dot, hollow dot with a cross, dashed hollow dot, hollow square. Shape, not only hue. */
function Marker({ status, x, y }: { status: ReachStatus; x: number; y: number }) {
  if (status === 'connected') return <circle cx={x} cy={y} r={5.5} className="fill-success stroke-card" strokeWidth={2} />;
  if (status === 'unreachable') {
    return (
      <g className="stroke-destructive" strokeWidth={1.6}>
        <circle cx={x} cy={y} r={5.5} className="fill-card" />
        <path d={`M ${x - 2.6} ${y - 2.6} L ${x + 2.6} ${y + 2.6} M ${x + 2.6} ${y - 2.6} L ${x - 2.6} ${y + 2.6}`} fill="none" />
      </g>
    );
  }
  if (status === 'pending') return <circle cx={x} cy={y} r={5.5} className="fill-card stroke-warning" strokeWidth={1.6} strokeDasharray="2 1.6" />;

  return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} rx={1.5} className="fill-card stroke-muted-foreground" strokeWidth={1.4} />;
}

/** A spoke's pattern drawn at legend size, so the legend is a key to the drawing and not a second vocabulary. */
function LegendSwatch({ status }: { status: ReachStatus }) {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2="13"
        y2="5"
        className={SPOKE_CLASS[status]}
        strokeWidth={1.8}
        strokeDasharray={SPOKE_DASH[status]}
        strokeLinecap="round"
      />
      <Marker status={status} x={16.5} y={5} />
    </svg>
  );
}

export function PoolReach({
  cards,
  figures,
  state,
  className,
}: {
  /** `poolNodeCards` as the page built it, so model counts here are the Pool nodes table's own. */
  cards: PoolNodeCard[];
  /** `poolReach` as the page built it — the rail reads the same object. */
  figures: PoolReachFigures;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = Date.now();
  const hubCard = cards.find((card) => card.local);
  // Not memoised: `poolNodeCards` builds a new array every render, so a memo here would never hit.
  const layout = reachLayout(reachPeers(cards));
  const hubName = hubCard?.fqdn?.split('.')[0] || t('DASHBOARD_THIS_HUB');

  const statusWord = (status: ReachStatus) => t(STATUS_KEY[status]);

  /** The line under a peer's name: what it offers when connected, otherwise why it does not. */
  const detail = (peer: ReachPeer): string => {
    if (peer.status === 'connected') {
      const models = peer.models === null ? t('DASHBOARD_REACH_MODELS_UNREPORTED') : t('DASHBOARD_REACH_MODELS', { count: peer.models });
      return peer.tier ? `${models} · ${peer.tier}` : models;
    }
    if (peer.status === 'pending') {
      // Which side owes the next step is the one thing an operator can act on from here.
      return peer.direction === 'inbound' ? t('DASHBOARD_REACH_PENDING_OURS') : t('DASHBOARD_REACH_PENDING_THEIRS');
    }
    if (peer.status === 'unreachable' && peer.lastSeenAt) return `${statusWord(peer.status)} · ${relativeAge(peer.lastSeenAt, now)}`;

    return statusWord(peer.status);
  };

  /** Everything known about one peer, for its tooltip and its line in the hidden list. */
  const describe = (peer: ReachPeer): string =>
    [
      peer.alias ? `${peer.name} (${peer.alias})` : peer.name,
      statusWord(peer.status),
      peer.status === 'connected' ? detail(peer) : null,
      peer.lastSeenAt ? t('DASHBOARD_NODE_LAST_SEEN', { age: relativeAge(peer.lastSeenAt, now) }) : t('DASHBOARD_REACH_NEVER_SEEN'),
      peer.direction === 'outbound' ? t('DASHBOARD_REACH_PAIRED_HERE') : peer.direction === 'inbound' ? t('DASHBOARD_REACH_PAIRED_THERE') : null,
      peer.authMode ? t('DASHBOARD_REACH_AUTH', { mode: peer.authMode }) : null,
      (peer.inFlight ?? 0) > 0 ? t('DASHBOARD_REACH_IN_FLIGHT', { count: peer.inFlight }) : null,
      peer.probeFailure ? t('DASHBOARD_REACH_PROBE_FAILING', { kind: peer.probeFailure }) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const summary = REACH_STATUSES.filter((status) => layout.counts[status] > 0)
    .map((status) => `${layout.counts[status]} ${statusWord(status)}`)
    .join(', ');
  const hubDetail =
    hubCard && hubCard.models !== null
      ? [t('DASHBOARD_REACH_MODELS', { count: hubCard.models }), hubCard.hardwareTier].filter(Boolean).join(' · ')
      : null;
  const { hub } = layout;

  return (
    <Panel title={t('DASHBOARD_REACH_TITLE')} density="compact" className={className}>
      {/* Outside PanelBody: it is true whatever the query did, and it is the question the panel answers. */}
      <p className="text-[11px] leading-snug text-muted-foreground">{t('DASHBOARD_REACH_CAPTION')}</p>
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={6}>
        {layout.peers.length === 0 ? (
          <p data-testid="pool-reach-empty" className="py-5 text-center text-[13px] italic text-muted-foreground">
            {t('DASHBOARD_REACH_EMPTY')}
          </p>
        ) : (
          <>
            <svg
              data-testid="pool-reach-graph"
              role="img"
              aria-label={t('DASHBOARD_REACH_ARIA', { count: layout.peers.length, hub: hubName, summary })}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="block h-auto w-full"
            >
              <g fill="none" strokeLinecap="round">
                {layout.placed.map((peer) => (
                  <line
                    key={peer.key}
                    data-status={peer.status}
                    x1={hub.x}
                    y1={hub.y}
                    x2={peer.x}
                    y2={peer.y}
                    className={SPOKE_CLASS[peer.status]}
                    strokeWidth={1.5}
                    strokeDasharray={SPOKE_DASH[peer.status]}
                  />
                ))}
                {layout.overflow ? (
                  <line x1={hub.x} y1={hub.y} x2={layout.overflow.x} y2={layout.overflow.y} className="stroke-muted-foreground/40" strokeWidth={1} />
                ) : null}
              </g>

              {layout.placed.map((peer) => {
                const outward = peer.side === 'right' ? 1 : -1;
                const anchor = peer.side === 'right' ? 'start' : 'end';
                const inFlight = peer.inFlight ?? 0;

                return (
                  <g key={peer.key} data-testid="pool-reach-peer" data-peer={peer.name} data-status={peer.status}>
                    <title>{describe(peer)}</title>
                    <Marker status={peer.status} x={peer.x} y={peer.y} />
                    <text x={peer.x + outward * 10} y={peer.y - 1.5} textAnchor={anchor} className="fill-foreground text-[12px] font-semibold">
                      {clip(peer.name, NAME_MAX)}
                    </text>
                    <text x={peer.x + outward * 10} y={peer.y + 10.5} textAnchor={anchor} className={cn('text-[10px]', DETAIL_CLASS[peer.status])}>
                      {detail(peer)}
                    </text>
                    {inFlight > 0 ? (
                      // On the spoke, just inside the marker: work WE forwarded there, not the peer's own load.
                      <g data-testid="pool-reach-in-flight">
                        <circle cx={peer.x - outward * 13} cy={peer.y - 8} r={6.5} className="fill-primary" />
                        <text
                          x={peer.x - outward * 13}
                          y={peer.y - 5}
                          textAnchor="middle"
                          className="fill-primary-foreground text-[9px] font-bold tabular-nums"
                        >
                          {inFlight > 99 ? '99+' : inFlight}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })}

              {layout.overflow ? (
                <g data-testid="pool-reach-overflow">
                  <title>{t('DASHBOARD_REACH_MORE_HINT', { names: layout.overflow.peers.map((peer) => peer.name).join(', ') })}</title>
                  <circle cx={layout.overflow.x} cy={layout.overflow.y} r={5.5} className="fill-card stroke-muted-foreground" strokeWidth={1.2} />
                  <text
                    x={layout.overflow.x + (layout.overflow.side === 'right' ? 10 : -10)}
                    y={layout.overflow.y + 4}
                    textAnchor={layout.overflow.side === 'right' ? 'start' : 'end'}
                    className="fill-muted-foreground text-[11px] font-semibold"
                  >
                    {t('DASHBOARD_REACH_MORE', { count: layout.overflow.peers.length })}
                  </text>
                </g>
              ) : null}

              {/* The hub last, so every spoke starts under it. */}
              <g data-testid="pool-reach-hub">
                <title>{[t('DASHBOARD_THIS_HUB'), hubName, hubDetail].filter(Boolean).join(' · ')}</title>
                <circle cx={hub.x} cy={hub.y} r={25} className="fill-card stroke-primary" strokeWidth={2} />
                <circle cx={hub.x} cy={hub.y} r={25} className="fill-primary/10" />
                <text x={hub.x} y={hub.y - 1} textAnchor="middle" className="fill-foreground text-[11px] font-bold">
                  {clip(hubName, 9)}
                </text>
                <text x={hub.x} y={hub.y + 10} textAnchor="middle" className="fill-muted-foreground text-[8.5px] uppercase tracking-[0.5px]">
                  {t('DASHBOARD_REACH_HUB')}
                </text>
              </g>
            </svg>

            <ul className="sr-only" data-testid="pool-reach-list">
              {layout.peers.map((peer) => (
                <li key={peer.key}>{describe(peer)}</li>
              ))}
            </ul>

            {/* The old chip row's facts, kept as the key to the drawing. */}
            <div
              data-testid="pool-reach-legend"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-1.5 text-[11px] text-muted-foreground"
            >
              {REACH_STATUSES.filter((status) => status === 'connected' || layout.counts[status] > 0).map((status) => (
                <span key={status} className="inline-flex items-center gap-1">
                  <LegendSwatch status={status} />
                  <span className="font-medium tabular-nums text-foreground">{layout.counts[status]}</span>
                  {statusWord(status)}
                </span>
              ))}
              <span>
                <span className="font-medium tabular-nums text-foreground">{figures.reachableModels}</span> {t('DASHBOARD_REACH_MODELS_REACHABLE')}
              </span>
              <span title={t('DASHBOARD_EXCLUSIVE_MODELS_HINT')} className="cursor-help underline decoration-dotted underline-offset-2">
                <span className="font-medium tabular-nums text-foreground">{figures.exclusiveModels}</span> {t('DASHBOARD_REACH_PEER_ONLY')}
              </span>
              {/* A dash, not 0: no connected peer reporting the counter is unknown, not idle. */}
              <span>
                <span className="font-medium tabular-nums text-foreground">{figures.peerInFlight ?? DASH}</span> {t('DASHBOARD_REACH_FORWARDED')}
              </span>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
