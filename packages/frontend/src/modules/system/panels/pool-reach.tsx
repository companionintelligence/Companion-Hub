import { relativeAge } from '@/components/ui/dense/dense';
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
import { useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * POOL REACH — this Hub in the middle, one spoke per paired peer.
 *
 * It replaces a row of five count chips that answered "how many" and never "which". The question an
 * operator brings here is whether a node they know is in the pool is one THIS Hub can send work to;
 * a leaf paired with two hubs routes to those two and nowhere else, and a count of 3 does not say
 * which three.
 *
 * A spoke's status is carried three ways — line pattern, marker shape and the word under the name —
 * so it survives colour blindness, a greyscale screenshot and a screen reader. Only a spoke that can
 * carry work right now is solid: a connected peer the proxy skips (no snapshot, or it declined work)
 * and every spoke of a Hub whose own routing is switched off are drawn broken, because a solid green
 * line to a node that gets nothing is the drawing lying.
 *
 * The drawing is `role="img"`, and neither a keyboard nor a touch screen can open an SVG `<title>`,
 * so the Resources page's AI pool tab lists every peer, with the same facts, in the table under it.
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

/** The in-flight badge: a pill that grows with its number, so "99+" stays inside it. */
function Badge({ x, y, label }: { x: number; y: number; label: string }) {
  const width = Math.max(14, textWidth(label, BADGE_PX, 700) + 7);

  return (
    <>
      <rect x={x - width / 2} y={y - 7} width={width} height={14} rx={7} className="fill-primary stroke-card" strokeWidth={1.5} />
      <text x={x} y={y + 3.5} textAnchor="middle" className="fill-primary-foreground text-[10px] font-medium tabular-nums">
        {label}
      </text>
    </>
  );
}

/** The words the drawing uses for a peer: the line under its name and its tooltip. */
function useReachWords() {
  const { t } = useTranslation();
  const statusWord = (status: ReachStatus) => t(STATUS_KEY[status]);
  const probeWord = (kind: string) => t(PROBE_KEY[kind] ?? 'DASHBOARD_REACH_PROBE_OTHER');
  const modelsWord = (peer: ReachPeer) =>
    peer.models === null ? t('DASHBOARD_REACH_MODELS_UNREPORTED') : t('DASHBOARD_REACH_MODELS', { count: peer.models });

  /**
   * What the line under a peer's name can say, longest first: `fitFirst` keeps the first that fits
   * the slot whole. A concern replaces the model count, because it is the reason the count is
   * missing or does not matter.
   */
  const detailOptions = (peer: ReachPeer, now: number): string[] => {
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
  const describe = (peer: ReachPeer, now: number): string =>
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

  return { statusWord, describe, detailOptions };
}

/**
 * This Hub in the middle and one spoke per paired peer. The Resources page's AI pool tab shows it
 * above its list of Hubs.
 */
export function PoolReachGraph({ cards, routingOff = null, className }: { cards: PoolNodeCard[]; routingOff?: ReachRoutingOff; className?: string }) {
  const { t } = useTranslation();
  const [width, measure] = useRenderedWidth();
  const now = Date.now();
  const { statusWord, describe: describeAt, detailOptions: detailOptionsAt } = useReachWords();
  const describe = (peer: ReachPeer) => describeAt(peer, now);
  const detailOptions = (peer: ReachPeer) => detailOptionsAt(peer, now);
  const hubCard = cards.find((card) => card.local);
  // Not memoised: `poolNodeCards` builds a new array every render, so a memo here would never hit.
  const layout = reachLayout(reachPeers(cards), { width });
  const hubName = hubCard?.fqdn?.split('.')[0] || t('DASHBOARD_THIS_HUB');

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
    <div ref={measure} className={cn('w-full min-w-0', className)}>
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
            <line x1={hub.x} y1={hub.y} x2={layout.overflow.x} y2={layout.overflow.y} className="stroke-muted-foreground/40" strokeWidth={1} />
          ) : null}
        </g>

        {layout.placed.map((peer) => {
          const outward = peer.side === 'right' ? 1 : -1;
          const anchor = peer.side === 'right' ? 'start' : 'end';
          const inFlight = peer.inFlight ?? 0;
          const labelX = peer.x + outward * REACH_LABEL_GAP;
          const badge = badgeCentre(peer, hub);

          return (
            <g key={peer.key} data-testid="pool-reach-peer" data-peer={peer.name} data-status={peer.status} data-concern={peer.concern ?? undefined}>
              <title>{describe(peer)}</title>
              <Marker status={peer.status} concern={peer.concern} x={peer.x} y={peer.y} />
              <text x={labelX} y={peer.y - 2} textAnchor={anchor} className="fill-foreground text-[12px] font-medium">
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
              className="fill-muted-foreground text-[11px] font-medium"
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
          <text x={hub.x} y={hub.y - 2} textAnchor="middle" className="fill-foreground text-[11px] font-medium">
            {fitText(hubName, REACH_HUB_R * 2 - 4, 11, 700)}
          </text>
          <text x={hub.x} y={hub.y + 12} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {t('DASHBOARD_REACH_HUB')}
          </text>
        </g>
      </svg>
    </div>
  );
}
