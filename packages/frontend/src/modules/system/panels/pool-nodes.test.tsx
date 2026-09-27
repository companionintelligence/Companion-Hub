import { EMPTY_SAMPLE_WINDOW, type PoolNodeCard } from '@/modules/system/pool-node-series';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PoolNodes } from './pool-nodes';

/*
 * The node table, and the two things the collapse could plausibly break.
 *
 * ONE: nothing may become unreachable. The card is reused verbatim as the expanded row precisely
 * so that every column dropped below a breakpoint is still one click away, and a regression here
 * would silently delete information rather than fail loudly.
 *
 * TWO: the absence-vs-zero contract has to survive the move from card to cell. A peer that
 * reported no in-flight counter and no container rollup told us nothing; rendering either as 0
 * would state something the peer never sent, and the table's cells are the smallest, quietest
 * place on the page for that to go unnoticed.
 */

const READY = { pending: false, failed: false };

function card(overrides: Partial<PoolNodeCard> & { key: string; label: string }): PoolNodeCard {
  return {
    local: false,
    fqdn: `${overrides.key}.capybara-ulmer.ts.net`,
    direction: 'inbound',
    status: 'connected',
    hardwareTier: 'high',
    backends: [{ type: 'ollama', healthy: true, models: 3 }],
    models: 3,
    inFlight: 0,
    inFlightMeaning: 'forwarded-by-us',
    peerReportedInFlight: null,
    pressureBand: null,
    pressureSource: null,
    containers: null,
    lastSeenAt: null,
    consecutiveFailures: null,
    capabilitiesError: null,
    firstByte: null,
    decode: null,
    ...overrides,
  };
}

describe('PoolNodes', () => {
  it('collapses the card into a row and gives it back on click', async () => {
    const user = userEvent.setup();
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const toggle = screen.getByRole('button', { name: 'core-2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // "Models held" is a card readout and exists nowhere in the row.
    expect(screen.queryByText('Models held')).toBeNull();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Models held')).toBeTruthy();
    expect(screen.getByText('core-2.capybara-ulmer.ts.net')).toBeTruthy();

    await user.click(toggle);
    expect(screen.queryByText('Models held')).toBeNull();
  });

  it('opens from a click anywhere on the row, not only on the chevron', () => {
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const row = document.querySelector('tr[data-node="core-2"]') as HTMLElement;
    fireEvent.click(row);

    expect(screen.getByRole('button', { name: 'core-2' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens each node independently rather than as one accordion', async () => {
    const user = userEvent.setup();
    render(
      <PoolNodes
        cards={[card({ key: 'core-2', label: 'core-2' }), card({ key: 'core-7', label: 'core-7' })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'core-2' }));
    await user.click(screen.getByRole('button', { name: 'core-7' }));

    expect(screen.getByRole('button', { name: 'core-2' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'core-7' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders an unreported counter and an unreported rollup as absence, never as zero', () => {
    render(
      <PoolNodes
        cards={[card({ key: 'beta-red', label: 'beta-red', inFlight: null, containers: null })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    const row = document.querySelector('tr[data-node="beta-red"]') as HTMLElement;
    const cells = [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim());

    expect(cells).toContain('—');
    expect(cells).toContain('not reported');
    expect(cells).not.toContain('0');
    expect(cells).not.toContain('0/0');
  });

  it('still separates a failed pool fetch from an empty pool', () => {
    const failed = render(<PoolNodes cards={[]} window={EMPTY_SAMPLE_WINDOW} state={{ pending: false, failed: true }} />);
    expect(failed.container.querySelector('table')).toBeNull();
    expect(failed.container.textContent).not.toContain('No nodes to show');

    const empty = render(<PoolNodes cards={[]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);
    expect(empty.container.textContent).toContain('No nodes to show');
  });

  it('drops a header and its cells together, so the table can never shift by one column', () => {
    render(<PoolNodes cards={[card({ key: 'core-2', label: 'core-2' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const headers = [...document.querySelectorAll('thead th')];
    const cells = [...document.querySelectorAll('tbody tr[data-node] td')];
    expect(headers).toHaveLength(cells.length);

    /*
     * Token-wise, not a substring match on the whole class string: `cn` preserves author order, so
     * a cell written as "hidden text-muted-foreground sm:table-cell" and a header written as
     * "hidden sm:table-cell" describe the SAME breakpoint. What must agree is the pair of tokens,
     * not their spelling.
     */
    const breakpointOf = (element: Element) => {
      const classes = element.className.split(/\s+/);
      if (!classes.includes('hidden')) return 'always';

      return classes.find((name) => /^@?(xs|sm|md|lg|xl|2xl|3xl):table-cell$/.test(name)) ?? 'hidden-with-no-breakpoint';
    };

    expect(headers.map(breakpointOf)).toEqual(cells.map(breakpointOf));
  });
});

/*
 * The columns that answer "which node is slow", and the one that answered nothing.
 *
 * GPU pressure was null on all seventeen nodes of the 2026-09-27 fleet (no `/host/sys` mount
 * anywhere, and the band reads 0 under Vulkan), so its column was hollow pips on every row. It now
 * exists only when some node can fill it — and because the header and its cells are gated on the
 * same boolean, the table still cannot shift by a column either way.
 */
describe('PoolNodes speed columns', () => {
  const breakpointOf = (element: Element) => {
    const classes = element.className.split(/\s+/);
    if (!classes.includes('hidden')) return 'always';

    return classes.find((name) => /^@?(xs|sm|md|lg|xl|2xl|3xl):table-cell$/.test(name)) ?? 'hidden-with-no-breakpoint';
  };
  const headerTexts = () => [...document.querySelectorAll('thead th')].map((th) => (th.textContent ?? '').trim());

  it('drops the GPU pressure column, header and cells together, when no node measures it', () => {
    render(
      <PoolNodes
        cards={[card({ key: 'core-2', label: 'core-2' }), card({ key: 'core-7', label: 'core-7' })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    expect(headerTexts()).not.toContain('GPU pressure');
    const headers = [...document.querySelectorAll('thead th')];
    const cells = [...document.querySelectorAll('tbody tr[data-node="core-2"] td')];
    expect(headers).toHaveLength(cells.length);
    expect(headers.map(breakpointOf)).toEqual(cells.map(breakpointOf));
  });

  it('keeps the column, aligned, as soon as one node reports a band — band 0 included', () => {
    render(
      <PoolNodes
        cards={[card({ key: 'core-2', label: 'core-2', pressureBand: 0 }), card({ key: 'core-7', label: 'core-7' })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    expect(headerTexts()).toContain('GPU pressure');
    const headers = [...document.querySelectorAll('thead th')];
    const cells = [...document.querySelectorAll('tbody tr[data-node="core-7"] td')];
    expect(headers.map(breakpointOf)).toEqual(cells.map(breakpointOf));
  });

  it('shows the slowest first byte and the generation rate per node, and a dash where there is no evidence', () => {
    render(
      <PoolNodes
        cards={[
          card({
            key: 'core-6',
            label: 'core-6',
            firstByte: { count: 3, p50Ms: 12_500, maxMs: 91_716, maxEstTokens: 38_693 },
            decode: { tokensPerSec: 11.2, model: 'qwen3.6:27b', ageMs: 240_000 },
          }),
          card({ key: 'core-7', label: 'core-7' }),
        ]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    const slow = [...(document.querySelector('tr[data-node="core-6"]')?.querySelectorAll('td') ?? [])].map((cell) => (cell.textContent ?? '').trim());
    expect(slow).toContain('1m 32s');
    expect(slow).toContain('11 tok/s');

    const idle = [...(document.querySelector('tr[data-node="core-7"]')?.querySelectorAll('td') ?? [])].map((cell) => (cell.textContent ?? '').trim());
    expect(idle.filter((text) => text === '—').length).toBeGreaterThanOrEqual(2);
    expect(idle).not.toContain('0 ms');
  });

  /*
   * Measured in the app shell (fixed header, `dashboard-column` gutter, 17px root), not on a bare
   * page: this panel's container is 481 px at a 1280 window and 515 px at 1440, and only ~590 px at
   * 1536. `@lg` is 32rem = 544 px there, so "1st byte" on `@lg` and "Gen" on `@2xl` (714 px) were never
   * on screen on a laptop — the two per-node speed figures an agent turn is placed by. They take `@md`
   * (476 px); tier and the container count, which the expanded card already carries, give way to them.
   */
  it('shows the speed columns at the width the panel actually gets on a laptop, ahead of tier and containers', () => {
    render(<PoolNodes cards={[card({ key: 'core-6', label: 'core-6' })]} window={EMPTY_SAMPLE_WINDOW} state={READY} />);

    const at = Object.fromEntries([...document.querySelectorAll('thead th')].map((th) => [(th.textContent ?? '').trim(), breakpointOf(th)]));
    expect(at).toMatchObject({ '1st byte': '@md:table-cell', Gen: '@md:table-cell', Tier: '@lg:table-cell', Ctr: '@lg:table-cell' });
  });

  it('spells out the median, the worst case and what was excluded on the expanded card', async () => {
    const user = userEvent.setup();
    render(
      <PoolNodes
        cards={[card({ key: 'core-6', label: 'core-6', firstByte: { count: 3, p50Ms: 12_500, maxMs: 91_716, maxEstTokens: 38_693 } })]}
        window={EMPTY_SAMPLE_WINDOW}
        state={READY}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'core-6' }));

    expect(screen.getByText('p50 12.5 s · max 1m 32s')).toBeTruthy();
    expect(screen.getByText('3 served, 30 min, failovers excluded')).toBeTruthy();
    // No decode evidence: said in words, never a rate of zero.
    expect(screen.getByText('not measured in the last 2 h')).toBeTruthy();
  });
});
