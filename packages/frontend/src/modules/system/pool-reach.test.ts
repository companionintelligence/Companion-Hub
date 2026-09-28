import { describe, expect, it } from 'vitest';

import { type PoolNodeCard, poolNodeCards } from './pool-node-series';
import { REACH_MAX_SLOTS, REACH_ROW, REACH_WIDTH, type ReachPeer, reachLayout, reachPeers } from './pool-reach';
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
  it('draws only peers, never this Hub, each under its tailnet name', () => {
    const peers = reachPeers(cards([peer('beta-1'), peer('core-10', { displayName: 'ci' })]));

    expect(peers.map((entry) => entry.name)).toEqual(['beta-1', 'core-10']);
    // core-10 calls itself "ci": the name an operator can ssh to leads, the alias rides along.
    expect(peers[1]?.alias).toBe('ci');
    expect(peers[0]?.alias).toBeNull();
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

  it('keeps every node inside the fixed-width viewBox, so it scales rather than scrolls', () => {
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

  it('places the same pool the same way on every poll', () => {
    expect(reachLayout(spokes(15))).toEqual(reachLayout(spokes(15)));
  });
});
