import type { PoolNodeCard } from '@/modules/system/pool-node-series';

/*
 * POOL REACH, AS GEOMETRY — who this Hub can route to, laid out around it.
 *
 * A Hub knows only its OWN pairings: peers do not advertise theirs, and routing never goes two hops.
 * So the honest picture is ego-centric — this Hub in the middle and one spoke per paired peer —
 * never a fleet mesh this page cannot see. On 2026-09-27 beta-max, as a leaf, 502'd a model its two
 * hubs did not hold while fifteen other nodes did; the drawing exists to make "not paired here"
 * visible as "not reachable from here".
 *
 * The layout is pure and deterministic so it can be tested without a DOM, and so a 15-second poll
 * that changes nothing moves nothing.
 */

/** The four ways a spoke is drawn. Anything else a newer backend writes is `pending`: not yet routable. */
export type ReachStatus = 'connected' | 'unreachable' | 'pending' | 'disabled';

export const REACH_STATUSES: readonly ReachStatus[] = ['connected', 'unreachable', 'pending', 'disabled'];

export interface ReachPeer {
  key: string;
  /** The tailnet name with the suffix stripped — what an operator types after `ssh`. */
  name: string;
  /** The peer's own display name when it says something the tailnet name does not (core-10 calls itself "ci"). */
  alias: string | null;
  status: ReachStatus;
  /** Servable models on a connected peer; `null` otherwise, because a cached inventory is not reach. */
  models: number | null;
  tier: string | null;
  /** What THIS Hub has forwarded there and not finished reading. */
  inFlight: number | null;
  lastSeenAt: string | null;
  /** `outbound`: this Hub asked to pair. `inbound`: the peer asked. */
  direction: string | null;
  authMode: string | null;
  probeFailure: string | null;
}

export interface PlacedPeer extends ReachPeer {
  x: number;
  y: number;
  /** Which side of the hub the label sits on; the label always reads outward, away from the spokes. */
  side: 'left' | 'right';
}

/** The slot that stands for every peer past the drawing's capacity. */
export interface ReachOverflow {
  x: number;
  y: number;
  side: 'left' | 'right';
  peers: ReachPeer[];
}

export interface ReachLayout {
  width: number;
  height: number;
  hub: { x: number; y: number };
  placed: PlacedPeer[];
  overflow: ReachOverflow | null;
  /** Every peer, drawn or not, in reading order — the accessible list reads this. */
  peers: ReachPeer[];
  counts: Record<ReachStatus, number>;
}

/** viewBox width. Fixed, so the drawing scales as one picture from a 320px phone to a 400px track. */
export const REACH_WIDTH = 380;
/** Vertical pitch per peer row: a name line and a detail line. */
export const REACH_ROW = 30;
/** Most slots the drawing holds. Past this the labels stop fitting at phone width, so the rest collapse. */
export const REACH_MAX_SLOTS = 24;

const PAD_Y = 22;
const MIN_HEIGHT = 136;
/** Horizontal reach of the ring from the hub. Leaves ~110 units outside it for a label on either side. */
const RING_RX = 66;
/** The narrowest a spoke gets at the top and bottom of the ring, so it never runs through the hub's label. */
const MIN_DX = 30;

export function reachStatus(card: Pick<PoolNodeCard, 'status'>): ReachStatus {
  const status = card.status;
  if (status === 'connected' || status === 'unreachable' || status === 'disabled') return status;

  return 'pending';
}

function shortName(card: Pick<PoolNodeCard, 'fqdn' | 'label' | 'key'>): string {
  return card.fqdn?.split('.')[0] || card.label || card.key;
}

/** One card per paired peer, as the drawing reads it. The local card is not a peer and is skipped. */
export function reachPeers(cards: PoolNodeCard[]): ReachPeer[] {
  return cards
    .filter((card) => !card.local)
    .map((card): ReachPeer => {
      const name = shortName(card);
      const status = reachStatus(card);

      return {
        key: card.key,
        name,
        alias: card.label && card.label !== name ? card.label : null,
        status,
        models: status === 'connected' ? card.models : null,
        tier: card.hardwareTier,
        inFlight: card.inFlight,
        lastSeenAt: card.lastSeenAt,
        direction: card.direction,
        authMode: card.authMode ?? null,
        probeFailure: card.probeFailure ?? null,
      };
    })
    .sort(byName);
}

function byName(a: ReachPeer, b: ReachPeer): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** Problems first when the drawing cannot hold everyone: a healthy spoke is the one worth folding away. */
const STATUS_PRIORITY: Record<ReachStatus, number> = { unreachable: 0, pending: 1, disabled: 2, connected: 3 };

function drawPriority(a: ReachPeer, b: ReachPeer): number {
  return STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || Number((b.inFlight ?? 0) > 0) - Number((a.inFlight ?? 0) > 0) || byName(a, b);
}

/**
 * Where each peer sits.
 *
 * Peers go clockwise from the top in name order: down the right side, then up the left. Each side's
 * rows are spaced evenly in Y and pushed out to an ellipse in X, so it reads as a ring around the hub
 * while every label keeps a row of its own — a ring spaced by ANGLE puts the top and bottom nodes a
 * few units apart and their labels on top of each other. Labels face outward, so none crosses a spoke.
 *
 * Past {@link REACH_MAX_SLOTS} the last slot becomes "+k more". Unreachable, pending and disabled
 * peers, and any with work in flight, are drawn before a healthy idle one is folded away.
 */
export function reachLayout(peers: ReachPeer[], maxSlots = REACH_MAX_SLOTS): ReachLayout {
  const counts: Record<ReachStatus, number> = { connected: 0, unreachable: 0, pending: 0, disabled: 0 };
  for (const peer of peers) counts[peer.status] += 1;

  const ordered = [...peers].sort(byName);
  const capacity = Math.max(1, maxSlots);
  const overflowing = ordered.length > capacity;
  const drawn = overflowing
    ? [...ordered]
        .sort(drawPriority)
        .slice(0, capacity - 1)
        .sort(byName)
    : ordered;
  const hidden = overflowing ? ordered.filter((peer) => !drawn.includes(peer)) : [];

  const slots = drawn.length + (hidden.length > 0 ? 1 : 0);
  const rightCount = Math.ceil(slots / 2);
  const leftCount = slots - rightCount;
  const rows = Math.max(1, rightCount, leftCount);
  const height = Math.max(MIN_HEIGHT, rows * REACH_ROW + PAD_Y * 2);
  const hub = { x: REACH_WIDTH / 2, y: height / 2 };
  // The ring's vertical radius sits half a row past the outermost rows, so the top and bottom nodes
  // still stand off the hub's column instead of meeting it.
  const ry = ((rows - 1) * REACH_ROW) / 2 + REACH_ROW * 0.75;

  const position = (index: number, count: number, side: 'left' | 'right') => {
    const y = hub.y - ((count - 1) * REACH_ROW) / 2 + index * REACH_ROW;
    const t = (y - hub.y) / ry;
    const dx = Math.max(MIN_DX, RING_RX * Math.sqrt(Math.max(0, 1 - t * t)));

    return { x: side === 'right' ? hub.x + dx : hub.x - dx, y, side };
  };

  // Slot `i` in clockwise order: 0..right-1 down the right side, then up the left from the bottom.
  const slotAt = (slot: number) =>
    slot < rightCount ? position(slot, rightCount, 'right') : position(leftCount - 1 - (slot - rightCount), leftCount, 'left');

  const placed = drawn.map((peer, index) => ({ ...peer, ...slotAt(index) }));
  const overflow = hidden.length > 0 ? { ...slotAt(drawn.length), peers: hidden } : null;

  return { width: REACH_WIDTH, height, hub, placed, overflow, peers: ordered, counts };
}
