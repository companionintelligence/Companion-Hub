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
 *
 * It is laid out at the width it is DRAWN, one unit to one CSS pixel. A fixed viewBox scaled to fit
 * shrank every label with the column: 12px names read at 10px and 10px details at 8.5px on a phone,
 * smaller than anything else on the page. Laying out at the real width keeps the type at its size
 * and makes the room a label has a number the layout can check.
 */

/** The four ways a spoke is drawn. Anything else a newer backend writes is `pending`: not yet routable. */
export type ReachStatus = 'connected' | 'unreachable' | 'pending' | 'disabled';

export const REACH_STATUSES: readonly ReachStatus[] = ['connected', 'unreachable', 'pending', 'disabled'];

/**
 * Why a CONNECTED peer is not the healthy spoke its status alone would draw.
 *
 * - `unreported`: no capability snapshot — between approval and the first probe, or after a 401/403
 *   cleared it. The proxy skips a peer with no snapshot, so this spoke carries no work.
 * - `declining`: the peer said `acceptingWork: false` (inbound off there, or it disabled us). The
 *   proxy skips it on the flag.
 * - `probe`: its probes are failing but it is inside its strikes and its snapshot stands, so it is
 *   still routable — and the next thing likely to go unreachable.
 *
 * A concern does not change the status: the peer is still `connected`, and the rail, the verdict and
 * the Pool nodes table count it so. It changes how the spoke is drawn and what the label says.
 */
export type ReachConcern = 'unreported' | 'declining' | 'probe';

export interface ReachPeer {
  key: string;
  /** The name the Pool nodes table and the model index print for this node — one name per node on the page. */
  name: string;
  /** The tailnet host, when it is not already the name (core-10 calls itself "ci"). What an operator types after `ssh`. */
  host: string | null;
  status: ReachStatus;
  /** Only ever set on a connected peer. See {@link ReachConcern}. */
  concern: ReachConcern | null;
  /** Servable models on a connected peer with a snapshot; `null` otherwise, because a cached inventory is not reach. */
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
  /** Width a label may take, from {@link REACH_LABEL_GAP} past the marker to the drawing's edge. */
  room: number;
}

/** The slot that stands for every peer past the drawing's capacity. */
export interface ReachOverflow {
  x: number;
  y: number;
  side: 'left' | 'right';
  room: number;
  peers: ReachPeer[];
}

export interface ReachLayout {
  width: number;
  height: number;
  hub: { x: number; y: number };
  placed: PlacedPeer[];
  overflow: ReachOverflow | null;
  /** Every peer, drawn or not, in reading order — the details list reads this. */
  peers: ReachPeer[];
  counts: Record<ReachStatus, number>;
  /** Connected peers with a {@link ReachConcern}. A subset of `counts.connected`, not beside it. */
  concerns: number;
}

/** Width laid out at before the drawing has been measured, and wherever it cannot be (tests, print). */
export const REACH_WIDTH = 380;
/** Vertical pitch per peer row: a name line and a detail line. */
export const REACH_ROW = 30;
/** Most slots the drawing holds. Past this the rows outgrow the panel beside it, so the rest collapse. */
export const REACH_MAX_SLOTS = 24;
/** From a marker's centre to where its label starts. */
export const REACH_LABEL_GAP = 10;
/** Hub circle radius; its name and caption sit inside it. */
export const REACH_HUB_R = 28;

const PAD_Y = 22;
const MIN_HEIGHT = 136;
/** Kept clear at the drawing's left and right edge. */
const EDGE_PAD = 6;
/**
 * Horizontal reach of the ring as a share of the width, clamped. Smaller than the hub-to-edge
 * distance by design: what the ring gives up, the widest rows' labels get.
 */
const RING_SHARE = 0.15;
const RING_MIN = 44;
const RING_MAX = 66;
/** The narrowest a spoke gets at the top and bottom of the ring, so it never runs through the hub's label. */
const MIN_DX = 30;
/** How far in from a peer's marker its in-flight badge sits, along its own spoke. */
const BADGE_INSET = 16;

export function reachStatus(card: Pick<PoolNodeCard, 'status'>): ReachStatus {
  const status = card.status;
  if (status === 'connected' || status === 'unreachable' || status === 'disabled') return status;

  return 'pending';
}

function hostName(card: Pick<PoolNodeCard, 'fqdn'>): string | null {
  return card.fqdn?.split('.')[0] || null;
}

function concernOf(card: PoolNodeCard, status: ReachStatus): ReachConcern | null {
  if (status !== 'connected') return null;
  // Ordered by what stops routing first: no snapshot or a refusal means no work goes there at all.
  if (card.models === null) return 'unreported';
  if (card.acceptingWork === false) return 'declining';
  if (card.probeFailure) return 'probe';

  return null;
}

/** One entry per paired peer, as the drawing reads it. The local card is not a peer and is skipped. */
export function reachPeers(cards: PoolNodeCard[]): ReachPeer[] {
  return cards
    .filter((card) => !card.local)
    .map((card): ReachPeer => {
      const host = hostName(card);
      const status = reachStatus(card);

      return {
        key: card.key,
        name: card.label,
        host: host && host !== card.label ? host : null,
        status,
        concern: concernOf(card, status),
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
function problemRank(peer: ReachPeer): number {
  if (peer.status === 'unreachable') return 0;
  if (peer.status === 'pending') return 1;
  if (peer.concern !== null) return 2;
  if (peer.status === 'disabled') return 3;

  return 4;
}

function drawPriority(a: ReachPeer, b: ReachPeer): number {
  return problemRank(a) - problemRank(b) || Number((b.inFlight ?? 0) > 0) - Number((a.inFlight ?? 0) > 0) || byName(a, b);
}

/**
 * Where each peer sits.
 *
 * Peers go clockwise from the top in name order: down the right side, then up the left. Each side's
 * rows are spaced evenly in Y and pushed out to an ellipse in X, so it reads as a ring around the hub
 * while every label keeps a row of its own — a ring spaced by ANGLE puts the top and bottom nodes a
 * few units apart and their labels on top of each other. Labels face outward, so none crosses a spoke.
 *
 * Past {@link REACH_MAX_SLOTS} the last slot becomes "+k more". Unreachable and pending peers,
 * connected peers with a concern, disabled peers, and any with work in flight, are drawn before a
 * healthy idle one is folded away.
 */
export function reachLayout(peers: ReachPeer[], options: { width?: number; maxSlots?: number } = {}): ReachLayout {
  const width = options.width && options.width > 0 ? options.width : REACH_WIDTH;
  const counts: Record<ReachStatus, number> = { connected: 0, unreachable: 0, pending: 0, disabled: 0 };
  let concerns = 0;
  for (const peer of peers) {
    counts[peer.status] += 1;
    if (peer.concern !== null) concerns += 1;
  }

  const ordered = [...peers].sort(byName);
  const capacity = Math.max(1, options.maxSlots ?? REACH_MAX_SLOTS);
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
  const hub = { x: width / 2, y: height / 2 };
  const ringX = Math.min(RING_MAX, Math.max(RING_MIN, width * RING_SHARE));
  // The ring's vertical radius sits half a row past the outermost rows, so the top and bottom nodes
  // still stand off the hub's column instead of meeting it.
  const ry = ((rows - 1) * REACH_ROW) / 2 + REACH_ROW * 0.75;

  const position = (index: number, count: number, side: 'left' | 'right') => {
    const y = hub.y - ((count - 1) * REACH_ROW) / 2 + index * REACH_ROW;
    const t = (y - hub.y) / ry;
    const dx = Math.max(MIN_DX, ringX * Math.sqrt(Math.max(0, 1 - t * t)));
    const x = side === 'right' ? hub.x + dx : hub.x - dx;
    const room = side === 'right' ? width - EDGE_PAD - (x + REACH_LABEL_GAP) : x - REACH_LABEL_GAP - EDGE_PAD;

    return { x, y, side, room };
  };

  // Slot `i` in clockwise order: 0..right-1 down the right side, then up the left from the bottom.
  const slotAt = (slot: number) =>
    slot < rightCount ? position(slot, rightCount, 'right') : position(leftCount - 1 - (slot - rightCount), leftCount, 'left');

  const placed = drawn.map((peer, index) => ({ ...peer, ...slotAt(index) }));
  const overflow = hidden.length > 0 ? { ...slotAt(drawn.length), peers: hidden } : null;

  return { width, height, hub, placed, overflow, peers: ordered, counts, concerns };
}

/** Where a peer's in-flight badge goes: on its own spoke, {@link BADGE_INSET} in from the marker. */
export function badgeCentre(peer: { x: number; y: number }, hub: { x: number; y: number }): { x: number; y: number } {
  const dx = hub.x - peer.x;
  const dy = hub.y - peer.y;
  const length = Math.hypot(dx, dy) || 1;
  const inset = Math.min(BADGE_INSET, length / 2);

  return { x: peer.x + (dx / length) * inset, y: peer.y + (dy / length) * inset };
}

// ── Fitting text to a slot ────────────────────────────────────────────────────

const NARROW = new Set([..."ijlrtf.,:;·!|'()[]"]);
const WIDE = new Set([...'mwMW@%']);

/** Advance width of one character in em, calibrated against Manrope measured in Chromium. */
function charEm(char: string): number {
  if (char === ' ') return 0.27;
  if (NARROW.has(char)) return 0.3;
  if (WIDE.has(char)) return 0.88;
  if (char === '-') return 0.4;
  if (char >= 'A' && char <= 'Z') return 0.68;
  if (char >= '0' && char <= '9') return 0.6;

  return 0.55;
}

/**
 * Headroom over the calibration. Manrope is what `root.tsx` loads, but a label must not run off the
 * drawing on the first paint before it arrives, when the fallback is a few percent wider.
 */
const FONT_HEADROOM = 1.03;

/**
 * Estimated rendered width of `text` in CSS px. There is no layout engine to ask in a pure module
 * (or in jsdom), so this is a per-character table measured against Manrope, erring wide — the cost
 * of erring wide is an ellipsis one character early, the cost of erring narrow is text cut off.
 */
export function textWidth(text: string, fontPx: number, weight = 400): number {
  const bold = weight >= 600 ? 1.07 : 1;
  let em = 0;
  for (const char of text) em += charEm(char);

  return em * fontPx * bold * FONT_HEADROOM;
}

/** `text` whole if it fits `room`, otherwise as much of it as fits followed by an ellipsis. */
export function fitText(text: string, room: number, fontPx: number, weight = 400): string {
  if (textWidth(text, fontPx, weight) <= room) return text;

  const chars = [...text];
  for (let keep = chars.length - 1; keep > 0; keep -= 1) {
    const clipped = `${chars.slice(0, keep).join('').trimEnd()}…`;
    if (textWidth(clipped, fontPx, weight) <= room) return clipped;
  }

  return '…';
}

/**
 * The first of `candidates` that fits whole, else the last one clipped. Candidates go longest to
 * shortest: "23 models · cpu-only", then "23 models", because a shorter phrase that is whole says
 * more than a longer one cut mid-word.
 */
export function fitFirst(candidates: string[], room: number, fontPx: number, weight = 400): string {
  for (const candidate of candidates) {
    if (textWidth(candidate, fontPx, weight) <= room) return candidate;
  }

  return fitText(candidates.at(-1) ?? '', room, fontPx, weight);
}
