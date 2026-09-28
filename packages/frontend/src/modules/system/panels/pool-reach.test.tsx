import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { poolNodeCards } from '../pool-node-series';
import { poolReach, type PoolNodeSummary, type PoolPeerSummary } from '../use-dashboard-data';
import { PoolReach } from './pool-reach';

/*
 * The reach drawing, rendered. The rules it must keep are the page's: a failed pool status is a
 * failure and not an empty pool, an empty pool is said in words, and a spoke's status is legible
 * without colour and without a mouse.
 */

const READY = { pending: false, failed: false };
const NOW = Date.now();
const seenAgo = (seconds: number) => new Date(NOW - seconds * 1000).toISOString().replace('T', ' ').replace('Z', '');

const LOCAL: PoolNodeSummary = {
  nodeFqdn: 'core-2.tailnet-example.ts.net',
  hardwareTier: 'high',
  backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['qwen3.6:35b', 'gemma3:1b'] }],
};

function peer(name: string, extras: Partial<PoolPeerSummary> = {}): PoolPeerSummary {
  return {
    id: `peer-${name}`,
    nodeFqdn: `${name}.tailnet-example.ts.net`,
    displayName: name,
    direction: 'inbound',
    status: 'connected',
    enabled: true,
    lastSeenAt: seenAgo(12),
    inFlightRequests: 0,
    authMode: 'signed',
    lastCapabilities: { hardwareTier: 'high', backends: [{ type: 'ollama', healthy: true, modelsLoaded: ['gemma3:27b', 'qwen3.8:27b'] }] },
    ...extras,
  };
}

function renderReach(
  peers: PoolPeerSummary[],
  state = READY,
  local: PoolNodeSummary | undefined = LOCAL,
  routingOff: 'pool' | 'outbound' | null = null,
) {
  const cards = poolNodeCards(local, peers, { localLabel: 'This Hub', localContainers: null, now: NOW });

  return render(<PoolReach cards={cards} figures={poolReach(peers, local)} routingOff={routingOff} state={state} />).container;
}

const MIXED = [
  peer('beta-1', { inFlightRequests: 2 }),
  peer('core-7', { status: 'unreachable', lastSeenAt: seenAgo(300), consecutiveFailures: 4, probeFailure: { kind: 'unreachable' } }),
  peer('core-9', { status: 'pending', direction: 'inbound' }),
  peer('core-11', { status: 'pending', direction: 'outbound' }),
  peer('beta-red', { enabled: false }),
];

describe('PoolReach', () => {
  it('renders a failed pool status as a failure, never as a Hub with no peers', () => {
    const container = renderReach([], { pending: false, failed: true });

    expect(container.textContent).toContain('Could not read pool status.');
    expect(container.querySelector('[data-testid="pool-reach-graph"]')).toBeNull();
    expect(container.querySelector('[data-testid="pool-reach-empty"]')).toBeNull();
    // The caption is a fact about pooling, not about the query, so it stays.
    expect(container.textContent).toContain("isn't reachable from here");
  });

  it('says in words that nothing is paired, and draws no lone hub pretending to be a pool', () => {
    const container = renderReach([]);

    expect(container.querySelector('[data-testid="pool-reach-empty"]')?.textContent).toContain('No Hubs paired');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-testid="pool-reach-legend"]')).toBeNull();
  });

  it('draws each status with its own line pattern and marker, not only its own colour', () => {
    const container = renderReach(MIXED);
    const spoke = (status: string) => container.querySelector(`line[data-status="${status}"]`);

    expect(spoke('connected')?.getAttribute('stroke-dasharray')).toBeNull();
    const patterns = ['unreachable', 'pending', 'disabled'].map((status) => spoke(status)?.getAttribute('stroke-dasharray'));
    expect(patterns.every(Boolean)).toBe(true);
    expect(new Set(patterns).size).toBe(3);
    // The disabled marker is a square, not a circle of another colour.
    expect(container.querySelector('[data-peer="beta-red"] rect')).not.toBeNull();
    expect(container.querySelector('[data-peer="core-7"] path')).not.toBeNull();
  });

  it('says under each name what the peer offers, or why it does not', () => {
    const container = renderReach(MIXED);
    const detail = (name: string) => container.querySelectorAll(`[data-peer="${name}"] text`)[1]?.textContent;

    expect(detail('beta-1')).toBe('2 models · high');
    expect(detail('core-7')).toBe('unreachable · 5m');
    // Which side owes the next step of a pending pairing — short enough for a phone-width slot.
    expect(detail('core-9')).toBe('approve here');
    expect(detail('core-11')).toBe('awaiting peer');
    expect(detail('beta-red')).toBe('disabled here');
  });

  it('draws a connected peer whose capabilities were cleared as a problem, not as a healthy "0 models"', () => {
    const container = renderReach([
      peer('beta-1'),
      peer('beta-max', { lastCapabilities: null, consecutiveFailures: 2, probeFailure: { kind: 'unauthorized' } }),
      peer('core-3', { lastCapabilities: { hardwareTier: 'high', acceptingWork: false, backends: [] } }),
    ]);
    const group = (name: string) => container.querySelector(`[data-peer="${name}"]`);
    const detail = (name: string) => group(name)?.querySelectorAll('text')[1];

    expect(detail('beta-max')?.textContent).toBe('probes refused');
    expect(detail('beta-max')?.getAttribute('class')).toContain('fill-warning');
    expect(detail('core-3')?.textContent).toBe('not taking work');
    // A warning triangle, not the healthy filled dot, and a spoke that does not claim to carry work.
    expect(group('beta-max')?.querySelector('polygon')).not.toBeNull();
    const spoke = container.querySelector('line[data-spoke="beta-max"]');
    expect(spoke?.getAttribute('data-concern')).toBe('unreported');
    expect(spoke?.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(container.querySelector('line[data-spoke="beta-1"]')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(container.textContent).not.toContain('0 models');
    // Keyed in the legend, counted inside "connected" as the rail counts it.
    const legend = container.querySelector('[data-testid="pool-reach-legend"]')?.textContent ?? '';
    expect(legend).toContain('3connected');
    expect(legend).toContain('2of them degraded');
  });

  it('greys every spoke and says why when this Hub sends work to none of them', () => {
    const outboundOff = renderReach([peer('beta-1'), peer('core-3')], READY, LOCAL, 'outbound');

    expect(outboundOff.querySelector('[data-testid="pool-reach-routing-off"]')?.textContent).toContain('Outbound routing is off');
    for (const spoke of outboundOff.querySelectorAll('line[data-spoke]')) {
      expect(spoke.getAttribute('class')).toContain('stroke-muted-foreground');
      expect(spoke.getAttribute('stroke-dasharray')).toBeTruthy();
    }

    const poolOff = renderReach([peer('beta-1')], READY, LOCAL, 'pool');
    expect(poolOff.querySelector('[data-testid="pool-reach-routing-off"]')?.textContent).toContain('Pooling is off');

    const on = renderReach([peer('beta-1')]);
    expect(on.querySelector('[data-testid="pool-reach-routing-off"]')).toBeNull();
  });

  it('names what is folded away with each status, not as "connected"', () => {
    const container = renderReach(Array.from({ length: 30 }, (_, index) => peer(`core-${index + 1}`, { status: 'unreachable' })));
    const title = container.querySelector('[data-testid="pool-reach-overflow"] title')?.textContent ?? '';

    expect(title.startsWith('Not drawn:')).toBe(true);
    expect(title).not.toContain('Connected');
    expect(title).toContain('core-30 (unreachable)');
  });

  it('keeps every piece of text at the page floor of 10px or larger', () => {
    const container = renderReach([...MIXED, peer('core-14', { inFlightRequests: 128 })]);
    const sizes = [...container.querySelectorAll('svg text')].map((text) => {
      const match = /text-\[(\d+(?:\.\d+)?)px\]/.exec(text.getAttribute('class') ?? '');
      return match ? Number(match[1]) : Number.NaN;
    });

    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(10);
  });

  it('widens the in-flight badge into a pill for three characters, and keys it in the legend', () => {
    const container = renderReach([peer('beta-1', { inFlightRequests: 2 }), peer('core-14', { inFlightRequests: 128 })]);
    const width = (name: string) =>
      Number(container.querySelector(`[data-peer="${name}"] [data-testid="pool-reach-in-flight"] rect`)?.getAttribute('width'));

    expect(container.querySelector('[data-peer="core-14"] [data-testid="pool-reach-in-flight"]')?.textContent).toBe('99+');
    expect(width('core-14')).toBeGreaterThan(width('beta-1'));
    expect(container.querySelector('[data-testid="pool-reach-legend"] [data-testid="pool-reach-legend-badge"]')).not.toBeNull();
  });

  it('lays out at the width it is drawn, so its text is not shrunk on a phone', () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        Object.defineProperty(target, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 322 }) });
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const container = renderReach([peer('beta-1')]);
      expect(container.querySelector('[data-testid="pool-reach-graph"]')?.getAttribute('viewBox')).toMatch(/^0 0 322 /);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('badges only the peer holding work this Hub forwarded', () => {
    const container = renderReach(MIXED);
    const badges = container.querySelectorAll('[data-testid="pool-reach-in-flight"]');

    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest('[data-peer]')?.getAttribute('data-peer')).toBe('beta-1');
    expect(badges[0]?.textContent).toBe('2');
  });

  it('puts the details in a tooltip for a mouse and in a disclosure anyone can open', () => {
    const container = renderReach(MIXED);

    const tooltip = container.querySelector('[data-peer="core-7"] title')?.textContent ?? '';
    expect(tooltip).toContain('unreachable');
    expect(tooltip).toContain('seen 5m ago');
    expect(tooltip).toContain('probes unanswered');
    expect(tooltip).toContain('signed auth');

    const list = [...container.querySelectorAll('[data-testid="pool-reach-list"] li')].map((item) => item.textContent);
    expect(list).toHaveLength(5);
    expect(list.find((item) => item?.startsWith('beta-1'))).toContain('2 requests forwarded, in flight');
    // Not `sr-only`: a keyboard or a phone cannot open an SVG <title>, so the same facts sit behind a
    // native disclosure that both can.
    const details = container.querySelector('[data-testid="pool-reach-details"]');
    expect(details?.tagName).toBe('DETAILS');
    expect(details?.querySelector('summary')?.textContent).toContain('5 peers');
    expect(container.querySelector('[data-testid="pool-reach-list"]')?.className ?? '').not.toContain('sr-only');

    const graph = container.querySelector('[data-testid="pool-reach-graph"]');
    expect(graph?.getAttribute('role')).toBe('img');
    expect(graph?.getAttribute('aria-label')).toBe('core-2 and its 5 paired peers: 1 connected, 1 unreachable, 2 pending, 1 disabled here');
  });

  it("keeps the old chip row's facts as the legend", () => {
    const container = renderReach(MIXED);
    const legend = container.querySelector('[data-testid="pool-reach-legend"]')?.textContent ?? '';

    expect(legend).toContain('1connected');
    expect(legend).toContain('1unreachable');
    expect(legend).toContain('2 models reachable');
    // beta-1's two models; core-2 holds neither.
    expect(legend).toContain('2 peer-only');
    expect(legend).toContain('2 forwarded in flight');
  });

  it('keeps the peer-only definition on a hint a keyboard can reach, as the chip it replaced had', () => {
    const container = renderReach(MIXED);
    const term = [...container.querySelectorAll('[data-testid="pool-reach-legend"] [tabindex="0"]')].find((node) =>
      node.textContent?.includes('peer-only'),
    );

    expect(term).toBeTruthy();
    expect(term?.className).toContain('field-hint-dashboard-exclusive-models');
  });

  it('agrees with the rail about a peer that is both disabled and unreachable', () => {
    const peers = [peer('beta-1'), peer('beta-red', { status: 'unreachable', enabled: false, inFlightRequests: 1 })];
    const container = renderReach(peers);
    const legend = container.querySelector('[data-testid="pool-reach-legend"]')?.textContent ?? '';

    // The rail's "N unreachable" reads `poolReach().unreachable`; the drawing draws beta-red disabled.
    expect(poolReach(peers, LOCAL).unreachable).toBe(0);
    expect(legend).toContain('1disabled here');
    expect(legend).not.toContain('unreachable');
    // Its badge and the legend's forwarded total count the same request.
    expect(container.querySelector('[data-peer="beta-red"] [data-testid="pool-reach-in-flight"]')?.textContent).toBe('1');
    expect(legend).toContain('1 forwarded in flight');
  });

  it('reads a forwarded counter no peer reported as unknown, not as idle', () => {
    const container = renderReach([peer('beta-1', { inFlightRequests: undefined })]);

    expect(container.querySelector('[data-testid="pool-reach-legend"]')?.textContent).toContain('— forwarded in flight');
  });

  it('draws a 15-peer hub whole, scaled by its viewBox rather than a fixed width', () => {
    const container = renderReach(Array.from({ length: 15 }, (_, index) => peer(`core-${index + 1}`)));
    const graph = container.querySelector('[data-testid="pool-reach-graph"]');

    expect(container.querySelectorAll('[data-testid="pool-reach-peer"]')).toHaveLength(15);
    expect(container.querySelector('[data-testid="pool-reach-overflow"]')).toBeNull();
    expect(graph?.getAttribute('viewBox')).toMatch(/^0 0 380 \d+(\.\d+)?$/);
    expect(graph?.getAttribute('width')).toBeNull();
    expect(graph?.getAttribute('class')).toContain('w-full');
  });

  it('folds a 30-peer pool into "+7 more" and still lists all thirty', () => {
    const container = renderReach(Array.from({ length: 30 }, (_, index) => peer(`core-${index + 1}`)));

    expect(container.querySelectorAll('[data-testid="pool-reach-peer"]')).toHaveLength(23);
    expect(container.querySelector('[data-testid="pool-reach-overflow"]')?.textContent).toContain('+7 more');
    expect(container.querySelectorAll('[data-testid="pool-reach-list"] li')).toHaveLength(30);
  });
});
