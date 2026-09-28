import { describe, expect, it } from 'vitest';

import { type PoolNodeCard, poolNodeCards } from './pool-node-series';
import {
  badgeCentre,
  fitFirst,
  fitText,
  REACH_LABEL_GAP,
  REACH_MAX_SLOTS,
  REACH_ROW,
  REACH_WIDTH,
  type ReachPeer,
  reachLayout,
  reachPeers,
  textWidth,
} from './pool-reach';
import type { PoolPeerSummary } from './use-dashboard-data';

/*
 * The reach drawing's rules, away from the DOM: who is a spoke, what each spoke says, where it sits,
 * and what gets folded away when the pool outgrows the drawing.
 */

const NOW = Date.parse('2026-09-28T16:26:24Z');

function peer(name: string, extras: Partial<PoolPeerSummary> = {}): PoolPeerSummary {
  return {
    id: `peer-${name}`,
    nodeFqdn: `${name}.tailnet-example.ts.net`,
    displayName: name,
    direction: 'inbound',
    status: 'connected',
    enabled: true,
    consecutiveFailures: 0,
    lastSeenAt: '2026-09-28 16:26:06.582',
    inFlightRequests: 0,
    authMode: 'signed',
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:1b', 'qwen3.6:35b'] }] },
    ...extras,
  };
}

function cards(peers: PoolPeerSummary[]): PoolNodeCard[] {
  return poolNodeCards({ nodeFqdn: 'core-2.tailnet-example.ts.net', backends: [] }, peers, {
    localLabel: 'This Hub',
    localContainers: null,
    now: NOW,
  });
}

function spokes(count: number, extras: (index: number) => Partial<PoolPeerSummary> = () => ({})): ReachPeer[] {
  return reachPeers(cards(Array.from({ length: count }, (_, index) => peer(`core-${index + 1}`, extras(index)))));
}

describe('reachPeers', () => {
  it('draws only peers, never this Hub, each under the name the Pool nodes table gives it', () => {
    const peers = reachPeers(
      cards([
        peer('beta-1'),
        peer('core-10', { displayName: 'ci' }),
        peer('core-1', { displayName: null }),
        peer('beta-glass', { displayName: 'beta-3-glass' }),
      ]),
    );

    // One name per node on the page: the card's label, which is what Pool nodes and the model index print.
    expect(peers.map((entry) => entry.name)).toEqual(['beta-1', 'beta-3-glass', 'ci', 'core-1']);
    // The tailnet host rides along only where it says something the name does not.
    expect(peers.map((entry) => entry.host)).toEqual([null, 'beta-glass', 'core-10', null]);
  });

  it('marks a connected peer the proxy will not use, or whose probes are failing, instead of drawing it healthy', () => {
    const peers = reachPeers(
      cards([
        peer('a'),
        // Capabilities cleared after the peer answered 401: connected, but no inventory to route on.
        peer('b', { lastCapabilities: null, consecutiveFailures: 2, probeFailure: { kind: 'unauthorized' } }),
        // Inbound switched off there: the proxy skips it on the flag.
        peer('c', { lastCapabilities: { hardwareTier: 'high', acceptingWork: false, backends: [] } }),
        // Timing out but still inside its strikes: still routable, and still worth a look.
        peer('d', { consecutiveFailures: 1, probeFailure: { kind: 'unreachable' } }),
        peer('e', { status: 'unreachable', probeFailure: { kind: 'unreachable' } }),
      ]),
    );

    expect(peers.map((entry) => entry.concern)).toEqual([null, 'unreported', 'declining', 'probe', null]);
    // Absent, not 0: the drawing's "models not reported" is reachable for a connected peer.
    expect(peers[1]?.models).toBeNull();
    expect(peers.map((entry) => entry.status)).toEqual(['connected', 'connected', 'connected', 'connected', 'unreachable']);
  });

  it('orders names as an operator counts them: core-2 before core-10', () => {
    const peers = reachPeers(cards([peer('core-10'), peer('core-2'), peer('beta-max')]));

    expect(peers.map((entry) => entry.name)).toEqual(['beta-max', 'core-2', 'core-10']);
  });

  it('carries the four statuses apart, with an operator disable outranking the socket', () => {
    const peers = reachPeers(
      cards([
        peer('a', { status: 'connected' }),
        peer('b', { status: 'unreachable' }),
        peer('c', { status: 'pending' }),
        peer('d', { status: 'connected', enabled: false }),
        // A value a newer backend might write is not yet trusted, so it is not drawn as a live spoke.
        peer('e', { status: 'rejected-by-future-build' }),
      ]),
    );

    expect(peers.map((entry) => entry.status)).toEqual(['connected', 'unreachable', 'pending', 'disabled', 'pending']);
  });

  it('gives a model count only to a connected peer: a cached inventory is not reach', () => {
    const [connected, unreachable] = reachPeers(cards([peer('a'), peer('b', { status: 'unreachable' })]));

    expect(connected?.models).toBe(2);
    expect(unreachable?.models).toBeNull();
  });

  it('keeps what the tooltip needs: auth mode, pairing direction, our in-flight count and a failing probe', () => {
    const [entry] = reachPeers(
      cards([peer('a', { authMode: 'bearer', direction: 'outbound', inFlightRequests: 2, probeFailure: { kind: 'unauthorized' } })]),
    );

    expect(entry).toMatchObject({ authMode: 'bearer', direction: 'outbound', inFlight: 2, probeFailure: 'unauthorized', tier: 'high' });
  });
});

describe('reachLayout', () => {
  it('lays out nothing, and no overflow, for a Hub with no pairings', () => {
    const layout = reachLayout([]);

    expect(layout.placed).toEqual([]);
    expect(layout.overflow).toBeNull();
    expect(layout.peers).toEqual([]);
    expect(layout.counts).toEqual({ connected: 0, unreachable: 0, pending: 0, disabled: 0 });
  });

  it('puts every one of a 15-peer hub on the drawing, clockwise from the top right', () => {
    const layout = reachLayout(spokes(15));

    expect(layout.placed).toHaveLength(15);
    expect(layout.overflow).toBeNull();
    const right = layout.placed.filter((entry) => entry.side === 'right');
    const left = layout.placed.filter((entry) => entry.side === 'left');
    expect(right).toHaveLength(8);
    expect(left).toHaveLength(7);
    // Down the right side, then back up the left.
    expect(right.map((entry) => entry.y)).toEqual([...right.map((entry) => entry.y)].sort((a, b) => a - b));
    expect(left.map((entry) => entry.y)).toEqual([...left.map((entry) => entry.y)].sort((a, b) => b - a));
    expect(layout.placed[0]?.name).toBe('core-1');
    expect(layout.placed[0]?.side).toBe('right');
    expect(layout.placed.at(-1)?.side).toBe('left');
    for (const entry of right) expect(entry.x).toBeGreaterThan(layout.hub.x);
    for (const entry of left) expect(entry.x).toBeLessThan(layout.hub.x);
  });

  it('gives every label a row of its own, so no two names on one side overlap', () => {
    for (const count of [2, 7, 15, 24]) {
      const layout = reachLayout(spokes(count));

      for (const side of ['left', 'right'] as const) {
        const ys = layout.placed
          .filter((entry) => entry.side === side)
          .map((entry) => entry.y)
          .sort((a, b) => a - b);
        for (let index = 1; index < ys.length; index += 1) {
          expect((ys[index] ?? 0) - (ys[index - 1] ?? 0)).toBeGreaterThanOrEqual(REACH_ROW - 0.001);
        }
      }
    }
  });

  it('keeps every node inside the default-width viewBox, so it scales rather than scrolls', () => {
    const layout = reachLayout(spokes(24));

    expect(layout.width).toBe(REACH_WIDTH);
    for (const entry of layout.placed) {
      expect(entry.x).toBeGreaterThan(0);
      expect(entry.x).toBeLessThan(layout.width);
      expect(entry.y).toBeGreaterThan(0);
      expect(entry.y).toBeLessThan(layout.height);
      // At least ~110 units beside every node for its label, on the side it faces.
      expect(entry.side === 'right' ? layout.width - entry.x : entry.x).toBeGreaterThanOrEqual(110);
    }
  });

  it('grows taller with the pool, and never shorter than the hub needs', () => {
    expect(reachLayout(spokes(1)).height).toBeGreaterThanOrEqual(120);
    expect(reachLayout(spokes(24)).height).toBeGreaterThan(reachLayout(spokes(15)).height);
  });

  it('folds a 30-peer pool into the drawing, keeping every problem peer and naming the rest', () => {
    // Late in the alphabet on purpose: a name-order cut would drop exactly these.
    const layout = reachLayout(
      spokes(30, (index) =>
        index === 29 ? { status: 'unreachable' } : index === 28 ? { status: 'pending' } : index === 27 ? { inFlightRequests: 3 } : {},
      ),
    );

    expect(layout.placed).toHaveLength(REACH_MAX_SLOTS - 1);
    expect(layout.overflow?.peers).toHaveLength(30 - (REACH_MAX_SLOTS - 1));
    const drawn = layout.placed.map((entry) => entry.name);
    expect(drawn).toContain('core-30');
    expect(drawn).toContain('core-29');
    expect(drawn).toContain('core-28');
    // Only healthy, idle spokes are folded away.
    for (const hidden of layout.overflow?.peers ?? []) {
      expect(hidden.status).toBe('connected');
      expect(hidden.inFlight ?? 0).toBe(0);
    }
    // Every peer is still counted and still listed.
    expect(layout.peers).toHaveLength(30);
    expect(layout.counts).toEqual({ connected: 28, unreachable: 1, pending: 1, disabled: 0 });
  });

  it('keeps a connected peer with a problem on the drawing before any healthy one', () => {
    const layout = reachLayout(
      spokes(30, (index) =>
        index === 29
          ? { lastCapabilities: null, probeFailure: { kind: 'unauthorized' } }
          : index === 28
            ? { probeFailure: { kind: 'unreachable' } }
            : {},
      ),
    );
    const drawn = layout.placed.map((entry) => entry.name);

    expect(drawn).toContain('core-30');
    expect(drawn).toContain('core-29');
    for (const hidden of layout.overflow?.peers ?? []) expect(hidden.concern).toBeNull();
  });

  it('lays out at the width it is drawn, so a label is the same size on a phone as on a desktop', () => {
    for (const width of [300, 322, 329, 380, 403, 480]) {
      const layout = reachLayout(spokes(24), { width });

      expect(layout.width).toBe(width);
      for (const entry of layout.placed) {
        expect(entry.x).toBeGreaterThan(0);
        expect(entry.x).toBeLessThan(width);
        // The label's room runs from the marker's label edge to the drawing's edge, never past it.
        const start = entry.side === 'right' ? entry.x + REACH_LABEL_GAP : entry.x - REACH_LABEL_GAP;
        expect(entry.side === 'right' ? start + entry.room : start - entry.room).toBeGreaterThanOrEqual(0);
        expect(entry.side === 'right' ? start + entry.room : start - entry.room).toBeLessThanOrEqual(width);
        expect(entry.room).toBeGreaterThanOrEqual(80);
      }
    }
  });

  it('places the same pool the same way on every poll', () => {
    expect(reachLayout(spokes(15))).toEqual(reachLayout(spokes(15)));
  });
});

describe('fitting a label to its room', () => {
  // The longest things a label says on this fleet, name line and detail line.
  const NAMES = ['mac-studio-m4-ultra', 'workstation-lab-02', 'beta-3-glass', 'core-10'];
  const DETAILS = ['models not reported', '23 models · cpu-only', 'probes refused', 'unreachable · 2d', 'awaiting peer', 'not taking work'];

  it('never lets an estimated label extent pass the edge of the drawing, at any width', () => {
    for (const width of [300, 322, 329, 380, 403]) {
      const layout = reachLayout(spokes(24), { width });
      for (const entry of layout.placed) {
        const start = entry.side === 'right' ? entry.x + REACH_LABEL_GAP : entry.x - REACH_LABEL_GAP;
        for (const [text, size, weight] of [
          ...NAMES.map((name) => [name, 12, 600] as const),
          ...DETAILS.map((detail) => [detail, 10, 400] as const),
        ]) {
          const shown = fitText(text, entry.room, size, weight);
          const extent = textWidth(shown, size, weight);
          if (entry.side === 'right') expect(start + extent).toBeLessThanOrEqual(width);
          else expect(start - extent).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('keeps text that fits whole, and clips what does not with an ellipsis', () => {
    expect(fitText('core-10', 100, 12, 600)).toBe('core-10');
    const clipped = fitText('mac-studio-m4-ultra', 80, 12, 600);
    expect(clipped.endsWith('…')).toBe(true);
    expect(textWidth(clipped, 12, 600)).toBeLessThanOrEqual(80);
  });

  it('prefers a shorter whole phrase to a clipped long one', () => {
    // "23 models" says the thing that matters; "23 models · cpu-o…" says less.
    expect(fitFirst(['23 models · cpu-only', '23 models'], 70, 10)).toBe('23 models');
    expect(fitFirst(['23 models · cpu-only', '23 models'], 200, 10)).toBe('23 models · cpu-only');
  });

  it('estimates at least as wide as Manrope, the font the app loads, measured', () => {
    // Measured in Chromium with Manrope loaded (canvas measureText), 2026-09-28.
    expect(textWidth('pending · awaiting peer', 10, 400)).toBeGreaterThanOrEqual(105.9);
    expect(textWidth('23 models · cpu-only', 10, 400)).toBeGreaterThanOrEqual(94.3);
    expect(textWidth('mac-studio-m4-ultra', 12, 600)).toBeGreaterThanOrEqual(120.8);
    expect(textWidth('core-10', 12, 600)).toBeGreaterThanOrEqual(43.4);
  });
});

describe('the in-flight badge', () => {
  it("sits on the peer's own spoke, between the hub and the marker", () => {
    const layout = reachLayout(spokes(30));
    for (const entry of layout.placed) {
      const badge = badgeCentre(entry, layout.hub);
      // Collinear with hub → peer, and strictly between them.
      const cross = (entry.x - layout.hub.x) * (badge.y - layout.hub.y) - (entry.y - layout.hub.y) * (badge.x - layout.hub.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
      expect(Math.min(layout.hub.x, entry.x) <= badge.x && badge.x <= Math.max(layout.hub.x, entry.x)).toBe(true);
      expect(Math.hypot(badge.x - entry.x, badge.y - entry.y)).toBeGreaterThanOrEqual(12);
    }
  });
});
