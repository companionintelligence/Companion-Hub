import { DASH, Panel, PanelBody, relativeAge } from '@/components/ui/dense/dense';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { cn } from '@/lib/utils';
import type { PoolNodeCard } from '@/modules/system/pool-node-series';
import {
  badgeCentre,
  fitFirst,
  fitText,
  type PlacedPeer,
  REACH_HUB_R,
  REACH_LABEL_GAP,
  REACH_STATUSES,
  REACH_WIDTH,
  type ReachConcern,
  type ReachPeer,
  type ReachStatus,
  reachLayout,
  reachPeers,
  textWidth,
} from '@/modules/system/pool-reach';
import type { LoadState, PoolReach as PoolReachFigures } from '@/modules/system/use-dashboard-data';
import { useLayoutEffect, useState } from 'react';
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
 * so it survives colour blindness, a greyscale screenshot and a screen reader. Only a spoke that can
 * carry work right now is solid: a connected peer the proxy skips (no snapshot, or it declined work)
 * and every spoke of a Hub whose own routing is switched off are drawn broken, because a solid green
 * line to a node that gets nothing is the drawing lying.
 *
 * The drawing is `role="img"`, and neither a keyboard nor a touch screen can open an SVG `<title>`,
 * so every per-peer fact is repeated in a native disclosure under the legend that both can.
 */

/** Stroke pattern per status. Connected is the only solid line: anything else is a spoke that may not carry work. */
const SPOKE_DASH: Record<ReachStatus, string | undefined> = {
  connected: undefined,
  unreachable: '5 4',
  pending: '1.5 3.5',
  disabled: '1 5',
};

/** A connected spoke the proxy will not use: long dashes, unlike any status's pattern. */
const HELD_DASH = '8 3';

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

/** The probe failure kinds `hub-pool-probe-failure.ts` writes, as a few words each. */
const PROBE_KEY: Record<string, string> = {
  unreachable: 'DASHBOARD_REACH_PROBE_UNREACHABLE',
  unauthorized: 'DASHBOARD_REACH_PROBE_UNAUTHORIZED',
  identity_changed: 'DASHBOARD_REACH_PROBE_IDENTITY',
};

/** Why a spoke is not drawn as carrying work, when the reason is the Hub's and not the peer's. */
export type ReachRoutingOff = 'pool' | 'outbound' | null;

/** Name line and detail line sizes, in px. The page's floor for any text is 10px. */
const NAME_PX = 12;
const DETAIL_PX = 10;
const BADGE_PX = 10;

/**
 * The width the drawing is actually rendered at, so it can be laid out at one unit per pixel.
 * A callback ref rather than an object ref: the drawing mounts only after the pool query answers,
 * well after this component does, and an effect keyed on an object ref would never see it arrive.
 */
function useRenderedWidth(): [number, (node: HTMLDivElement | null) => void] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(REACH_WIDTH);

  useLayoutEffect(() => {
    if (!node) return;
    // Whole pixels: a sub-pixel jitter from the scrollbar would otherwise re-lay out on every frame.
    const read = () => {
      const measured = Math.round(node.getBoundingClientRect().width);
      if (measured > 0) setWidth(Math.max(260, measured));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);

    return () => observer.disconnect();
  }, [node]);

  return [width, setNode];
}

/** Marker per status: filled dot, hollow dot with a cross, dashed hollow dot, hollow square — and a warning triangle for a concern. */
function Marker({ status, concern, x, y }: { status: ReachStatus; concern: ReachConcern | null; x: number; y: number }) {
  if (concern !== null) {
    return (
      <polygon
        points={`${x},${y - 6} ${x + 6},${y + 4.5} ${x - 6},${y + 4.5}`}
        className="fill-warning stroke-card"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    );
  }
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
function LegendSwatch({ status, concern = null }: { status: ReachStatus; concern?: ReachConcern | null }) {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="6"
        x2="13"
        y2="6"
        className={concern ? 'stroke-warning' : SPOKE_CLASS[status]}
        strokeWidth={1.8}
        strokeDasharray={concern ? HELD_DASH : SPOKE_DASH[status]}
        strokeLinecap="round"
      />
      <Marker status={status} concern={concern} x={16.5} y={6} />
    </svg>
  );
}

/** The in-flight badge: a pill that grows with its number, so "99+" stays inside it. */
function Badge({ x, y, label }: { x: number; y: number; label: string }) {
  const width = Math.max(14, textWidth(label, BADGE_PX, 700) + 7);

  return (
    <>
      <rect x={x - width / 2} y={y - 7} width={width} height={14} rx={7} className="fill-primary stroke-card" strokeWidth={1.5} />
      <text x={x} y={y + 3.5} textAnchor="middle" className="fill-primary-foreground text-[10px] font-bold tabular-nums">
        {label}
      </text>
    </>
  );
}

export function PoolReach({
  cards,
  figures,
  routingOff = null,
  state,
  className,
}: {
  /** `poolNodeCards` as the page built it, so model counts and names here are the Pool nodes table's own. */
  cards: PoolNodeCard[];
  /** `poolReach` as the page built it — the rail reads the same object. */
  figures: PoolReachFigures;
  /** Set when this Hub routes to none of its peers whatever their state: pooling off, or outbound off. */
  routingOff?: ReachRoutingOff;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const [width, measure] = useRenderedWidth();
  const now = Date.now();
  const hubCard = cards.find((card) => card.local);
  // Not memoised: `poolNodeCards` builds a new array every render, so a memo here would never hit.
  const layout = reachLayout(reachPeers(cards), { width });
  const hubName = hubCard?.fqdn?.split('.')[0] || t('DASHBOARD_THIS_HUB');

  const statusWord = (status: ReachStatus) => t(STATUS_KEY[status]);
  const probeWord = (kind: string) => t(PROBE_KEY[kind] ?? 'DASHBOARD_REACH_PROBE_OTHER');
  const modelsWord = (peer: ReachPeer) =>
    peer.models === null ? t('DASHBOARD_REACH_MODELS_UNREPORTED') : t('DASHBOARD_REACH_MODELS', { count: peer.models });

  /**
   * What the line under a peer's name can say, longest first: `fitFirst` keeps the first that fits
   * the slot whole. A concern replaces the model count, because it is the reason the count is
   * missing or does not matter.
   */
  const detailOptions = (peer: ReachPeer): string[] => {
    if (peer.concern === 'unreported') return [peer.probeFailure ? probeWord(peer.probeFailure) : t('DASHBOARD_REACH_MODELS_UNREPORTED')];
    if (peer.concern === 'declining') return [t('DASHBOARD_REACH_DECLINING')];
    if (peer.concern === 'probe') return [probeWord(peer.probeFailure ?? '')];
    if (peer.status === 'connected') {
      const models = modelsWord(peer);
      return peer.tier ? [`${models} · ${peer.tier}`, models] : [models];
    }
    // Which side owes the next step is the one thing an operator can act on from here.
    if (peer.status === 'pending') return [peer.direction === 'inbound' ? t('DASHBOARD_REACH_PENDING_OURS') : t('DASHBOARD_REACH_PENDING_THEIRS')];
    if (peer.status === 'unreachable' && peer.lastSeenAt) {
      return [`${statusWord(peer.status)} · ${relativeAge(peer.lastSeenAt, now)}`, statusWord(peer.status)];
    }

    return [statusWord(peer.status)];
  };

  /** Everything known about one peer, for its tooltip and its line in the details list. */
  const describe = (peer: ReachPeer): string =>
    [
      peer.host ? `${peer.name} (${peer.host})` : peer.name,
      statusWord(peer.status),
      // A peer declining work sends an empty inventory on purpose; "0 models" there would read as a
      // machine with nothing loaded, when it is one keeping what it has to itself.
      peer.concern === 'declining'
        ? t('DASHBOARD_REACH_DECLINING')
        : peer.status === 'connected'
          ? peer.tier
            ? `${modelsWord(peer)} · ${peer.tier}`
            : modelsWord(peer)
          : null,
      peer.lastSeenAt ? t('DASHBOARD_NODE_LAST_SEEN', { age: relativeAge(peer.lastSeenAt, now) }) : t('DASHBOARD_REACH_NEVER_SEEN'),
      peer.direction === 'outbound' ? t('DASHBOARD_REACH_PAIRED_HERE') : peer.direction === 'inbound' ? t('DASHBOARD_REACH_PAIRED_THERE') : null,
      peer.authMode ? t('DASHBOARD_REACH_AUTH', { mode: peer.authMode }) : null,
      (peer.inFlight ?? 0) > 0 ? t('DASHBOARD_REACH_IN_FLIGHT', { count: peer.inFlight }) : null,
      peer.probeFailure ? probeWord(peer.probeFailure) : null,
    ]
      .filter(Boolean)
      .join(' · ');

  /** The spoke's pattern and colour: the status's own, unless no work can travel it. */
  const spokeStyle = (peer: ReachPeer): { className: string; dash: string | undefined } => {
    if (routingOff) return { className: 'stroke-muted-foreground/50', dash: SPOKE_DASH[peer.status] ?? HELD_DASH };
    if (peer.concern === 'unreported' || peer.concern === 'declining') return { className: 'stroke-warning', dash: HELD_DASH };
    if (peer.concern === 'probe') return { className: 'stroke-warning', dash: undefined };

    return { className: SPOKE_CLASS[peer.status], dash: SPOKE_DASH[peer.status] };
  };

  /** The name, and the tailnet host after it in a quieter face when both fit the slot whole. */
  const nameLine = (peer: PlacedPeer) => {
    const host = peer.host ? ` ${peer.host}` : '';
    const both = textWidth(peer.name, NAME_PX, 600) + textWidth(host, DETAIL_PX) <= peer.room;

    return (
      <>
        {both ? peer.name : fitText(peer.name, peer.room, NAME_PX, 600)}
        {both && host ? <tspan className="fill-muted-foreground text-[10px] font-normal">{host}</tspan> : null}
      </>
    );
  };

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
            {routingOff ? (
              <p data-testid="pool-reach-routing-off" className="text-[11px] leading-snug text-warning">
                {routingOff === 'pool' ? t('DASHBOARD_REACH_OFF_POOL') : t('DASHBOARD_REACH_OFF_OUTBOUND')}
              </p>
            ) : null}
            <div ref={measure} className="w-full min-w-0">
              <svg
                data-testid="pool-reach-graph"
                role="img"
                aria-label={t('DASHBOARD_REACH_ARIA', { count: layout.peers.length, hub: hubName, summary })}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                // Visible overflow: a label is fitted to its slot in Manrope, and if the font has not
                // arrived yet the few pixels a wider fallback adds land in the panel's padding, not cut.
                className="block h-auto w-full overflow-visible"
              >
                <g fill="none" strokeLinecap="round">
                  {layout.placed.map((peer) => {
                    const spoke = spokeStyle(peer);

                    return (
                      <line
                        key={peer.key}
                        data-spoke={peer.name}
                        data-status={peer.status}
                        data-concern={peer.concern ?? undefined}
                        x1={hub.x}
                        y1={hub.y}
                        x2={peer.x}
                        y2={peer.y}
                        className={spoke.className}
                        strokeWidth={1.5}
                        strokeDasharray={spoke.dash}
                      />
                    );
                  })}
                  {layout.overflow ? (
                    <line
                      x1={hub.x}
                      y1={hub.y}
                      x2={layout.overflow.x}
                      y2={layout.overflow.y}
                      className="stroke-muted-foreground/40"
                      strokeWidth={1}
                    />
                  ) : null}
                </g>

                {layout.placed.map((peer) => {
                  const outward = peer.side === 'right' ? 1 : -1;
                  const anchor = peer.side === 'right' ? 'start' : 'end';
                  const inFlight = peer.inFlight ?? 0;
                  const labelX = peer.x + outward * REACH_LABEL_GAP;
                  const badge = badgeCentre(peer, hub);

                  return (
                    <g
                      key={peer.key}
                      data-testid="pool-reach-peer"
                      data-peer={peer.name}
                      data-status={peer.status}
                      data-concern={peer.concern ?? undefined}
                    >
                      <title>{describe(peer)}</title>
                      <Marker status={peer.status} concern={peer.concern} x={peer.x} y={peer.y} />
                      <text x={labelX} y={peer.y - 2} textAnchor={anchor} className="fill-foreground text-[12px] font-semibold">
                        {nameLine(peer)}
                      </text>
                      <text
                        x={labelX}
                        y={peer.y + 12}
                        textAnchor={anchor}
                        className={cn('text-[10px]', peer.concern ? 'fill-warning' : DETAIL_CLASS[peer.status])}
                      >
                        {fitFirst(detailOptions(peer), peer.room, DETAIL_PX)}
                      </text>
                      {inFlight > 0 ? (
                        // On the peer's own spoke, just inside its marker: work WE forwarded there, not the peer's own load.
                        <g data-testid="pool-reach-in-flight">
                          <Badge x={badge.x} y={badge.y} label={inFlight > 99 ? '99+' : String(inFlight)} />
                        </g>
                      ) : null}
                    </g>
                  );
                })}

                {layout.overflow ? (
                  <g data-testid="pool-reach-overflow">
                    <title>
                      {t('DASHBOARD_REACH_MORE_HINT', {
                        names: layout.overflow.peers.map((peer) => `${peer.name} (${statusWord(peer.status)})`).join(', '),
                      })}
                    </title>
                    <circle cx={layout.overflow.x} cy={layout.overflow.y} r={5.5} className="fill-card stroke-muted-foreground" strokeWidth={1.2} />
                    <text
                      x={layout.overflow.x + (layout.overflow.side === 'right' ? REACH_LABEL_GAP : -REACH_LABEL_GAP)}
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
                  <circle cx={hub.x} cy={hub.y} r={REACH_HUB_R} className="fill-card stroke-primary" strokeWidth={2} />
                  <circle cx={hub.x} cy={hub.y} r={REACH_HUB_R} className="fill-primary/10" />
                  <text x={hub.x} y={hub.y - 2} textAnchor="middle" className="fill-foreground text-[11px] font-bold">
                    {fitText(hubName, REACH_HUB_R * 2 - 4, 11, 700)}
                  </text>
                  <text x={hub.x} y={hub.y + 12} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                    {t('DASHBOARD_REACH_HUB')}
                  </text>
                </g>
              </svg>
            </div>

            {/* The old chip row's facts, kept as the key to the drawing. */}
            <div
              data-testid="pool-reach-legend"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-1.5 text-[11px] text-muted-foreground"
            >
              {REACH_STATUSES.filter((status) => status === 'connected' || layout.counts[status] > 0).flatMap((status) => {
                const item = (
                  <span key={status} className="inline-flex items-center gap-1">
                    <LegendSwatch status={status} />
                    <span className="font-medium tabular-nums text-foreground">{layout.counts[status]}</span>
                    {statusWord(status)}
                  </span>
                );
                // Right after "connected", and worded as part of it: the rail counts these peers as connected too.
                return status === 'connected' && layout.concerns > 0
                  ? [
                      item,
                      <span key="concerns" className="inline-flex items-center gap-1">
                        <LegendSwatch status="connected" concern="unreported" />
                        <span className="font-medium tabular-nums text-foreground">{layout.concerns}</span>
                        {t('DASHBOARD_REACH_CONCERNS')}
                      </span>,
                    ]
                  : [item];
              })}
              <span>
                <span className="font-medium tabular-nums text-foreground">{figures.reachableModels}</span> {t('DASHBOARD_REACH_MODELS_REACHABLE')}
              </span>
              <HintText
                id="dashboard-exclusive-models"
                hint={t('DASHBOARD_EXCLUSIVE_MODELS_HINT')}
                className="underline decoration-dotted underline-offset-2"
              >
                <span className="font-medium tabular-nums text-foreground">{figures.exclusiveModels}</span> {t('DASHBOARD_REACH_PEER_ONLY')}
              </HintText>
              {/* A dash, not 0: no peer reporting the counter is unknown, not idle. */}
              <span className="inline-flex items-center gap-1">
                <svg data-testid="pool-reach-legend-badge" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" className="shrink-0">
                  <rect x="0.75" y="0.75" width="12.5" height="10.5" rx="5.25" className="fill-primary" />
                </svg>
                <span className="font-medium tabular-nums text-foreground">{figures.peerInFlight ?? DASH}</span> {t('DASHBOARD_REACH_FORWARDED')}
              </span>
            </div>

            <details data-testid="pool-reach-details" className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none py-0.5 hover:text-foreground">
                {t('DASHBOARD_REACH_DETAILS', { count: layout.peers.length })}
              </summary>
              <ul data-testid="pool-reach-list" className="mt-1 space-y-0.5 leading-snug">
                {layout.peers.map((peer) => (
                  <li key={peer.key}>{describe(peer)}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
